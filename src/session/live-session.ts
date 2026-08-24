/**
 * Live session transport.
 *
 * Owns everything about the two Gemini Live sockets and nothing about what
 * their frames mean: the constrained endpoint, the `createSocket` seam, token
 * minting, the setup frame, resumption handles, `goAway`, per-target backoff,
 * ordered Blob decoding and close reporting. The engine consumes parsed text
 * frames and target status; it never touches a socket.
 *
 * PROTOCOL CAVEAT (ADR-001): the message shape and the model name are
 * verified per deployment, never assumed from the pinned version. The protocol
 * has moved twice in this code's short life — `v1alpha/authTokens` was
 * removed, and the token constraint field was renamed — and if a fact in the
 * README disagrees with what the API does when probed, the API wins.
 */

import type { LangTag, LanguagePair } from '../lang/types'
import { assertLanguagePair } from '../lang/types'
import { parseLiveMessage, type ParsedLiveMessage } from '../gemini/frames'
import {
  isPublicationMoved,
  type FeedDeathReason,
  type MintToken,
  type TokenGrant,
} from '../sink'

/**
 * `BidiGenerateContentConstrained`, not `BidiGenerateContent`: ephemeral
 * tokens have their own WebSocket method, and presenting one to the plain
 * method closes the socket with 1008 "Method doesn't allow unregistered
 * callers" (probed 2026-08-10, fix-caption-live-socket-auth; the current
 * js-genai SDK switches methods the same way).
 */
export const LIVE_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'

/**
 * Reconnect backoff (caption-publisher-reconnect): 1 s doubling to 16 s,
 * five attempts per target, ~31 s of trying before the feed is left in the
 * state it last reported rather than looping against a dead endpoint. How long
 * a Live session actually survives was measured afterwards (~10 minutes per
 * connection, announced by `goAway`), and the constants are sized to be safe
 * for a rare recovery path and a routine every-N-minutes event alike.
 */
export const RECONNECT_BASE_DELAY_MS = 1_000
export const RECONNECT_MAX_ATTEMPTS = 5

export interface SocketCloseInfo {
  target: LangTag
  code?: number
  reason?: string
}

export interface LiveSessionManagerOptions<G extends TokenGrant = TokenGrant> {
  pair: LanguagePair
  /** Re-minted on every reconnect (`uses: 1`), and at start for any target without a grant. */
  mintToken: MintToken<G>
  /**
   * Defaults to the real `WebSocket` constructor. Injectable so a test can
   * exercise the live-to-disconnected transition against a stub socket
   * instead of a real Gemini Live session, which needs external credentials
   * and network access no test environment has.
   */
  createSocket?: (url: string) => WebSocket
  /** May this feed still reconnect? A lapsed authority ends reconnection. */
  authorityValid: () => boolean
  /** After a re-mint: the same authority (`'renewed'`), or the room moved on (`'moved'`). */
  adoptRenewal: (grant: G) => 'renewed' | 'moved'
  /**
   * A text or completion frame. `receivedAt` was stamped at the socket
   * boundary, before the Blob decode and the lane wait.
   */
  onMessage: (target: LangTag, message: ParsedLiveMessage, receivedAt: number) => void
  /** A reconnect succeeded in opening a socket for `target`. */
  onReconnected: (target: LangTag) => void
  /** A socket error. One failed direction is a degraded feed, not a dead one. */
  onSocketError: (target: LangTag) => void
  /**
   * Every close the *server* or network initiated, with the wire code/reason
   * when the browser supplies one — the evidence trail for outages that
   * otherwise end as anecdotes ("restarted the browser and it came back").
   * Deliberate teardowns (stop, a reconnect replacing its predecessor) are
   * detached first and never report.
   */
  onSocketClose: (info: SocketCloseInfo) => void
  /**
   * Fires at most once per `start()`, when the feed is dead and every
   * reconnect path is spent or refused. For `'moved'` the manager has already
   * torn its sockets down; the engine tears down the rest.
   */
  onDead: (reason: FeedDeathReason) => void
  /** A transient failure worth surfacing: a mint that threw, a frame that could not be handled. */
  onFailure: (error: Error) => void
}

interface LiveSession {
  socket: WebSocket
  target: LangTag
  open: boolean
}

interface ReconnectState {
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
}

