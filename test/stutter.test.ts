import { describe, expect, it } from 'vitest'

import { enVi } from '../src/lang/en-vi'
import { collapseStutter } from '../src/transcript/stutter'
import { TargetTurnCoordinator } from '../src/transcript/coordinator'
import { UtteranceMerger } from '../src/transcript/merge'

const now = 1_760_000_000_000
const VI = new Set(enVi.fillerWords!.vi)
const EN = new Set(enVi.fillerWords!.en)

describe('collapseStutter', () => {
  it('collapses the 2026-10-17 sample, original and translation', () => {
    expect(collapseStutter('nó sẽ rơi vào cái cái cái cái cái sự ép lớn', VI)).toBe('nó sẽ rơi vào cái sự ép lớn')
    expect(collapseStutter('So that will happen to the the the the the great pressure', EN)).toBe(
      'So that will happen to the great pressure',
    )
    expect(collapseStutter('là những cái cái giảm sát rồi', VI)).toBe('là những cái giảm sát rồi')
    expect(collapseStutter('it hits the the the the test.', EN)).toBe('it hits the test.')
  })

  it('collapses runs the model writes with commas, as probed', () => {
    expect(collapseStutter('rơi vào cái, cái, cái, cái sự ép lớn.', VI)).toBe('rơi vào cái sự ép lớn.')
    expect(collapseStutter('into the, the, the, the big pressure.', EN)).toBe('into the big pressure.')
    expect(collapseStutter('So the the, the, the', EN)).toBe('So the')
  })

  it('keeps meaningful Vietnamese reduplication', () => {
    expect(collapseStutter('đi từ từ thôi, đi đi', VI)).toBe('đi từ từ thôi, đi đi')
  })

  it('collapses a pair only for a listed filler', () => {
    expect(collapseStutter('I think that that is right', EN)).toBe('I think that that is right')
    expect(collapseStutter('I saw the the cat', EN)).toBe('I saw the cat')
    expect(collapseStutter('I saw the the cat')).toBe('I saw the the cat')
  })

  it('collapses any word repeated three times, filler or not', () => {
    expect(collapseStutter('we we we need this')).toBe('we need this')
  })

  it('matches case-insensitively and keeps the first word as spoken', () => {
    expect(collapseStutter('The the THE plan', EN)).toBe('The plan')
  })

  it('never joins a run across a sentence boundary', () => {
    expect(collapseStutter('Go. Go. Go.')).toBe('Go. Go. Go.')
  })

  it('leaves unspaced Han text and short input untouched', () => {
    expect(collapseStutter('我我我觉得')).toBe('我我我觉得')
    expect(collapseStutter('我 我 我 觉得')).toBe('我 觉得')
    expect(collapseStutter('cái', VI)).toBe('cái')
    expect(collapseStutter('')).toBe('')
  })
})

describe('the merge applies the pack fillers per language', () => {
  it('collapses each line with its own language list, across fragment boundaries', () => {
    const m = new UtteranceMerger({ pair: enVi.pair, detect: enVi.detect, fillerWords: enVi.fillerWords! })
    // The run straddles two deltas, as streamed text does.
    m.add({ utteranceId: 'u1', targetLang: 'en', originalText: 'những cái', translatedText: 'the', final: false, receivedAt: now })
    const merged = m.add({
      utteranceId: 'u1',
      targetLang: 'en',
      originalText: ' cái giám sát rồi là đúng rồi đó',
      translatedText: ' the supervision is right',
      final: true,
      receivedAt: now + 10,
    })
    expect(merged!.sourceLang).toBe('vi')
    expect(merged!.original).toBe('những cái giám sát rồi là đúng rồi đó')
    expect(merged!.translated).toBe('the supervision is right')
  })

  it('reaches the merge through the coordinator', () => {
    const c = new TargetTurnCoordinator(2500, { pair: enVi.pair, detect: enVi.detect, fillerWords: enVi.fillerWords! })
    const publications = c.accept(
      'en',
      { inputText: 'là những cái cái giám sát rồi', outputText: 'are the the supervisions' },
      now,
    )
    const last = publications.at(-1)
    if (!last || last.kind === 'retract') throw new Error('expected a publication')
    expect(last.merged.original).toBe('là những cái giám sát rồi')
    expect(last.merged.translated).toBe('are the supervisions')
  })
})
