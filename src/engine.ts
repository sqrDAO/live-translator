/**
 * The engine facade: browser audio in, merged bilingual utterances out.
 *
 * Joins the halves that exist separately:
 *
 *   `src/audio`        capture → 16 kHz PCM16 → 100 ms chunks
 *   `src/session`      two Gemini Live sessions, one per target, same audio
 *   `src/transcript`   merge by utterance, coordinate turns, throttle, coalesce
 *
 * and hands each utterance to the host's `CaptionSink`. The engine decides
 * when to write; the sink decides where and whether. Lease identity, write
 * sequences, expiry, document paths, rolling trim and retention are all the
 * host's — none of them appear here.
 *
 * PROTOCOL CAVEAT (ADR-001): the Live API message shape and the model name
 * are verified per deployment, never assumed from the pinned version.
 */

import { AudioCapture, type CaptureDiagnostics } from './audio/capture'
import { CHUNK_MS, VAD_DEFAULTS } from './audio/pcm'
import { TURN_SILENCE_MS } from './gemini/config'
import type { ParsedLiveMessage } from './gemini/frames'
import { assertLanguagePair, type LangTag, type LanguagePack } from './lang/types'
import { LiveSessionManager, type SocketCloseInfo } from './session/live-session'
import {
  type CaptionSink,
  type FeedDeathReason,
  type FeedStatus,
  type MintToken,
  type PublishableUtterance,
  type TokenGrant,
} from './sink'
import { TargetTurnCoordinator, type TurnPublication } from './transcript/coordinator'
import { LatencyTracker, type LatencySnapshot } from './transcript/latency'
import type { MergedUtterance } from './transcript/merge'
import { PublicationOutbox } from './transcript/outbox'
import { WriteThrottle } from './transcript/throttle'

/** Feed state is written at most once every 500 ms. */
export const STATE_WRITE_INTERVAL_MS = 500
/**
 * Floor between *partial* writes.
 *
 * Deliberately not `STATE_WRITE_INTERVAL_MS`. The 500 ms floor was written
 * against the feed-state document; the partial throttle sharing that
 * constant was an implementation choice, and it charged first-visible-text up
 * to 500 ms against a sub-second latency target for no reason the requirement
 * asked for. A partial's record is short-lived by construction — it is
 * replaced by the next partial and then by the final — so 4 writes/s on it
 * stays inside a document store's ~1 write/s/doc *sustained* guidance
 * (caption-fixed-delays).
 */
export const PARTIAL_SEGMENT_INTERVAL_MS = 250
/** A surface reading the feed state marks it stale without a heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 4_000
export const IDLE_FINALIZE_MS = 1_500
/**
 * How often idle turns are *checked*, which is not how long they must be idle.
 *
 * `IDLE_FINALIZE_MS` is the retirement threshold and is unchanged. Polling at
 * that same period made the granularity as large as the threshold: a fragment
 * landing just after a tick waited a full extra period, so a turn idle for
 * 1.5 s could take 3.0 s to finalize. Checking four times as often bounds the
 * overshoot to 250 ms without moving the boundary itself.
 */
export const IDLE_POLL_INTERVAL_MS = 250

/**
 * An utterance's ceiling (caption-utterance-cap).
 *
 * `IDLE_FINALIZE_MS` above is the only turn boundary the protocol actually
 * gives us — the Live API emits no `turnComplete`, see `coordinator.ts` — so a
 * conversation that never leaves a 1.5 s gap runs on as one utterance. On a
 * live day a fast exchange reached 367 characters of the second language,
 * which cost 8 of a wall's 7 primary rows, and the display trimmed the head
 * off the line the room reads.
 *
 * Three sentences is the operational number, taken as the starting point. Ten
 * seconds is the backstop for a speaker who never finishes one. Both were
 * signed off at rehearsal against a 52-characters-per-row wall, so about 260
 * characters is what had to fit; a host with a different surface may need to
 * revisit them — in their own commit, with their own evidence.
 */
export const MAX_UTTERANCE_SENTENCES = 3
export const MAX_UTTERANCE_MS = 10_000

