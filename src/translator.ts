import { MicCapture } from './audio/capture'
import { isSilentPcm } from './audio/pcm'
import { TranslateSession, type Lang, type SessionStatus } from './gemini/session'

export type Mode = 'conversation' | 'speech'

export interface Utterance {
  id: string
  /** language the speaker used */
  sourceLang: Lang
  original: string
  translated: string
  final: boolean
}

export interface TranslatorEvents {
  onUtterance(u: Utterance): void
  onStatus(status: SessionStatus, detail?: string): void
  onLevel(level: number): void
}

const other = (l: Lang): Lang => (l === 'en' ? 'vi' : 'en')

interface Track {
  session: TranslateSession
  status: SessionStatus
  inputBuf: string
  outputBuf: string
  utteranceId: string | null
  counter: number
  idleTimer: ReturnType<typeof setTimeout> | null
  events: number
}

export interface TranslatorStats {
  micDevice: string
  contextRate: number
  chunksSent: number
  trackEvents: Record<string, number>
  droppedFragments: number
}

/**
 * The Live Translate model streams continuously and does not reliably emit
 * turnComplete during an open mic stream, so utterances are finalized after a
 * quiet gap instead.
 */
const UTTERANCE_IDLE_MS = 2500

/**
 * The model occasionally transcribes noise-floor audio as short filler words
 * ("và", "uh"). Fragments that arrive while no utterance is in progress and
 * the mic hasn't been voiced recently are treated as hallucinations and
 * dropped. Voice detection is relative to the mic's own adaptive noise floor
 * (never a fixed threshold — that silences quiet microphones entirely).
 */
const VOICE_STALE_MS = 2000

/**
 * Runs one (speech mode) or two (conversation mode) Live Translate sessions
 * over a single mic stream and merges their transcripts into utterances.
 *
 * Conversation mode: session A targets `vi`, session B targets `en`, both with
 * echoTargetLanguage=false — whichever session hears non-target speech emits
 * the translation while the other stays silent.
 *
 * Output is text-only: the model's translated audio is discarded (used purely
 * as an "this session is translating" signal), so there is no playback and no
 * echo/feedback risk.
 */
export class Translator {
  private mic: MicCapture | null = null
  private tracks: Track[] = []
  private running = false
  /** Bumped on every start/stop so an in-flight start can detect it was superseded. */
  private generation = 0
  /** Adaptive mic noise floor (level units); starts high, snaps down fast. */
  private noiseFloor = 1
  private lastVoicedAt = 0
  private droppedFragments = 0

  constructor(private ev: TranslatorEvents) {}

  get isRunning(): boolean {
    return this.running
  }

  getStats(): TranslatorStats {
    return {
      micDevice: this.mic?.deviceLabel ?? '',
      contextRate: this.mic?.contextRate ?? 0,
      chunksSent: this.mic?.chunksSent ?? 0,
      trackEvents: Object.fromEntries(this.tracks.map((t) => [t.session.target, t.events])),
      droppedFragments: this.droppedFragments,
    }
  }

  /** Falls fast to the quietest recent level, rises slowly through speech. */
  private trackVoice(level: number): void {
    this.noiseFloor =
      level < this.noiseFloor ? level : this.noiseFloor + (level - this.noiseFloor) * 0.02
    if (level > Math.max(this.noiseFloor * 3, this.noiseFloor + 0.015)) {
      this.lastVoicedAt = Date.now()
    }
  }

  private recentlyVoiced(): boolean {
    return Date.now() - this.lastVoicedAt < VOICE_STALE_MS
  }

  async start(mode: Mode, speechTarget: Lang = 'vi', micDeviceId?: string): Promise<void> {
    if (this.running) return
    this.running = true
    const gen = ++this.generation
    // Re-learn the noise floor per run (the mic device may have changed).
    this.noiseFloor = 1
    this.lastVoicedAt = 0

    try {
      const targets: Lang[] = mode === 'conversation' ? ['vi', 'en'] : [speechTarget]
      this.tracks = targets.map((target) => this.makeTrack(target, targets.length === 1))
      await Promise.all(this.tracks.map((t) => t.session.connect()))
      if (gen !== this.generation) return // superseded by stop() mid-connect

      this.mic = new MicCapture({
        onChunk: (b64) => this.tracks.forEach((t) => t.session.sendAudio(b64)),
        onLevel: (level) => {
          this.trackVoice(level)
          this.ev.onLevel(level)
        },
      })
      await this.mic.start(micDeviceId)
      if (gen !== this.generation) await this.teardown()
    } catch (err) {
      if (gen === this.generation) await this.stop()
      throw err
    }
  }

