/**
 * Light / dark theme. Dark is the system's canonical mode; light is its warm
 * variant, switched by `data-theme="light"` on <html>, which is the selector
 * the vendored sqrDES tokens re-point every mode-dependent value under.
 *
 * An explicit choice is remembered per browser. Without one the page follows
 * the OS setting, and keeps following it while open. The inline script in
 * index.html applies the same rule before first paint, so a light visitor
 * never sees a dark flash; keep the two in step.
 */

export type Theme = 'dark' | 'light'

export const THEME_STORAGE_KEY = 'live-translate:theme'

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>

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

export function currentTheme(root: HTMLElement = document.documentElement): Theme {
  return root.dataset.theme === 'light' ? 'light' : 'dark'
}

/**
 * Wires a toggle button: `aria-pressed` means "light theme on". Returns the
 * function that re-renders it, for tests and for OS-driven changes.
 */
export function bindThemeToggle(button: HTMLButtonElement, storage: () => ThemeStorage): () => void {
  const media = window.matchMedia('(prefers-color-scheme: light)')
  const render = (): void => {
    const light = currentTheme() === 'light'
    button.setAttribute('aria-pressed', String(light))
    button.title = light ? 'Switch to dark theme' : 'Switch to light theme'
  }

  applyTheme(resolveTheme(storedTheme(storage), media.matches))
  render()

  button.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'light' ? 'dark' : 'light'
    applyTheme(next)
    try {
      storage().setItem(THEME_STORAGE_KEY, next)
    } catch {
      // A per-viewer convenience; the theme still applies to this page.
    }
    render()
  })

  // Follow the OS only until the viewer has chosen.
  media.addEventListener('change', (event) => {
    if (storedTheme(storage)) return
    applyTheme(event.matches ? 'light' : 'dark')
    render()
  })

  return render
}
