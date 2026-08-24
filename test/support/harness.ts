/**
 * Test doubles shared across the suite. No network, no credentials, no
 * emulator: a stub socket behind the `createSocket` seam, a recording sink,
 * and helpers that build an engine driven entirely by the test.
 */

import { enVi } from '../../src/lang/en-vi'
import { LiveTranslateEngine, type EngineOptions } from '../../src/engine'
import type {
  CaptionSink,
  FeedStatus,
  MintToken,
  PublishableUtterance,
  TokenGrant,
} from '../../src/sink'

/**
 * A Live socket the test drives by hand. Stands in for a real Gemini session,
 * which needs credentials and network access no test environment has.
 */
export class StubSocket {
  static readonly OPEN = 1
  static instances: StubSocket[] = []

  readonly url: string
  readonly sent: string[] = []
  readyState = 0
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    StubSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  /** Accepts the handshake: sets readyState and fires `onopen`. */
  open(): void {
    this.readyState = StubSocket.OPEN
    this.onopen?.()
  }

  /** Delivers one frame as a JSON string, the shape the browser gives us. */
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  close(event?: { code?: number; reason?: string }): void {
    this.readyState = 3
    this.closed = true
    this.onclose?.(event)
  }

  static reset(): void {
    StubSocket.instances.length = 0
  }
}

export interface RecordedPublish {
  utterance: PublishableUtterance
  final: boolean
}

/**
 * A `CaptionSink` that records every call. In-memory, no cloud anything — the
 * proof the port carries no store with it.
 */
export class RecordingSink implements CaptionSink {
  readonly published: RecordedPublish[] = []
  readonly retracted: string[] = []
  readonly statuses: FeedStatus[] = []
  prepared = 0

  /** Set false to model a store that refuses a write (a lapsed authority). */
  acceptWrites = true
  /** Set false to model a lapsed authority for the reconnect stop-condition. */
  authority = true
  /** What `adoptRenewal` answers; default `'renewed'`. */
  renewal: 'renewed' | 'moved' = 'renewed'

  async prepare(): Promise<void> {
    this.prepared += 1
  }

  async publish(utterance: PublishableUtterance, final: boolean): Promise<boolean> {
    this.published.push({ utterance: { ...utterance }, final })
    return this.acceptWrites
  }

  async retract(utteranceId: string): Promise<void> {
    this.retracted.push(utteranceId)
  }

  async publishStatus(status: FeedStatus): Promise<void> {
    this.statuses.push(status)
  }

  authorityValid(): boolean {
    return this.authority
  }

  adoptRenewal(): 'renewed' | 'moved' {
    return this.renewal
  }

  finals(): RecordedPublish[] {
    return this.published.filter((p) => p.final)
  }

  partials(): RecordedPublish[] {
    return this.published.filter((p) => !p.final)
  }
}

export interface Harness {
  engine: LiveTranslateEngine
  sink: RecordingSink
  errors: Error[]
  mint: MintToken & { calls: string[] }
}

/** A `mintToken` that returns a distinct token per call, recording targets. */
export function recordingMint(sessionConfig: Record<string, unknown> = {}): MintToken & { calls: string[] } {
  const calls: string[] = []
  const mint: MintToken & { calls: string[] } = Object.assign(
    async (target: string): Promise<TokenGrant> => {
      calls.push(target)
      return { token: `token-${target}-${calls.length}`, sessionConfig }
    },
    { calls },
  )
  return mint
}

/**
 * Builds an engine wired to a `RecordingSink` and `StubSocket`s, with the
 * bundled EN/VI pack unless another is passed. Does not start it.
 */
export function makeHarness(overrides: Partial<EngineOptions> = {}): Harness {
  const sink = new RecordingSink()
  const errors: Error[] = []
  const mint = recordingMint()
  const engine = new LiveTranslateEngine({
    languages: enVi,
    sink,
    mintToken: mint,
    createSocket: (url) => new StubSocket(url) as unknown as WebSocket,
    onError: (error) => errors.push(error),
    ...overrides,
  })
  return { engine, sink, errors, mint }
}

/**
 * Starts an engine and opens its two stub sockets. Returns them as
 * `[vi, en]` — the pair is `['en','vi']` (English first, so the pinned
 * instruction reads "English/Vietnamese"), so the sockets are found by their
 * token URL rather than by open order. `microphone: false` — the test feeds
 * `pushAudio` itself.
 */
export async function start(
  engine: LiveTranslateEngine,
  grants?: Record<string, TokenGrant>,
): Promise<[StubSocket, StubSocket]> {
  const starting = engine.start({ microphone: false, ...(grants ? { grants } : {}) })
  await flush()
  const fresh = StubSocket.instances.slice(-2)
  for (const socket of fresh) socket.open()
  await starting
  const vi = fresh.find((s) => s.url.includes('-vi'))!
  const en = fresh.find((s) => s.url.includes('-en'))!
  return [vi, en]
}

/**
 * A Live frame carrying an input transcript, the model's translation, or both.
 *
 * The translation is a `modelTurn` text part — the shape a TEXT-modality
 * session actually sends. It used to be authored as `outputTranscription`,
 * which is the audio-modality shape, and that mismatch hid a defect where the
 * engine parsed nothing and published nothing.
 */
export function liveMessage(input: string, output: string, turnComplete = false): Record<string, unknown> {
  return {
    serverContent: {
      ...(input ? { inputTranscription: { text: input } } : {}),
      ...(output ? { modelTurn: { parts: [{ text: output }] } } : {}),
      ...(turnComplete ? { turnComplete: true } : {}),
    },
  }
}

/** Drains queued microtasks without advancing any timer. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}
