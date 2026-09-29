/**
 * Light / dark theme. Dark is the system's canonical mode; light is its warm
 * variant, switched by `data-theme="light"` on <html>, which is the selector
 * the vendored sqrDES tokens re-point every mode-dependent value under.
 *
 * The toggle cycles three settings: follow the OS (the default, and live
 * while the page is open), then an explicit light or dark. An explicit
 * choice is remembered per browser; returning to "system" forgets it. The inline script in
 * index.html applies the same rule before first paint, so a light visitor
 * never sees a dark flash; keep the two in step.
 */

export type Theme = 'dark' | 'light'

export const THEME_STORAGE_KEY = 'live-translate:theme'

/** What the viewer picked: a theme, or null to follow the OS. */
export type ThemeChoice = Theme | null

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The stored choice, if there is a valid one and storage is readable. */
export function storedTheme(storage: () => ThemeStorage): Theme | null {
  try {
    const value = storage().getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

/** An explicit choice wins; otherwise the OS preference; otherwise dark. */
export function resolveTheme(stored: Theme | null, prefersLight: boolean): Theme {
  return stored ?? (prefersLight ? 'light' : 'dark')
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'light') root.dataset.theme = 'light'
  else delete root.dataset.theme
  // Browser chrome follows the canvas, read from the token so it tracks the brand.
  const canvas = getComputedStyle(root).getPropertyValue('--color-background').trim()
  if (canvas) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas)
}

/**
 * The setting after a click. From "system" the first step is always the
 * theme not showing, so the click visibly does something; the one after
 * pins the OS's own theme; the next hands control back to the OS.
 */
export function nextChoice(choice: ThemeChoice, prefersLight: boolean): ThemeChoice {
  const os: Theme = prefersLight ? 'light' : 'dark'
  if (choice === null) return os === 'light' ? 'dark' : 'light'
  return choice === os ? null : os
}

const LABEL: Record<'system' | Theme, string> = { system: 'system', light: 'light', dark: 'dark' }

export function currentTheme(root: HTMLElement = document.documentElement): Theme {
  return root.dataset.theme === 'light' ? 'light' : 'dark'
}

/**
 * Wires the theme button. `data-choice` (system / light / dark) drives the
 * icon; the label names the setting and what a click does next. Returns the
 * function that re-renders it.
 */
export function bindThemeToggle(button: HTMLButtonElement, storage: () => ThemeStorage): () => void {
  const media = window.matchMedia('(prefers-color-scheme: light)')
  // Read once, then held here: the page's own record, so a refused write
  // (some private modes) still leaves the viewer's setting in charge.
  let choice: ThemeChoice = storedTheme(storage)

  const render = (): void => {
    const setting = choice ?? 'system'
    const next = nextChoice(choice, media.matches) ?? 'system'
    button.dataset.choice = setting
    button.setAttribute('aria-label', `Theme: ${LABEL[setting]}. Switch to ${LABEL[next]}`)
    button.title = `Theme: ${LABEL[setting]} — click for ${LABEL[next]}`
  }

  applyTheme(resolveTheme(choice, media.matches))
  render()

  button.addEventListener('click', () => {
    choice = nextChoice(choice, media.matches)
    applyTheme(resolveTheme(choice, media.matches))
    try {
      if (choice) storage().setItem(THEME_STORAGE_KEY, choice)
      else storage().removeItem(THEME_STORAGE_KEY)
    } catch {
      // A per-viewer convenience; the setting still applies to this page.
    }
    render()
  })

  media.addEventListener('change', () => {
    if (choice === null) applyTheme(resolveTheme(null, media.matches))
    // The label's "next" step depends on the OS theme, so re-render either way.
    render()
  })

  return render
}
