import { afterEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY, bindThemeToggle, nextChoice, resolveTheme, storedTheme } from '../src/theme'

const storage = (value: string | null) => () => ({
  getItem: (key: string) => (key === THEME_STORAGE_KEY ? value : null),
  setItem: () => {},
  removeItem: () => {},
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

describe('nextChoice', () => {
  it('leaves system for the theme not showing, so the first click changes something', () => {
    expect(nextChoice(null, false)).toBe('light')
    expect(nextChoice(null, true)).toBe('dark')
  })

  it('then pins the OS theme, then returns to system', () => {
    expect(nextChoice('light', false)).toBe('dark')
    expect(nextChoice('dark', false)).toBeNull()
    expect(nextChoice('dark', true)).toBe('light')
    expect(nextChoice('light', true)).toBeNull()
  })
})

describe('bindThemeToggle', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** Just enough DOM for the toggle: a root, a button and a changeable OS preference. */
  function setup(prefersLight: boolean) {
    const root = { dataset: {} as Record<string, string> }
    const media = { matches: prefersLight, listener: undefined as undefined | (() => void) }
    let click: (() => void) | undefined
    vi.stubGlobal('document', { documentElement: root, querySelector: () => null })
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('window', {
      matchMedia: () => ({
        get matches() { return media.matches },
        addEventListener: (_: string, fn: () => void) => { media.listener = fn },
      }),
    })
    const attrs: Record<string, string> = {}
    const button = {
      title: '',
      dataset: {} as Record<string, string>,
      setAttribute: (name: string, value: string) => { attrs[name] = value },
      addEventListener: (_: string, fn: () => void) => { click = fn },
    }
    return {
      root, attrs, button,
      bind: (store: Parameters<typeof bindThemeToggle>[1]) => bindThemeToggle(button as unknown as HTMLButtonElement, store),
      click: () => click!(),
      os: (light: boolean) => { media.matches = light; media.listener!() },
    }
  }

  function memory(initial: string | null = null) {
    const data = new Map<string, string>(initial ? [[THEME_STORAGE_KEY, initial]] : [])
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
    return { data, store: () => store }
  }

  it('follows the OS while on system', () => {
    const t = setup(false)
    t.bind(memory().store)
    expect(t.button.dataset.choice).toBe('system')
    expect(t.root.dataset.theme).toBeUndefined()
    t.os(true)
    expect(t.root.dataset.theme).toBe('light')
  })

  it('cycles system, light, dark, system, storing and then forgetting the choice', () => {
    const t = setup(false)
    const m = memory()
    t.bind(m.store)
    t.click()
    expect([t.button.dataset.choice, t.root.dataset.theme, m.data.get(THEME_STORAGE_KEY)]).toEqual(['light', 'light', 'light'])
    t.click()
    expect([t.button.dataset.choice, t.root.dataset.theme, m.data.get(THEME_STORAGE_KEY)]).toEqual(['dark', undefined, 'dark'])
    t.click()
    expect([t.button.dataset.choice, m.data.has(THEME_STORAGE_KEY)]).toEqual(['system', false])
    // Back on system, the OS is in charge again.
    t.os(true)
    expect(t.root.dataset.theme).toBe('light')
  })

  it('names the setting and the next step in the label', () => {
    const t = setup(false)
    t.bind(memory('light').store)
    expect(t.attrs['aria-label']).toBe('Theme: light. Switch to dark')
    t.os(true)
    expect(t.attrs['aria-label']).toBe('Theme: light. Switch to system')
  })

  it('keeps a click over an OS change when storage refuses the write', () => {
    const t = setup(false)
    const refusing = () => ({ getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} })
    t.bind(refusing)
    t.click()
    expect(t.root.dataset.theme).toBe('light')
    t.os(false)
    expect(t.root.dataset.theme).toBe('light')
  })
})
