import { afterEach, describe, expect, it, vi } from 'vitest'

import { replay } from './support/replay'

afterEach(() => {
  vi.useRealTimers()
})

describe('frame replay from authored fixtures', () => {
  it('accumulates incremental deltas into one sentence, not three', async () => {
    const { sink } = await replay('delta-accumulation.jsonl')
    const finals = sink.finals()
    expect(finals).toHaveLength(1)
    expect(finals[0]!.utterance).toMatchObject({
      sourceLang: 'en',
      original: 'Hello everyone, and welcome to the annual forum.',
      translated: 'Xin chào mọi người, và chào mừng đến diễn đàn thường niên.',
    })
  })

  it('labels a flipped session by its transcript, not by echo inference', async () => {
    const { sink } = await replay('direction-flip.jsonl')
    const finals = sink.finals()
    expect(finals).toHaveLength(1)
    expect(finals[0]!.utterance).toMatchObject({
      sourceLang: 'vi',
      original: 'vào đấy đấy.',
      translated: "That's it.",
    })
  })

  it('publishes one utterance per idle gap when no turnComplete ever arrives', async () => {
    const { sink } = await replay('idle-retirement.jsonl')
    const translations = sink.finals().map((p) => p.utterance.translated)
    expect(translations).toEqual(['Câu không', 'Câu một'])
  })

  it('caps a gapless run at three sentences', async () => {
    const { sink } = await replay('sentence-cap.jsonl')
    const finals = sink.finals()
    expect(finals).toHaveLength(1)
    expect(finals[0]!.utterance.original).toBe('Câu một. Câu hai. Câu ba.')
  })

  it('rotates on goAway and carries the newest resumable handle into the reopened setup', async () => {
    const { setups } = await replay('resumption-goaway.jsonl')
    // The last socket created for vi is the reconnect; its setup carries H1
    // (H2 was non-resumable). At least one setup frame must present the handle.
    const withHandle = setups.filter(
      (s) => JSON.stringify(s) === JSON.stringify({ sessionResumption: { handle: 'H1' } }),
    )
    expect(withHandle.length).toBeGreaterThanOrEqual(1)
  })

  it('stays bounded when every reconnect closes on the setup frame', async () => {
    // vi drops and each reconnect is accepted then closed with no message.
    // Five attempts, no more: one initial pair + five vi reconnect sockets.
    const { socketCount } = await replay('setup-frame-close.jsonl')
    expect(socketCount).toBeLessThanOrEqual(2 + 5)
  })
})
