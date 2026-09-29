import { describe, expect, it } from 'vitest'
import { THEME_STORAGE_KEY, resolveTheme, storedTheme } from '../src/theme'

const storage = (value: string | null) => () => ({
  getItem: (key: string) => (key === THEME_STORAGE_KEY ? value : null),
  setItem: () => {},
})

describe('storedTheme', () => {
  it('reads a valid stored choice', () => {
    expect(storedTheme(storage('light'))).toBe('light')
    expect(storedTheme(storage('dark'))).toBe('dark')
  })

  it('ignores a missing or unknown value', () => {
    expect(storedTheme(storage(null))).toBeNull()
    expect(storedTheme(storage('sepia'))).toBeNull()
  })

  it('treats unreadable storage as no choice', () => {
    expect(storedTheme(() => { throw new Error('blocked') })).toBeNull()
  })
})

describe('resolveTheme', () => {
  it('lets an explicit choice beat the OS setting', () => {
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('light', false)).toBe('light')
  })

  it('follows the OS without a choice, dark by default', () => {
    expect(resolveTheme(null, true)).toBe('light')
    expect(resolveTheme(null, false)).toBe('dark')
  })
})