/**
 * A gap in chunk arrivals longer than this opens a new speech run.
 *
 * `capture.ts` replaces gated chunks with synthesized silence flagged
 * `hasVoice: false`, which `pushAudio` excludes from the run arithmetic, so
 * silence reaches it as absence — but the VAD streams its release hangover
 * (`VAD_DEFAULTS.releaseFrames × CHUNK_MS` of trailing quiet frames), so a
 * pause shorter than the hangover produces NO arrival gap at all, and a
 * longer one produces a gap of roughly (real silence − hangover). Setting
 * this threshold to `TURN_SILENCE_MS` itself therefore demanded ~
 * (TURN_SILENCE_MS + hangover) of real silence before a run opened, while
 * Gemini ended its turn at `TURN_SILENCE_MS` — every utterance after a pause
 * inside that band joined the previous run and was silently dropped from the
 * `captureToFirstText` figures. Deriving the threshold as the difference
 * pairs a run boundary with the same real-silence duration Gemini's own turn
 * boundary needs.
 *
 * The derivation assumes the envelope test's invariant (hangover strictly
 * under `TURN_SILENCE_MS`) — if that ever failed, this constant would go
 * non-positive and the subtraction below is where to look. It also leaves
 * the threshold at only a couple of chunk cadences, so a scheduling stall
 * longer than that reads as a run boundary.
 */
export const SPEECH_RUN_GAP_MS = TURN_SILENCE_MS - VAD_DEFAULTS.releaseFrames * CHUNK_MS

/**
 * Bounds the `retracted` set. Coordinator utterance ids are monotonic and
 * never recur, so an entry is only useful while a write for its utterance can
 * still be queued or in flight — long gone after 128 later retractions. The
 * entries are consumed when a skipped or unwound write uses them; the cap
 * covers the common case where a noise turn retires with nothing queued at
 * all, which previously grew the set for the engine's whole lifetime.
 */
const MAX_RETRACTED_UTTERANCES = 128

/**
 * What the operator reads, and what a rehearsal reports.
 *
 * Two figures rather than one total, because they fail for different reasons
 * and only one of them is ours: `captureToFirstText` is network and model, per
 * target language so a slow socket in one direction is distinguishable from
 * the other; `textToPublished` is coordination, throttling and the sink's
 * write, and is one figure per published segment because a segment is merged
 * from both sessions and so has no single target.
 *
 * Neither covers the hop from the sink's store to whatever renders it. That
 * spans two machines and would be dominated by clock skew rather than by the
 * network, so it is deliberately not measured here; a report must state the
 * boundary rather than present these as end-to-end.
 */
export interface LatencyReport {
  captureToFirstText: Record<LangTag, LatencySnapshot | null>
  textToPublished: LatencySnapshot | null
}

export interface MicrophoneOptions {
  /** Preferred device; otherwise the remembered one, otherwise the default. */
  deviceId?: string
  /** `localStorage` key for the remembered device; see `CaptureOptions.storageKey`. */
  storageKey?: string
  onDiagnostics?: (diagnostics: CaptureDiagnostics) => void
}

export interface EngineStartOptions<G extends TokenGrant = TokenGrant> {
  /**
   * Grants already minted by the host, per target. Any target without one is
   * minted through `mintToken` at start. Hosts whose mint has side effects
   * that must precede the connect (taking a lease) mint first and pass them.
   */
  grants?: Partial<Record<LangTag, G>>
  /**
   * Microphone capture. Defaults to on in a browser and off elsewhere; `false`
   * leaves audio to the host, which then feeds `pushAudio()` itself.
   */
  microphone?: MicrophoneOptions | false
}

