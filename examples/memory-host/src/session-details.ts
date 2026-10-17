/**
 * The operator's "Session details": a title, the speakers and the names the
 * room will hear, sent as `context` with every token request.
 *
 * Why it exists (probed 2026-10-17): without a glossary the model dropped
 * "Martinez" and "Julián Álvarez" from a Vietnamese speaker's own transcript;
 * with one, every name survived in both lines. The engine had the plumbing all
 * along; nothing upstream of the mint knew the names. The operator does.
 *
 * Stored as the raw text of the three fields, not the parsed lists, so a
 * reload gives back exactly what was typed — blank lines and all. The server
 * (`api/_context.ts`) is the bound: it trims, strips controls and truncates
 * to the limits the help text prints, so this side only splits.
 */

import type { LiveSessionContext } from '@sqrdao/live-translate'

export const SESSION_DETAILS_STORAGE_KEY = 'live-translate:session-details'

export interface SessionDetails {
  title: string
  /** One speaker per line. */
  speakers: string
  /** One name or term per line, or comma-separated. */
  glossary: string
}

type DetailsStorage = Pick<Storage, 'getItem' | 'setItem'>

export const EMPTY_DETAILS: SessionDetails = { title: '', speakers: '', glossary: '' }

/** What was typed last time, or blanks if nothing valid is stored or storage refuses. */
export function storedDetails(storage: () => DetailsStorage): SessionDetails {
  try {
    const raw = storage().getItem(SESSION_DETAILS_STORAGE_KEY)
    if (!raw) return { ...EMPTY_DETAILS }
    const parsed = JSON.parse(raw) as Partial<Record<keyof SessionDetails, unknown>>
    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    return { title: text(parsed.title), speakers: text(parsed.speakers), glossary: text(parsed.glossary) }
  } catch {
    return { ...EMPTY_DETAILS }
  }
}

export function saveDetails(storage: () => DetailsStorage, details: SessionDetails): void {
  try {
    storage().setItem(SESSION_DETAILS_STORAGE_KEY, JSON.stringify(details))
  } catch {
    // A per-viewer convenience; the details still apply to this page.
  }
}

const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

/**
 * The `context` to send, or `null` when every field is blank.
 *
 * Speakers split on lines only — "Name — Affiliation, Title" is one speaker.
 * Names split on lines AND commas (ASCII and the CJK `，` / `、`), because a
 * pasted glossary is as often a comma list as a column.
 */
export function detailsContext(details: SessionDetails): LiveSessionContext | null {
  const sessionTitle = details.title.trim()
  const speakers = lines(details.speakers)
  const glossary = details.glossary
    .split(/[\r\n,，、]+/)
    .map((term) => term.trim())
    .filter(Boolean)
  const context: LiveSessionContext = {
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(speakers.length > 0 ? { speakers } : {}),
    ...(glossary.length > 0 ? { glossary } : {}),
  }
  return Object.keys(context).length > 0 ? context : null
}

/** The collapsed summary's tail: what is set, so a closed panel still says so. */
export function detailsSummary(context: LiveSessionContext | null): string {
  if (!context) return 'none'
  const parts: string[] = []
  if (context.sessionTitle) parts.push('title')
  if (context.speakers) parts.push(`${context.speakers.length} ${context.speakers.length === 1 ? 'speaker' : 'speakers'}`)
  if (context.glossary) parts.push(`${context.glossary.length} ${context.glossary.length === 1 ? 'name' : 'names'}`)
  return parts.join(' · ')
}
