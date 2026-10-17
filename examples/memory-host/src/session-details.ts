/**
 * The operator's "Session details": a title, the speakers and the names the
 * room will hear, sent as `context` with every token request.
 *
 * Why it exists (probed 2026-10-17): without a glossary the model dropped
 * "Martinez" and "Julián Álvarez" from a Vietnamese speaker's own transcript;
 * with one, every name survived in both lines. The engine had the plumbing all
 * along; nothing upstream of the mint knew the names. The operator does.
 *
 * Normalisation happens once, on the server (`api/_context.ts`): trimming,
 * blanks, repeats, comma splitting, length and count limits. This side only
 * splits the textareas into lines and sends them, so no name is lost here
 * before those rules apply. The panel's summary runs the SAME reader to say
 * what will actually be used — imported, not re-implemented, so the two
 * cannot drift (review of 2026-10-17).
 *
 * Stored as the raw text of the three fields, so a reload gives back exactly
 * what was typed.
 */

import type { LiveSessionContext } from '@sqrdao/live-translate'

import { CONTEXT_LIMITS, readSessionContext } from '../../../api/_context'

export { CONTEXT_LIMITS }

export const SESSION_DETAILS_STORAGE_KEY = 'live-translate:session-details'

export interface SessionDetails {
  title: string
  /** One speaker per line. */
  speakers: string
  /** One name or term per line, or comma-separated (the server splits commas). */
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

/**
 * The `context` to send: the fields as typed, the lists split into lines and
 * nothing else. `null` only when every field is whitespace, which the server
 * would reduce to "no context" anyway — this just keeps the request clean.
 */
export function detailsContext(details: SessionDetails): LiveSessionContext | null {
  if (!details.title.trim() && !details.speakers.trim() && !details.glossary.trim()) return null
  return {
    sessionTitle: details.title,
    speakers: details.speakers.split(/\r?\n/),
    glossary: details.glossary.split(/\r?\n/),
  }
}

/**
 * The collapsed summary's tail: what the server will use, from its own
 * reader, and how many entries it will not (too long, or past the count).
 */
export function detailsSummary(details: SessionDetails): string {
  const reading = readSessionContext(detailsContext(details))
  // The textareas only make strings, so the one refusal they can reach is a
  // paste past `CONTEXT_CEILING` — which would fail the mint, so say so here.
  if (!reading.ok) return 'too long to send, shorten the lists'
  if (!reading.context && !reading.dropped.speakers && !reading.dropped.glossary) return 'none'
  const { sessionTitle, speakers, glossary } = reading.context ?? {}
  const count = (n: number, one: string, many: string, dropped: number) =>
    `${n} ${n === 1 ? one : many}${dropped > 0 ? ` (${dropped} not used)` : ''}`
  const parts: string[] = []
  if (sessionTitle) parts.push('title')
  if (speakers || reading.dropped.speakers) {
    parts.push(count(speakers?.length ?? 0, 'speaker', 'speakers', reading.dropped.speakers))
  }
  if (glossary || reading.dropped.glossary) {
    parts.push(count(glossary?.length ?? 0, 'name', 'names', reading.dropped.glossary))
  }
  return parts.join(' · ')
}

/** The help text's limits, from the same constants the server enforces. */
export function limitsText(): string {
  const l = CONTEXT_LIMITS
  return (
    `Up to ${l.speakers} speakers (${l.speaker} characters each) and ${l.glossary} names ` +
    `(${l.term} characters each); a longer name is skipped, not shortened, and entries past ` +
    `the limit are not used. Titles over ${l.title} characters are shortened.`
  )
}