export interface EngineOptions<G extends TokenGrant = TokenGrant> {
  /** Pair, names and detector. The bundled EN/VI pack is `@sqrdao/live-translate/lang/en-vi`. */
  languages: LanguagePack
  sink: CaptionSink<G>
  mintToken: MintToken<G>
  /** Defaults to the real `WebSocket` constructor; the test suite replaces it. */
  createSocket?: (url: string) => WebSocket
  /**
   * Operator-declared speaker language (caption-direction-control): merged
   * utterances carry it as `sourceLang` unconditionally, instead of inferring
   * from session behavior or text. Fixed for the engine's lifetime — a host
   * restarts the engine to change direction, because the session prompts are
   * pinned into the tokens and need a fresh mint anyway.
   */
  forcedSourceLang?: LangTag
  onStatus?: (status: FeedStatus) => void
  onError: (error: Error) => void
  /** Every utterance the sink accepted, after it landed. A local observer, not a second sink. */
  onUtterance?: (utterance: PublishableUtterance, final: boolean) => void
  /**
   * Called whenever a figure changes, so a diagnostics panel needs no
   * polling. Operator-facing only; never put it on a participant surface.
   */
  onLatency?: (report: LatencyReport) => void
  /**
   * Fires at most once per `start()`, when the feed is dead and every
   * reconnect path is spent or refused. The host decides whether recovery is
   * a human's or an automatic restart's job — and 'moved' must never restart.
   */
  onDead?: (reason: FeedDeathReason) => void
  /** Every server- or network-initiated close, with the wire code/reason. */
  onSocketClose?: (info: SocketCloseInfo) => void
}

export class LiveTranslateEngine<G extends TokenGrant = TokenGrant> {
  private readonly pair: LanguagePack['pair']
  private readonly coordinator: TargetTurnCoordinator
  private readonly sessions: LiveSessionManager<G>
  private readonly throttle = new WriteThrottle({ minIntervalMs: PARTIAL_SEGMENT_INTERVAL_MS })
  private readonly outbox: PublicationOutbox<MergedUtterance>
  /** Utterances the sink accepted, and whether their final has landed. */
  private readonly published = new Map<string, { final: boolean }>()
  private capture: AudioCapture | null = null

  /** One tracker per target for capture→text, one for text→published. */
  private readonly captureToFirstText = new Map<LangTag, LatencyTracker>()
  private readonly textToPublished = new LatencyTracker()
  private lastChunkAt = 0
  /**
   * Targets that have not yet produced text, each holding *the onset it was
   * armed with*. A target is armed at onset and disarmed by its own first
   * fragment, so exactly one sample per run per target is recorded and a run
   * with no speech in it contributes nothing.
   *
   * The onset is stored here rather than read from a single current-run field
   * when the fragment lands. Reading it late let a new run steal the sample:
   * speech at 0–2000, a pause, speech resuming at 2500, and the first phrase's
   * text arriving at 2700 recorded 200 ms instead of 2700 ms — understating
   * exactly the slow cases a rehearsal exists to find, and hiding them from
   * `worst`, which is reported as a fact about the session.
   */
  private readonly awaitingFirstText = new Map<LangTag, number>()

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private partialTimer: ReturnType<typeof setTimeout> | null = null
  private status: FeedStatus = 'idle'
  /**
   * A write the sink refused or that threw — a store concern, not a socket
   * one, which is why it is held apart from `deriveStatus()` rather than
   * folded into it. It must be *cleared* by the next write that lands: set
   * directly on the status it pinned the feed to `degraded` for the rest of
   * the session, because nothing re-derived after a socket-quiet recovery,
   * and the 4 s heartbeat then republished `degraded` while every write was
   * landing.
   */
  private writeFailing = false
  private stopped = true
  /** The newest partial replaces older partials while the slot is closed. */
  private pendingPartial: MergedUtterance | null = null
  /**
   * Utterances whose turn retired unpublishable. A partial for one of these is
   * stale (possibly mislabeled) and no final will ever correct it, so the
   * sink is asked to take it down and any write still queued in the outbox is
   * dropped on arrival.
   */
  private readonly retracted = new Set<string>()

