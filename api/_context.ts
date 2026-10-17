/**
 * Programme context from the page — session title, speakers, names — read
 * strictly before any of it reaches the session instruction.
 *
 * Why the page supplies it at all: probed 2026-10-17 against
 * `gemini-3.5-live-translate-preview`, a Vietnamese sentence naming "Emiliano
 * Martinez", "Lionel Messi" and "Julián Álvarez" came back with "Martinez" and
 * "Julián Álvarez" missing from the input transcription. A glossary in the
 * instruction restored every name in both lines; nothing else tried did. The
 * names are the operator's to know, per session, so they come with the mint.
 *
 * Shared by `api/token.ts` and the reference host's Express server, so the
 * deployed endpoint and `npm run example` cannot bound it differently. The
 * `_` prefix keeps Vercel from deploying this file as an endpoint of its own.
 *
 * The policy, chosen 2026-10-17: the wrong SHAPE is refused (400) — a number
 * where a string belongs is a broken client, and minting past it would hide
 * the bug — while the wrong SIZE is truncated. An operator who pastes a
 * fifty-first name mid-event should get a feed with fifty, not a mic that will
 * not start; the limits are printed beside the fields so the cut is no
 * surprise. Text is pinned verbatim into the token, which is why it is bounded
 * at all: it is still only an approved user's own instruction, but a pasted
 * megabyte would be a megabyte in every mint and every reconnect.
 */

import type { LiveSessionContext } from '../src/gemini/config.js'

/** Characters, counted in code points so a cut never splits a surrogate pair. */
export const CONTEXT_LIMITS = {
  title: 120,
  speakers: 10,
  speaker: 120,
  glossary: 50,
  term: 60,
} as const

export type ContextReading = { ok: true; context?: LiveSessionContext } | { ok: false; error: string }

// C0/C1 controls (newline and tab among them: every field is one line of the
// instruction), the Unicode line and paragraph separators, zero-width and
// bidi-override characters — none of which a name needs, and the last of which
// can make an instruction read differently from how it displays.
const CONTROL = /[\p{Cc}\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu

/** One line of text: controls become spaces, runs collapse, ends trimmed, length cut. */
function clean(value: string, max: number): string {
  const line = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const points = Array.from(line)
  return points.length > max ? points.slice(0, max).join('').trimEnd() : line
}

function readText(value: unknown, field: string, max: number): { ok: true; text?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'string') return { ok: false, error: `context.${field} must be a string` }
  const text = clean(value, max)
  return text ? { ok: true, text } : { ok: true }
}

function readList(
  value: unknown,
  field: string,
  count: number,
  max: number,
): { ok: true; list?: string[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return { ok: false, error: `context.${field} must be an array of strings` }
  }
  // Blanks and repeats are dropped BEFORE the count is applied, so a list
  // padded with empty lines still keeps its real entries.
  const list = [...new Set(value.map((item) => clean(item, max)).filter(Boolean))].slice(0, count)
  return list.length > 0 ? { ok: true, list } : { ok: true }
}

/**
 * The bounded context, or none.
 *
 * "None" is load-bearing: `buildLiveSessionConfig` adds a hesitation clause
 * whenever a context object is present, even an empty one, so a page that
 * sends four blank fields must get `context` omitted — not `{}` — or its
 * instruction (and so what its token authorizes) differs from a page that
 * sent nothing.
 */
export function readSessionContext(value: unknown): ContextReading {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'context must be an object' }
  const raw = value as Record<string, unknown>

  const sessionTitle = readText(raw['sessionTitle'], 'sessionTitle', CONTEXT_LIMITS.title)
  if (!sessionTitle.ok) return sessionTitle
  const eventName = readText(raw['eventName'], 'eventName', CONTEXT_LIMITS.title)
  if (!eventName.ok) return eventName
  const speakers = readList(raw['speakers'], 'speakers', CONTEXT_LIMITS.speakers, CONTEXT_LIMITS.speaker)
  if (!speakers.ok) return speakers
  const glossary = readList(raw['glossary'], 'glossary', CONTEXT_LIMITS.glossary, CONTEXT_LIMITS.term)
  if (!glossary.ok) return glossary

  const context: LiveSessionContext = {
    ...(sessionTitle.text ? { sessionTitle: sessionTitle.text } : {}),
    ...(eventName.text ? { eventName: eventName.text } : {}),
    ...(speakers.list ? { speakers: speakers.list } : {}),
    ...(glossary.list ? { glossary: glossary.list } : {}),
  }
  return Object.keys(context).length > 0 ? { ok: true, context } : { ok: true }
}