export class LiveSessionManager<G extends TokenGrant = TokenGrant> {
  private readonly pair: LanguagePair
  private readonly sessions: LiveSession[] = []
  private readonly messageLanes = new Map<LangTag, Promise<void>>()
  /**
   * Per-target reconnect bookkeeping. `attempts` resets only on the first
   * *message* a reopened socket delivers — an `onopen` alone is not recovery,
   * because an endpoint can accept the handshake and close on the setup frame
   * (the PROTOCOL CAVEAT case), and resetting there turned the documented
   * 5-attempt bound into an unbounded ~1 Hz mint loop.
   */
  private readonly reconnects = new Map<LangTag, ReconnectState>()
  /** Set by `cancelReconnects()`; cleared by `start()`, so a restarted
   * manager reconnects again instead of inheriting a spent counter. */
  private reconnectsCancelled = false
  /**
   * Newest resumption handle per target (caption-session-resumption). A
   * reconnect presents it so the resumed session keeps the model's
   * conversational context. Instance state only, per target, never
   * persisted: a handle can no more cross feeds than the manager can.
   * Cleared by `start()` — a fresh publish is a fresh context.
   */
  private readonly resumptionHandles = new Map<LangTag, string | null>()
  /**
   * Targets whose reconnection has given up for good. The feed is dead when
   * both are here; `deadFired` latches `onDead` to once per `start()`.
   */
  private readonly deadTargets = new Set<LangTag>()
  private deadFired = false
  private stopped = true

  constructor(private readonly options: LiveSessionManagerOptions<G>) {
    assertLanguagePair(options.pair)
    this.pair = options.pair
    for (const target of this.pair) {
      this.messageLanes.set(target, Promise.resolve())
      this.reconnects.set(target, { attempts: 0, timer: null })
      this.resumptionHandles.set(target, null)
    }
  }

  /**
   * Opens one socket per target. A target without a supplied grant is minted
   * for first; a mint that throws here rejects `start()` — there is no feed
   * to degrade yet. Resolves once every socket has opened, errored or closed.
   */
  async start(grants: Partial<Record<LangTag, G>> = {}): Promise<void> {
    this.stopped = false
    this.reconnectsCancelled = false
    this.deadTargets.clear()
    this.deadFired = false
    for (const target of this.pair) {
      this.reconnects.get(target)!.attempts = 0
      this.resumptionHandles.set(target, null)
    }

    const minted = await Promise.all(
      this.pair.map(async (target) => {
        const grant = grants[target] ?? (await this.options.mintToken(target))
        return [target, grant] as const
      }),
    )
    if (this.stopped) return
    await Promise.all(minted.map(([target, grant]) => this.openSession(target, grant)))
  }

  /** Detaches every socket and cancels every pending reconnect. */
  stop(): void {
    this.stopped = true
    // A pending reconnect must not outlive the operator's stop: a released
    // authority means another publisher may hold the room.
    this.cancelReconnects()
    this.detachSessions()
  }

  /** Sends one frame to every open socket. */
  send(message: string): void {
    if (this.stopped) return
    for (const session of this.sessions) {
      if (session.open && session.socket.readyState === OPEN) {
        session.socket.send(message)
      }
    }
  }

  /** How many targets currently have an open socket. */
  get openCount(): number {
    return this.sessions.filter((s) => s.open).length
  }

  isOpen(target: LangTag): boolean {
    return this.sessions.some((s) => s.target === target && s.open)
  }

  /**
   * The one socket-teardown ritual (three divergent copies once invited the
   * next close-race bug). Detached means `onclose` is nulled, so a closing
   * predecessor can never schedule a reconnect for its target.
   */
  private detachSessions(target?: LangTag): void {
    for (const session of this.sessions) {
      if (target && session.target !== target) continue
      session.open = false
      session.socket.onclose = null
      try {
        session.socket.close()
      } catch {
        // Already closing.
      }
    }
    const keep = target ? this.sessions.filter((s) => s.target !== target) : []
    this.sessions.length = 0
    this.sessions.push(...keep)
  }

