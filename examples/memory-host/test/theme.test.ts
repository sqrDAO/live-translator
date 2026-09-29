import { afterEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY, bindThemeToggle, resolveTheme, storedTheme } from '../src/theme'

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

describe('bindThemeToggle', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** Just enough DOM for the toggle: a root, a button and an OS preference. */
  function setup(prefersLight: boolean) {
    const root = { dataset: {} as Record<string, string> }
    let osChange: ((event: { matches: boolean }) => void) | undefined
    let click: (() => void) | undefined
    vi.stubGlobal('document', { documentElement: root, querySelector: () => null })
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: prefersLight, addEventListener: (_: string, fn: typeof osChange) => { osChange = fn } }),
    })
    const attrs: Record<string, string> = {}
    const button = {
      title: '',
      setAttribute: (name: string, value: string) => { attrs[name] = value },
      addEventListener: (_: string, fn: () => void) => { click = fn },
    } as unknown as HTMLButtonElement
    return { root, attrs, button, click: () => click!(), os: (matches: boolean) => osChange!({ matches }) }
  }

  it('follows the OS until the viewer chooses', () => {
    const t = setup(false)
    bindThemeToggle(t.button, storage(null))
    expect(t.root.dataset.theme).toBeUndefined()
    t.os(true)
    expect(t.root.dataset.theme).toBe('light')
    expect(t.attrs['aria-pressed']).toBe('true')
  })

  it('keeps a click over an OS change when storage refuses the write', () => {
    const t = setup(false)
    const refusing = () => ({ getItem: () => null, setItem: () => { throw new Error('quota') } })
    bindThemeToggle(t.button, refusing)
    t.click()
    expect(t.root.dataset.theme).toBe('light')
    t.os(false)
    expect(t.root.dataset.theme).toBe('light')
  })
})
