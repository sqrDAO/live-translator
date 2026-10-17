import { describe, expect, it } from 'vitest'
import {
  CONTEXT_LIMITS,
  SESSION_DETAILS_STORAGE_KEY,
  detailsContext,
  detailsSummary,
  limitsText,
  saveDetails,
  storedDetails,
} from '../src/session-details'

function memory(initial: string | null = null) {
  let value = initial
  return {
    storage: () => ({
      getItem: (key: string) => (key === SESSION_DETAILS_STORAGE_KEY ? value : null),
      setItem: (key: string, next: string) => {
        if (key === SESSION_DETAILS_STORAGE_KEY) value = next
      },
    }),
  }
}

const blank = { title: '', speakers: '', glossary: '' }

describe('detailsContext', () => {
  it('only splits lines: trimming, blanks, repeats and commas are the server\'s', () => {
    expect(
      detailsContext({
        title: '  Football panel ',
        speakers: 'Emiliano Martinez — Aston Villa\n\n Lionel Messi ',
        glossary: 'Julián Álvarez, sqrDAO\nsqrDAO',
      }),
    ).toEqual({
      sessionTitle: '  Football panel ',
      speakers: ['Emiliano Martinez — Aston Villa', '', ' Lionel Messi '],
      glossary: ['Julián Álvarez, sqrDAO', 'sqrDAO'],
    })
  })

  it('is null when every field is whitespace', () => {
    expect(detailsContext({ title: ' ', speakers: '\n\n', glossary: ' ' })).toBeNull()
  })
})

describe('detailsSummary', () => {
  it('reports what the server will use, after its own splitting and dedupe', () => {
    expect(detailsSummary(blank)).toBe('none')
    expect(detailsSummary({ title: 'T', speakers: 'a\n\na', glossary: 'x, y\ny' })).toBe('title · 1 speaker · 2 names')
  })

  it('says how many names will not be used, never more than the cap', () => {
    const names = Array.from({ length: CONTEXT_LIMITS.glossary + 3 }, (_, i) => `Name ${i}`).join('\n')
    const tooLong = 'x'.repeat(CONTEXT_LIMITS.term + 1)
    expect(detailsSummary({ ...blank, glossary: `${names}\n${tooLong}` })).toBe(
      `${CONTEXT_LIMITS.glossary} names (4 not used)`,
    )
    // Only an over-long name: nothing used, but not "none" either.
    expect(detailsSummary({ ...blank, glossary: tooLong })).toBe('0 names (1 not used)')
  })

  it('warns when a paste is past what the server will accept at all', () => {
    expect(detailsSummary({ ...blank, glossary: 'a\n'.repeat(5_000) })).toMatch(/too long/)
  })
})

describe('limitsText', () => {
  it('is written from the shared limits', () => {
    const text = limitsText()
    for (const n of Object.values(CONTEXT_LIMITS)) expect(text).toContain(String(n))
  })
})

describe('storedDetails / saveDetails', () => {
  it('round-trips the raw text, blank lines and all', () => {
    const { storage } = memory()
    const details = { title: 'T', speakers: 'A\n\nB', glossary: 'x, y' }
    saveDetails(storage, details)
    expect(storedDetails(storage)).toEqual(details)
  })

  it('treats missing, corrupt or unreadable storage as blanks', () => {
    expect(storedDetails(memory().storage)).toEqual(blank)
    expect(storedDetails(memory('{not json').storage)).toEqual(blank)
    expect(storedDetails(memory('{"title":7,"glossary":"g"}').storage)).toEqual({ ...blank, glossary: 'g' })
    expect(storedDetails(() => { throw new Error('blocked') })).toEqual(blank)
  })

  it('swallows a refused write', () => {
    const refusing = () => ({
      getItem: () => null,
      setItem: () => { throw new Error('quota') },
    })
    expect(() => saveDetails(refusing, { title: 'T', speakers: '', glossary: '' })).not.toThrow()
  })
})