  private openSession(target: LangTag, grant: G): Promise<void> {
    return new Promise((resolve) => {
      const setup = grant.sessionConfig
      // At most one socket per target: a predecessor still in the list (a
      // reconnect racing a slow close) is detached first.
      this.detachSessions(target)

      const createSocket = this.options.createSocket ?? ((url: string) => new WebSocket(url))
      const socket = createSocket(`${LIVE_ENDPOINT}?access_token=${encodeURIComponent(grant.token)}`)
      const session: LiveSession = { socket, target, open: false }
      this.sessions.push(session)

      socket.onopen = () => {
        // The token already pins the model and config; the setup frame repeats
        // it because the protocol requires one before any audio. A stored
        // resumption handle (a reconnect, never a first connect) is layered on
        // at send time — it cannot exist at mint time, so it is the one field
        // the pinned config does not carry.
        const handle = this.resumptionHandles.get(target)
        socket.send(
          JSON.stringify({
            setup: handle ? { ...setup, sessionResumption: { handle } } : setup,
          }),
        )
        session.open = true
        // Deliberately NOT the end of the outage: `attempts` resets on the
        // first *message* (see `handleMessage`), because an endpoint can
        // accept the handshake and close on the setup frame, and treating
        // the open as recovery unbounded the reconnect loop.
        resolve()
      }

      socket.onmessage = (event) => {
        // Stamped here, not in `handleMessage`. In Chrome the socket delivers
        // Blobs, so `parseLiveMessage` awaits a `Blob.text()`, and the frame
        // then waits behind this lane — reading the clock after both charges
        // our own decode and queueing to "network and model", the figure the
        // latency panel is used to argue about Gemini with.
        const receivedAt = Date.now()
        // Blob decoding is asynchronous. Keep each socket's frames in order so
        // a later string frame cannot overtake an earlier Blob frame.
        const lane = this.messageLanes.get(target) ?? Promise.resolve()
        this.messageLanes.set(
          target,
          lane
            .then(() => this.handleMessage(target, event.data, receivedAt))
            .catch((cause) => this.options.onFailure(asError(cause))),
        )
      }

      socket.onerror = () => {
        session.open = false
        // One failed direction is a degraded feed, not a dead one: the other
        // language keeps publishing.
        this.options.onSocketError(target)
        resolve()
      }

      socket.onclose = (event?: CloseEvent) => {
        // A socket that closes without ever opening or erroring must still
        // settle the promise, or `start()`/`reattach` await forever — a gap
        // only constructible through the `createSocket` seam today, and a
        // one-line insurance against it (duplicate resolutions are no-ops).
        resolve()
        session.open = false
        if (this.stopped) return
        // Only closes that reach here are the server's or the network's:
        // deliberate teardowns null this handler first (`detachSessions`).
        this.options.onSocketClose({
          target,
          ...(typeof event?.code === 'number' ? { code: event.code } : {}),
          ...(event?.reason ? { reason: event.reason } : {}),
        })
        this.scheduleReconnect(target)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Reconnect — caption-publisher-reconnect
  // -------------------------------------------------------------------------

  /**
   * An announced rotation, NOT a failure (caption-session-survives-90-minutes).
   * `goAway` is routine — roughly every ten minutes per connection — so it
   * must not spend the reconnect budget: routed through `scheduleReconnect`
   * it incremented `attempts`, which resets only on a delivered *message*, so
   * a feed carrying no transcript frames (a break, or the model correctly
   * emitting nothing against the silence stream) walked the ladder to the
   * ceiling and declared itself dead after ~50 minutes with both sockets
   * healthy. It also backed the rotation off 1s→2s→4s→8s→16s, the opposite of
   * reconnecting "on our own clock".
   *
   * Reconnects immediately and leaves `attempts` alone: a rotation says
   * nothing about whether the endpoint is failing.
   */
  private rotateSession(target: LangTag): void {
    if (this.stopped || this.reconnectsCancelled) return
    const state = this.reconnects.get(target)!
    // A backed-off reconnect already in flight is recovering from a real
    // failure; it owns this target and its ladder.
    if (state.timer) return
    // The same authority check the failure path makes: a lapsed authority is
    // not ours to renew silently, however routine the rotation.
    if (!this.options.authorityValid()) {
      this.noteTargetDead(target, 'authority-lapsed')
      return
    }
    // The announced close is no longer a *failure* — but it is still a close,
    // and the derivation must see it. Nulling the handler outright hid it:
    // `session.open` stayed true through the mint (and through the whole
    // backoff ladder if the mint failed), so `openCount` reported both
    // directions up and the heartbeat published `live` for a feed with one
    // dead session. Replace the handler instead of removing it: mark the
    // socket down and report it, but never re-enter the failure path.
    for (const session of this.sessions) {
      if (session.target !== target) continue
      session.socket.onclose = (event?: CloseEvent) => {
        session.open = false
        if (this.stopped) return
        this.options.onSocketClose({
          target,
          ...(typeof event?.code === 'number' ? { code: event.code } : {}),
          ...(event?.reason ? { reason: event.reason } : {}),
        })
      }
    }
    void this.reattach(target)
  }

  private scheduleReconnect(target: LangTag): void {
    if (this.stopped || this.reconnectsCancelled) return
    const state = this.reconnects.get(target)!
    if (state.timer) return
    // Bounded: past the ceiling the feed stays in the state it last reported
    // rather than looping against a dead endpoint.
    if (state.attempts >= RECONNECT_MAX_ATTEMPTS) {
      this.noteTargetDead(target, 'exhausted')
      return
    }
    // A lapsed authority is not ours to renew silently — another publisher
    // may be about to take the room. Reconnection ends with the authority.
    // The sink answers this; it must fail CLOSED on anything it cannot parse,
    // where a hand-rolled `Date.parse(...) <= now` on NaN once read a
    // malformed lease as never-expiring.
    if (!this.options.authorityValid()) {
      this.noteTargetDead(target, 'authority-lapsed')
      return
    }

    const delay = RECONNECT_BASE_DELAY_MS * 2 ** state.attempts
    state.attempts += 1
    state.timer = setTimeout(() => {
      state.timer = null
      void this.reattach(target)
    }, delay)
  }

  /**
   * One target's reconnection has given up. The feed is dead when both have —
   * a single dead direction is the standing `degraded` state, still owned by
   * the surviving socket. Fired at most once per `start()`, with the reason
   * the *last* target died for.
   */
  private noteTargetDead(target: LangTag, reason: FeedDeathReason): void {
    this.deadTargets.add(target)
    if (this.deadTargets.size < this.pair.length || this.deadFired || this.stopped) return
    this.deadFired = true
    this.options.onDead(reason)
  }

  /**
   * The terminal outage: the room is no longer this feed's to publish into
   * (a force-release, a changed projection, or another publisher holding the
   * authority). The sockets end here and the engine tears down the rest on
   * `onDead('moved')` — the first version ended only the sockets, so the
   * heartbeat kept writing under a stale authority the store refused, firing
   * an error banner every 4 s for the rest of the session.
   */
  private terminate(): void {
    this.stopped = true
    this.cancelReconnects()
    this.detachSessions()
    // 'moved' is the one death an automatic restart must never answer: the
    // room is legitimately someone else's now.
    if (!this.deadFired) {
      this.deadFired = true
      this.options.onDead('moved')
    }
  }

  private async reattach(target: LangTag): Promise<void> {
    if (this.stopped) return
    try {
      // A fresh mint every time: ephemeral tokens are `uses: 1`, so the token
      // the dead socket was opened with cannot be presented again.
      const minted = await this.options.mintToken(target)
      if (this.stopped) return

      if (this.options.adoptRenewal(minted) === 'moved') {
        // The room moved on while we were away. Publishing over it is
        // exactly what the host's store would refuse; the host's
        // `adoptRenewal` has already released whatever the mint took.
        this.terminate()
        return
      }

      await this.openSession(target, minted)
      if (this.stopped) return
      if (this.isOpen(target)) this.options.onReconnected(target)
      // Not open: the new socket's own `onclose` has already scheduled the
      // next backed-off attempt.
    } catch (cause) {
      // Another publisher holding the room is not a transient fault: retrying
      // mints against their authority up to the ceiling, with an error banner
      // per attempt, while our surviving socket publishes writes the store
      // refuses. It is the same terminal state as the 'moved' branch.
      if (isPublicationMoved(cause)) {
        this.terminate()
        return
      }
      this.options.onFailure(asError(cause))
      this.scheduleReconnect(target)
    }
  }

  private cancelReconnects(): void {
    // An explicit flag rather than pinning `attempts` to the ceiling: the
    // counter keeps one meaning, and `start()` clears the flag so a stopped
    // manager can be restarted with its reconnects working.
    this.reconnectsCancelled = true
    for (const state of this.reconnects.values()) {
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
    }
  }

  private async handleMessage(target: LangTag, data: unknown, receivedAt: number): Promise<void> {
    const parsed = await parseLiveMessage(data)
    if (!parsed || this.stopped) return
    // Lifecycle frames are handled above the attempts reset: both can arrive
    // right after setup acceptance, and treating either as "the outage is
    // over" would re-open the unbounded-loop gap the reset guards against.
    if (parsed.resumptionHandle) {
      this.resumptionHandles.set(target, parsed.resumptionHandle)
      return
    }
    if (parsed.goAway) {
      // The server is about to close this connection (routine at ~10-minute
      // connection age). Reconnect on our own clock — the fresh session
      // presents the stored handle and continues the context — rather than
      // waiting out the close plus backoff with the feed degraded.
      this.rotateSession(target)
      return
    }
    // THIS is the end of an outage — a server message, not a handshake. An
    // endpoint that accepts the socket and closes on the setup frame never
    // gets here, so its reconnects stay bounded at the attempt ceiling.
    this.reconnects.get(target)!.attempts = 0
    this.options.onMessage(target, parsed, receivedAt)
  }
}

/** `WebSocket.OPEN`, without requiring the global to exist at module load. */
const OPEN = 1

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