  private makeTrack(target: Lang, showInputImmediately: boolean): Track {
    const track: Track = {
      status: 'idle',
      inputBuf: '',
      outputBuf: '',
      utteranceId: null,
      counter: 0,
      idleTimer: null,
      events: 0,
      session: null as unknown as TranslateSession,
    }

    const emit = (final: boolean) => {
      if (!track.utteranceId) return
      this.ev.onUtterance({
        id: track.utteranceId,
        sourceLang: other(target),
        original: track.inputBuf.trim(),
        translated: track.outputBuf.trim(),
        final,
      })
    }

    const finalize = () => {
      emit(true)
      track.inputBuf = ''
      track.outputBuf = ''
      track.utteranceId = null
      track.idleTimer = null
    }

    // Any activity extends the current utterance; a quiet gap closes it (and
    // clears stale buffers on the session that isn't translating this speaker).
    const touch = () => {
      track.events++
      if (track.idleTimer) clearTimeout(track.idleTimer)
      track.idleTimer = setTimeout(finalize, UTTERANCE_IDLE_MS)
    }

    const ensureUtterance = () => {
      if (!track.utteranceId) track.utteranceId = `${target}-${track.counter++}`
    }

    // A fragment mid-utterance is always real; one arriving with no utterance
    // open and no recent voice on the mic is a silence hallucination.
    const acceptFragment = (kind: string, text = ''): boolean => {
      if (track.utteranceId || this.recentlyVoiced()) return true
      this.droppedFragments++
      console.debug(`[lt] ${target} dropped silent-mic ${kind}: ${text}`)
      return false
    }

    track.session = new TranslateSession(target, {
      onAudio: (pcm) => {
        // Both sessions stream continuous PCM; the one whose target matches the
        // speaker sends (near-)silence. Audio is never played — non-silent
        // chunks just mark this session as the one translating the speaker.
        if (isSilentPcm(pcm)) return
        if (!acceptFragment('audio')) return
        ensureUtterance()
        touch()
      },
      onInputText: (text) => {
        console.debug(`[lt] ${target} input: ${text}`)
        if (!acceptFragment('input', text)) return
        track.inputBuf += text
        // In single-session (speech) mode, show the original text as soon as it
        // arrives. In conversation mode, wait for output audio so only the
        // session actually translating this speaker creates a bubble.
        if (showInputImmediately) ensureUtterance()
        emit(false)
        touch()
      },
      onOutputText: (text) => {
        console.debug(`[lt] ${target} output: ${text}`)
        if (!acceptFragment('output', text)) return
        track.outputBuf += text
        ensureUtterance()
        emit(false)
        touch()
      },
      onTurnComplete: finalize,
      onStatus: (status, detail) => {
        track.status = status
        this.reportStatus(detail)
      },
    })
    return track
  }

  private reportStatus(detail?: string): void {
    const statuses = this.tracks.map((t) => t.status)
    let overall: SessionStatus = 'idle'
    if (statuses.includes('error')) overall = 'error'
    else if (statuses.includes('connecting')) overall = 'connecting'
    else if (statuses.includes('closed')) overall = 'closed'
    else if (statuses.length && statuses.every((s) => s === 'open')) overall = 'open'
    this.ev.onStatus(overall, detail)
  }

  async stop(): Promise<void> {
    if (!this.running && !this.mic && !this.tracks.length) return
    this.generation++
    this.running = false
    await this.teardown()
  }

  private async teardown(): Promise<void> {
    await this.mic?.stop().catch(() => {})
    this.mic = null
    this.tracks.forEach((t) => {
      if (t.idleTimer) clearTimeout(t.idleTimer)
      t.session.close()
    })
    this.tracks = []
    this.ev.onLevel(0)
    this.ev.onStatus('idle')
  }
}