  constructor(private readonly options: EngineOptions<G>) {
    assertLanguagePair(options.languages.pair)
    this.pair = options.languages.pair
    for (const target of this.pair) this.captureToFirstText.set(target, new LatencyTracker())
    this.coordinator = new TargetTurnCoordinator(IDLE_FINALIZE_MS, {
      pair: this.pair,
      detect: options.languages.detect,
      ...(options.forcedSourceLang ? { forcedSourceLang: options.forcedSourceLang } : {}),
      maxUtteranceSentences: MAX_UTTERANCE_SENTENCES,
      maxUtteranceMs: MAX_UTTERANCE_MS,
    })
    this.outbox = new PublicationOutbox({
      minStateIntervalMs: STATE_WRITE_INTERVAL_MS,
      writeSegment: (utteranceId, merged, final) => this.writeSegmentNow(utteranceId, merged, final),
      writeState: () => this.writeStateNow(),
    })
    this.sessions = new LiveSessionManager<G>({
      pair: this.pair,
      mintToken: options.mintToken,
      ...(options.createSocket ? { createSocket: options.createSocket } : {}),
      authorityValid: () => options.sink.authorityValid(),
      adoptRenewal: (grant) => options.sink.adoptRenewal(grant),
      onMessage: (target, message, receivedAt) => this.handleMessage(target, message, receivedAt),
      onReconnected: () => {
        this.refreshStatus()
        void this.outbox.requestState()
      },
      onSocketError: () => this.refreshStatus(),
      onSocketClose: (info) => {
        options.onSocketClose?.(info)
        const status = this.deriveStatus()
        this.refreshStatus()
        // Both sockets usually close in the same tick. The first write is
        // `degraded` and the second is the truth — so the second must not queue
        // behind the state interval, or the surface spends that interval
        // reporting a half-working feed that is actually dead.
        void this.outbox.requestState({ immediate: status === 'unavailable' })
      },
      onDead: (reason) => {
        if (reason === 'moved') void this.terminateFeed()
        else options.onDead?.(reason)
      },
      onFailure: (error) => options.onError(error),
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * MUST be called synchronously inside the user's tap handler, before any
   * `await` — including the one in `start()`. iOS Safari only unlocks an
   * AudioContext during a user gesture; awaiting anything first yields a
   * permanently suspended context that produces silence with no error.
   */
  unlockAudioSync(): void {
    this.capture ??= new AudioCapture()
    this.capture.unlockSync()
  }

  async start(startOptions: EngineStartOptions<G> = {}): Promise<void> {
    // A host that starts twice without an intervening stop — a double-tapped
    // Begin, the same race `AudioCapture` hardens against — otherwise orphaned
    // the previous pair of intervals: nothing held their handles any more, so
    // they ran for the life of the page, doubling the status heartbeat and
    // running the idle poll twice per tick forever.
    this.clearTimers()
    this.stopped = false
    // A new session does not inherit the last one's store trouble.
    this.writeFailing = false
    this.setStatus('connecting')

    // The sink's preparation runs alongside the socket opens, not before
    // them: it only has to land before the first state write, which cannot
    // happen until start() resolves.
    try {
      await Promise.all([
        this.options.sink.prepare().catch((cause) => this.options.onError(asError(cause))),
        this.sessions.start(startOptions.grants ?? {}),
      ])
    } catch (cause) {
      await this.stop()
      throw cause
    }

    if (this.stopped) return
    // `live` when both opened; a direction that failed to open during start is
    // already `degraded`, exactly as it would be after a later drop.
    this.refreshStatus()
    // Announce immediately: without this a surface keeps the previous
    // session's last state until the first heartbeat (~4 s) or the first
    // published segment (caption-start-clears-the-wall).
    void this.outbox.requestState({ immediate: true })

    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS)
    this.idleTimer = setInterval(() => {
      this.publishCoordinatorEvents(this.coordinator.finalizeIdle(Date.now()))
    }, IDLE_POLL_INTERVAL_MS)

    const microphone =
      startOptions.microphone ?? (typeof window !== 'undefined' ? {} : false)
    if (microphone !== false) await this.startMicrophone(microphone)
  }

  private async startMicrophone(microphone: MicrophoneOptions): Promise<void> {
    this.capture ??= new AudioCapture()
    await this.capture.start({
      ...(microphone.deviceId ? { deviceId: microphone.deviceId } : {}),
      ...(microphone.storageKey ? { storageKey: microphone.storageKey } : {}),
      ...(microphone.onDiagnostics ? { onDiagnostics: microphone.onDiagnostics } : {}),
      onChunk: (base64, hasVoice) => this.pushAudio(base64, hasVoice),
      onError: (error) => this.options.onError(error),
    })
  }

  /**
   * Feeds one 100 ms base64 PCM16 chunk to both sessions.
   *
   * Gated silence chunks (`hasVoice: false`) are sent too — the model only
   * flushes transcript text while audio arrives and needs to *hear* its
   * ~800 ms end-of-turn silence — but they open no speech run: the run
   * arithmetic tracks voiced cadence, and a continuous stream would otherwise
   * never show a gap again.
   */
  pushAudio(base64Pcm16: string, hasVoice = true): void {
    if (this.stopped) return
    if (hasVoice) this.noteChunkArrival(Date.now())
    this.sessions.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: base64Pcm16 }],
        },
      }),
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.capture?.stop().catch(() => undefined)
    this.sessions.stop()
    this.clearTimers()
    this.clearPendingPartial()
    this.outbox.discardSegments()
    // The transcript state goes too. Left loaded, the next session's first
    // idle poll retired the turns still open here and published them as its
    // own opening captions; `published`/`retracted` likewise carried ids the
    // next run could retract out from under a host that had already purged.
    this.coordinator.reset()
    this.published.clear()
    this.retracted.clear()

    // The feed says it ended rather than freezing on its last line. Terminal,
    // so it bypasses the interval too — `stop()` awaits this, and waiting out
    // a rate limit to announce that there is nothing left to rate limit only
    // delays the host's own teardown.
    this.setStatus('closed')
    await this.outbox.requestState({ immediate: true })
  }

  get currentStatus(): FeedStatus {
    return this.status
  }

  get captureDiagnostics(): CaptureDiagnostics | null {
    return this.capture?.currentDiagnostics ?? null
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.heartbeatTimer = null
    this.idleTimer = null
  }

  /** The one status derivation: live needs both directions, one is degraded. */
  private deriveStatus(): FeedStatus {
    const open = this.sessions.openCount
    return open === this.pair.length ? 'live' : open > 0 ? 'degraded' : 'unavailable'
  }

  /**
   * The derivation, plus the store's verdict. A failing write degrades a feed
   * whose sockets are both up; it can never improve on an outage the socket
   * derivation already reports, so it only ever pulls `live` down.
   */
  private refreshStatus(): void {
    const derived = this.deriveStatus()
    this.setStatus(this.writeFailing && derived === 'live' ? 'degraded' : derived)
  }

  /**
   * The terminal outage: the room is no longer this engine's to publish
   * into. Everything stop() tears down is torn down here too — a version that
   * ended only the sockets kept the heartbeat writing under a stale authority
   * the store refused, firing an error banner every 4 s for the rest of the
   * session.
   */
  private async terminateFeed(): Promise<void> {
    this.stopped = true
    // 'moved' is the one death an automatic restart must never answer: the
    // room is legitimately someone else's now.
    this.options.onDead?.('moved')
    await this.capture?.stop().catch(() => undefined)
    this.clearTimers()
    this.clearPendingPartial()
    this.outbox.discardSegments()
    this.setStatus('unavailable')
    // Best effort only: this write carries the old authority, and if the room
    // has truly moved on the store refuses it. The host learns the outage from
    // `onStatus`/`onDead` either way; a surface from its staleness window.
    await this.outbox.requestState({ immediate: true }).catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // Latency
  // -------------------------------------------------------------------------

  /**
   * Opens a new speech run when chunks resume after a gap.
   *
   * Public because the unit suite cannot reach it through `pushAudio`, which
   * needs an open socket to be worth calling. Taking `now` rather than reading
   * the clock keeps the run arithmetic assertable without sleeping, the same
   * seam `WriteThrottle` uses.
   */
  noteChunkArrival(now: number): void {
    if (now - this.lastChunkAt > SPEECH_RUN_GAP_MS) {
      // Both targets are armed: either may be the slow one.
      //
      // An arm still pending from an earlier run is kept, never overwritten.
      // The text that eventually arrives is the first text since *that* onset
      // and belongs to it. The cost is that a run producing no text at all
      // makes the next run's text overstate against the older onset — the
      // accepted direction, and the safe one for a number reported to a
      // client. Overwriting instead understates, silently.
      for (const target of this.pair) {
        if (!this.awaitingFirstText.has(target)) this.awaitingFirstText.set(target, now)
      }
    }
    this.lastChunkAt = now
  }

  /** One sample per run per target; later fragments in the run are ignored. */
  private noteFirstText(target: LangTag, now: number): void {
    const onset = this.awaitingFirstText.get(target)
    if (onset === undefined) return
    this.awaitingFirstText.delete(target)
    this.captureToFirstText.get(target)?.record(now - onset)
    this.reportLatency()
  }

  /** One shape for a diagnostics panel and the unit suite alike. */
  get latency(): LatencyReport {
    const captureToFirstText: Record<LangTag, LatencySnapshot | null> = {}
    for (const [target, tracker] of this.captureToFirstText) {
      captureToFirstText[target] = tracker.snapshot
    }
    return { captureToFirstText, textToPublished: this.textToPublished.snapshot }
  }

  private reportLatency(): void {
    this.options.onLatency?.(this.latency)
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  private handleMessage(target: LangTag, parsed: ParsedLiveMessage, receivedAt: number): void {
    if (this.stopped) return
    // Text, not a bare `turnComplete`: the figure is time-to-first-*text*, and
    // a completion frame carrying none is not what the room is waiting for.
    // Every text frame reaches a surface now that idle retirement advances the
    // cursors instead of quarantining (fix-caption-idle-turn-boundary), so
    // every text frame is fair to measure.
    if (parsed.inputText || parsed.outputText) {
      this.noteFirstText(target, receivedAt)
    }
    this.publishCoordinatorEvents(this.coordinator.accept(target, parsed, Date.now()))
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * Holds the newest partial until a write slot opens. A previous publisher
   * discarded every fragment that arrived inside the interval; that made a
   * rapidly corrected transcript visibly lag behind the model.
   */
  private queuePartial(merged: MergedUtterance): void {
    if (this.stopped) return
    this.pendingPartial = merged
    if (this.throttle.tryAcquire()) {
      this.flushPendingPartial()
      return
    }
    this.schedulePartialFlush()
  }

  private schedulePartialFlush(): void {
    if (this.partialTimer) return
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null
      this.flushPartialWhenPermitted()
    }, this.throttle.msUntilNextSlot())
  }

  private flushPartialWhenPermitted(): void {
    if (this.stopped || !this.pendingPartial) return
    if (!this.throttle.tryAcquire()) {
      this.schedulePartialFlush()
      return
    }
    this.flushPendingPartial()
  }

  private flushPendingPartial(): void {
    const pending = this.pendingPartial
    this.pendingPartial = null
    if (!pending || this.stopped) return
    this.outbox.offerPartial(pending.utteranceId, pending)
  }

  private clearPendingPartial(utteranceId?: string): void {
    // `partialTimer` belongs to the same pending value. Do not cancel a newer
    // utterance's scheduled flush while finalizing an older one.
    if (utteranceId && this.pendingPartial?.utteranceId !== utteranceId) return

    this.pendingPartial = null
    if (this.partialTimer) clearTimeout(this.partialTimer)
    this.partialTimer = null
  }

  private publishCoordinatorEvents(events: TurnPublication[]): void {
    for (const event of events) {
      if (event.kind === 'retract') {
        this.clearPendingPartial(event.utteranceId)
        this.rememberRetracted(event.utteranceId)
        // Dropping the queued write here, not just on its arrival in
        // `writeSegmentNow`, means at most ONE write (the in-flight one) can
        // still consume the `retracted` entry — so consuming it is safe.
        this.outbox.discardSegment(event.utteranceId)
        void this.retractPublishedPartial(event.utteranceId)
        continue
      }
      if (event.kind === 'final') {
        // The coordinator has already retired this turn. Publication cannot
        // delay or alter the target cursors for later speech.
        this.clearPendingPartial(event.utteranceId)
        // A final bypasses the partial throttle: a completed turn is written
        // immediately so the last line on a surface is never a stale partial.
        this.throttle.acquireForFinal()
        this.outbox.offerFinal(event.utteranceId, event.merged)
      } else {
        this.queuePartial(event.merged)
      }
    }
  }

  /** Marks an utterance retracted, evicting the oldest entry past the cap. */
  private rememberRetracted(utteranceId: string): void {
    this.retracted.add(utteranceId)
    if (this.retracted.size > MAX_RETRACTED_UTTERANCES) {
      const oldest = this.retracted.values().next().value
      if (oldest !== undefined) this.retracted.delete(oldest)
    }
  }

  /**
   * Takes a stale partial off the surface. A sink that refuses leaves the
   * partial to whatever expiry the host gives it, exactly as before retraction
   * existed.
   */
  private async retractPublishedPartial(utteranceId: string): Promise<void> {
    const published = this.published.get(utteranceId)
    if (!published || published.final) return
    this.published.delete(utteranceId)
    try {
      await this.options.sink.retract(utteranceId)
    } catch {
      // Refused retraction: the partial expires on its own.
    }
  }

  private async writeSegmentNow(
    utteranceId: string,
    // `updatedAt` as well as `startedAt`: the utterance's own `startedAt` is
    // the utterance's, while the latency sample is anchored on the fragment
    // that triggered this write.
    merged: Pick<MergedUtterance, 'sourceLang' | 'original' | 'translated' | 'startedAt' | 'updatedAt'>,
    final: boolean,
  ): Promise<void> {
    if (this.stopped) return
    // A write the outbox queued before the retraction landed would put the
    // stale partial straight back after its retraction. Consumed on use: the
    // id never recurs, so the entry has done its job.
    if (this.retracted.has(utteranceId)) {
      this.retracted.delete(utteranceId)
      return
    }

    // Exactly this field set. No microphone device id and no operator
    // identifier may appear here: the sink receives spoken content and
    // nothing that identifies who captured it.
    const utterance: PublishableUtterance = {
      utteranceId,
      sourceLang: merged.sourceLang,
      original: merged.original,
      translated: merged.translated,
      startedAt: merged.startedAt,
      updatedAt: merged.updatedAt,
    }

    try {
      const landed = await this.options.sink.publish(utterance, final)
      // A retract that landed during the write's round trip found nothing in
      // `published` to take down — the map is only populated below — so the
      // check above the write is not enough: the stale partial would commit
      // and stand until expiry. Re-check, ask the sink to unwind the write it
      // just made, and never record it as published.
      if (this.retracted.has(utteranceId)) {
        this.retracted.delete(utteranceId)
        await this.options.sink.retract(utteranceId).catch(() => undefined)
        return
      }
      if (!landed) {
        // A refused write usually means the authority moved on. Degrade rather
        // than retry; the host already knows why it refused. Recorded as a
        // flag, not a fixed status: if it really has moved on the next writes
        // are refused too and the feed stays degraded, and if it was transient
        // the first write that lands clears it.
        this.noteWriteFailed()
        return
      }
      this.noteWriteLanded()
      this.published.set(utteranceId, { final })
      // After the write resolves, so the figure includes the round trip this
      // browser paid for — the half of the budget a direct client write
      // exists to keep small.
      //
      // Anchored on `updatedAt`, the newest fragment in the merge — the one
      // that triggered *this* write. `startedAt` is the utterance's first
      // fragment, so anchoring there measured how long someone talked: a
      // 15-second monologue produced a ~16 s sample, and every partial
      // re-measured against the same fixed anchor, so an utterance published as
      // 8 partials and a final contributed 9 rising samples. The p50 tracked
      // utterance length and partial count, not the write this row indicts.
      this.textToPublished.record(Date.now() - merged.updatedAt)
      this.reportLatency()
      this.options.onUtterance?.(utterance, final)
      void this.outbox.requestState()
    } catch (cause) {
      this.noteWriteFailed()
      this.options.onError(asError(cause))
    }
  }

  private noteWriteFailed(): void {
    this.writeFailing = true
    this.refreshStatus()
  }

  /** Clears the store's verdict — and only then re-derives, so a landing write
   * cannot churn `onStatus` on every segment of a healthy feed. */
  private noteWriteLanded(): void {
    if (!this.writeFailing) return
    this.writeFailing = false
    this.refreshStatus()
  }

  /**
   * One heartbeat write. Public so the interval above is the only scheduler
   * and the behavior itself can be asserted without one.
   */
  async heartbeat(): Promise<void> {
    await this.outbox.requestState()
  }

  private async writeStateNow(): Promise<void> {
    try {
      await this.options.sink.publishStatus(this.status)
    } catch (cause) {
      this.options.onError(asError(cause))
    }
  }

  private setStatus(status: FeedStatus): void {
    if (this.status === status) return
    this.status = status
    this.options.onStatus?.(status)
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
