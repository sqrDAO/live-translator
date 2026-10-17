import { describe, expect, it } from 'vitest'
import {
  SESSION_DETAILS_STORAGE_KEY,
  detailsContext,
  detailsSummary,
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
    read: () => value,
  }
}

describe('detailsContext', () => {
  it('splits speakers on lines and names on lines or commas', () => {
    expect(
      detailsContext({
        title: '  Football panel ',
        speakers: 'Emiliano Martinez — Aston Villa, goalkeeper\n\n  Lionel Messi  \r\n',
        glossary: 'Julián Álvarez, sqrDAO\nEMpower，Da Nang、W3BS,,',
      }),
    ).toEqual({
      sessionTitle: 'Football panel',
      speakers: ['Emiliano Martinez — Aston Villa, goalkeeper', 'Lionel Messi'],
      glossary: ['Julián Álvarez', 'sqrDAO', 'EMpower', 'Da Nang', 'W3BS'],
    })
  })

  it('is null when every field is blank, so no context is sent', () => {
    // An empty context object would still change the pinned instruction.
    expect(detailsContext({ title: ' ', speakers: '\n\n', glossary: ' , ,' })).toBeNull()
  })

  it('omits the fields that are blank', () => {
    expect(detailsContext({ title: '', speakers: '', glossary: 'Messi' })).toEqual({ glossary: ['Messi'] })
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
    const blank = { title: '', speakers: '', glossary: '' }
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

describe('detailsSummary', () => {
  it('names what is set', () => {
    expect(detailsSummary(null)).toBe('none')
    expect(detailsSummary({ sessionTitle: 'T', speakers: ['a'], glossary: ['x', 'y'] })).toBe('title · 1 speaker · 2 names')
  })
})
