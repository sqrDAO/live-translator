import { describe, expect, it } from 'vitest'

import { enVi } from '../src/lang/en-vi'
import { TargetTurnCoordinator } from '../src/transcript/coordinator'

const IDLE = 1_500

function coordinator(options: { forcedSourceLang?: string; maxUtteranceSentences?: number; maxUtteranceMs?: number } = {}) {
  return new TargetTurnCoordinator(IDLE, { pair: enVi.pair, detect: enVi.detect, ...options })
}

describe('turn coordination with no turnComplete', () => {
  it('keeps a fast target\'s next turn separate from a slow peer\'s prior turn', () => {
    const c = coordinator()
    const at = 1_000
    c.accept('vi', { inputText: 'Hello', outputText: 'Xin chào', turnComplete: true }, at)
    c.accept('vi', { inputText: 'Next', outputText: 'Tiếp theo' }, at + 1)
    const first = c.accept('en', { inputText: 'Hello', outputText: 'Hello', turnComplete: true }, at + 2)
    expect(first[0]).toMatchObject({ kind: 'final', utteranceId: 'u0', merged: { translated: 'Xin chào' } })

    c.accept('en', { inputText: 'Next', outputText: 'Next', turnComplete: true }, at + 3)
    const second = c.accept('vi', { turnComplete: true }, at + 4)
    expect(second[0]).toMatchObject({ kind: 'final', utteranceId: 'u1', merged: { translated: 'Tiếp theo' } })
  })

  it('publishes every utterance when turnComplete never arrives at all', () => {
    // The real shape of the current protocol: transcription fragments only,
    // turns separated by nothing but silence. Each idle retirement must both
    // publish the finished utterance and open the next.
    const c = coordinator()
    const at = 1_000
    const finals: string[] = []
    for (let n = 0; n < 3; n += 1) {
      const t = at + n * 5_000
      c.accept('en', { inputText: `Sentence ${n}`, outputText: `Sentence ${n}` }, t)
      c.accept('vi', { inputText: `Sentence ${n}`, outputText: `Câu ${n}` }, t + 100)
      for (const pub of c.finalizeIdle(t + 2_000)) if (pub.kind === 'final') finals.push(pub.merged.translated)
    }
    expect(finals).toEqual(['Câu 0', 'Câu 1', 'Câu 2'])
  })

  it('attaches a peer frame arriving after idle retirement to the successor, not a dead turn', () => {
    const c = coordinator()
    const at = 1_000
    c.accept('vi', { inputText: 'First', outputText: 'Mot', turnComplete: true }, at)
    expect(c.finalizeIdle(at + IDLE)).toHaveLength(1)
    // Late EN passthrough for the retired turn: unpublishable alone, lands in u1.
    expect(c.accept('en', { inputText: 'First', outputText: 'First', turnComplete: true }, at + IDLE + 1)).toEqual([])
    const next = c.accept('vi', { inputText: 'Second', outputText: 'Hai', turnComplete: true }, at + IDLE + 2)
    expect(next[0]).toMatchObject({ kind: 'final', utteranceId: 'u1', merged: { translated: 'Hai' } })
  })

  it('retires an unpublishable turn with a retract so a stale partial comes down', () => {
    const c = coordinator()
    const at = 1_000
    c.accept('vi', { inputText: 'Xin chào', outputText: 'Xin chào', turnComplete: true }, at)
    expect(c.accept('en', { inputText: 'Xin chào', turnComplete: true }, at + 1)).toEqual([
      { kind: 'retract', utteranceId: 'u0' },
    ])
  })
})

describe('utterance caps', () => {
  const capped = () => coordinator({ maxUtteranceSentences: 3, maxUtteranceMs: 10_000 })
  const say = (c: ReturnType<typeof capped>, vi: string, en: string, at: number) =>
    c.accept('en', { inputText: vi, outputText: en }, at)

  it('retires on the fragment that completes the third sentence', () => {
    const c = capped()
    const at = 1_000
    expect(say(c, 'Câu một.', 'One.', at)[0]).toMatchObject({ kind: 'partial' })
    expect(say(c, ' Câu hai.', ' Two.', at + 200)[0]).toMatchObject({ kind: 'partial' })
    const third = say(c, ' Câu ba.', ' Three.', at + 400)
    expect(third[0]).toMatchObject({ kind: 'final', utteranceId: 'u0', merged: { original: 'Câu một. Câu hai. Câu ba.' } })
    // The continuation opens a fresh turn rather than reviving the retired one.
    expect(say(c, 'Câu bốn.', 'Four.', at + 600)[0]).toMatchObject({ utteranceId: 'u1', merged: { original: 'Câu bốn.' } })
  })

  it('advances both cursors on a sentence retirement, so the silent peer lands in the successor', () => {
    const c = capped()
    const at = 1_000
    say(c, 'Câu một. Câu hai. Câu ba.', 'One. Two. Three.', at)
    const fromVi = c.accept('vi', { inputText: 'Câu bốn.', outputText: 'Four.' }, at + 100)
    expect(fromVi[0]).toMatchObject({ utteranceId: 'u1' })
  })

  it('retires on the age cap when no sentence ever completes, advancing both cursors', () => {
    const c = capped()
    const at = 1_000
    say(c, 'và thế là', 'and so', at)
    expect(c.finalizeIdle(at + 10_000)).toHaveLength(1)
    expect(say(c, 'Câu mới.', 'A new sentence.', at + 10_001)[0]).toMatchObject({ utteranceId: 'u1' })
    expect(c.accept('vi', { inputText: 'Thêm.', outputText: 'More.' }, at + 10_002)[0]).toMatchObject({ utteranceId: 'u1' })
  })

  it('still retires on silence before either cap, and does not count decimals', () => {
    const c = capped()
    const at = 1_000
    say(c, 'Câu một.', 'One.', at)
    expect(c.finalizeIdle(at + IDLE)).toHaveLength(1)

    const d = capped()
    expect(say(d, 'Khoảng 1.5 đến 2.5 và 3.5 giây', 'About 1.5 to 2.5 and 3.5 s', 1_000)[0]).toMatchObject({ kind: 'partial' })
  })

  it('caps one coordinator without touching another', () => {
    const a = capped()
    const b = capped()
    const at = 1_000
    say(a, 'Câu một. Câu hai. Câu ba.', 'One. Two. Three.', at)
    say(b, 'Câu một.', 'One.', at)
    expect(b.finalizeIdle(at + 1)).toEqual([])
  })
})


it('bounds a source-only preview without cutting it at the source sentence cap', () => {
  const c = new TargetTurnCoordinator(IDLE, {
    pair: enVi.pair, detect: enVi.detect, forcedSourceLang: 'en',
    allowSourceOnly: true, maxUtteranceMs: 10_000, maxUtteranceSentences: 1,
  })
  expect(c.accept('vi', { inputText: 'Hello everyone.' }, 1000)[0]?.kind).toBe('partial')
  expect(c.finalizeIdle(3000)).toEqual([])
  expect(c.finalizeIdle(11000)[0]).toMatchObject({ kind: 'final', utteranceId: 'u0', merged: { translated: '' } })
})
