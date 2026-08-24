/**
 * The reference host's own suite. Runs with no key, no network, no browser:
 * the engine is driven through a stub socket exactly as the package's own
 * tests drive it, and the in-memory sink is asserted directly.
 *
 * This is the proof the boundary is real — a host can be exercised end to end
 * without a Gemini credential.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { LiveTranslateEngine, type TokenGrant } from '@sqrdao/live-translate'
import { enVi } from '@sqrdao/live-translate/lang/en-vi'

import { MemorySink } from '../src/memory-sink'

class StubSocket {
  static readonly OPEN = 1
  static instances: StubSocket[] = []
  readonly url: string
  readonly sent: string[] = []
  readyState = 0
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
  open(): void {
    this.readyState = StubSocket.OPEN
    this.onopen?.()
  }
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

afterEach(() => {
  StubSocket.instances.length = 0
})

async function startEngine(sink: MemorySink) {
  const mint = async (target: string): Promise<TokenGrant> => ({ token: `token-${target}`, sessionConfig: {} })
  const engine = new LiveTranslateEngine({
    languages: enVi,
    sink,
    mintToken: mint,
    createSocket: (url) => new StubSocket(url) as unknown as WebSocket,
    onError: (error) => {
      throw error
    },
  })
  const starting = engine.start({ microphone: false })
  await flush()
  for (const socket of StubSocket.instances) socket.open()
  await starting
  const vi = StubSocket.instances.find((s) => s.url.includes('-vi'))!
  const en = StubSocket.instances.find((s) => s.url.includes('-en'))!
  return { engine, vi, en }
}

function frame(input: string, output: string, turnComplete = false) {
  return {
    serverContent: {
      inputTranscription: { text: input },
      outputTranscription: { text: output },
      ...(turnComplete ? { turnComplete: true } : {}),
    },
  }
}

describe('the memory host, end to end, with no credential', () => {
  it('renders a merged bilingual utterance into the in-memory sink', async () => {
    const sink = new MemorySink()
    const { engine, vi, en } = await startEngine(sink)

    vi.receive(frame('Hello', 'Xin chào', true))
    await flush()
    en.receive(frame('Hello', 'Hello', true))
    await flush()

    const stored = [...sink.utterances.values()]
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      sourceLang: 'en',
      original: 'Hello',
      translated: 'Xin chào',
      final: true,
    })
    await engine.stop()
  })

  it('reports the feed live on start and closed on stop', async () => {
    const statuses: string[] = []
    const sink = new MemorySink({ onStatus: (s) => statuses.push(s) })
    const { engine } = await startEngine(sink)
    await flush()
    expect(sink.status).toBe('live')
    await engine.stop()
    expect(statuses.at(-1)).toBe('closed')
  })

  it('starts each publication from an empty surface', async () => {
    const sink = new MemorySink()
    await sink.publish(
      { utteranceId: 'stale', sourceLang: 'en', original: 'old', translated: 'cũ', startedAt: 0, updatedAt: 0 },
      true,
    )
    expect(sink.utterances.size).toBe(1)
    const { engine } = await startEngine(sink)
    expect(sink.utterances.size).toBe(0)
    await engine.stop()
  })
})
