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
 * Shared by `api/token.ts`, the reference host's Express server AND the
 * reference page (for its limits and its "what will be used" summary), so the
 * three cannot disagree. This is the one place that trims, drops blanks,
 * dedupes and caps: the page only splits its textareas into lines and sends.
 * The `_` prefix keeps Vercel from deploying this file as an endpoint.
 *
 * The policy (2026-10-17, revised in review the same day):
 *
 *   * Wrong SHAPE is a 400 — a number where a string belongs is a broken
 *     client, and minting past it would hide the bug. So is a raw payload past
 *     `CONTEXT_CEILING`: that is a dump, not a programme.
 *   * An over-long NAME (glossary entry, speaker) is DROPPED, never cut. The
 *     instruction says "Reproduce these names exactly as written", and half a
 *     name reproduced exactly is a wrong name the model was told to insist on.
 *   * An over-long TITLE (sessionTitle, eventName) is cut at a word boundary
 *     (a hard cut only when there is no space, as in CJK). It is framing, not
 *     a thing to reproduce, so most of it beats none of it.
 *   * Lists past their count keep the first entries. An operator who pastes a
 *     fifty-first name mid-event gets a feed with fifty, not a mic that will
 *     not start; the page says which entries are not used.
 *
 * Every piece lands inside a delimited clause in `buildLiveSessionConfig`, so
 * the delimiters are taken out of it: titles sit inside "…" and lose their
 * double quotes; glossary entries are joined with ", " and are split on
 * commas and semicolons here (a direct API client's "Messi, Álvarez" is two
 * names, not one that reads as two); speakers are joined with "; " and are
 * split on semicolons. Commas stay inside a speaker — "Name — Org, Title".
 */

import type { LiveSessionContext } from '../src/gemini/config.js'

/** Code points, so a limit never splits a surrogate pair. */
export const CONTEXT_LIMITS = {
  title: 120,
  speakers: 10,
  speaker: 120,
  glossary: 50,
  term: 60,
} as const

/** Past these, the raw request is refused before any cleaning runs. */
export const CONTEXT_CEILING = { chars: 10_000, items: 1_000 } as const

/** Over-long or over-count entries that will not reach the instruction. */
export interface ContextDropped {
  speakers: number
  glossary: number
}

export type ContextReading =
  | { ok: true; context?: LiveSessionContext; dropped: ContextDropped }
  | { ok: false; error: string }

// Line-breaking controls become a space: they separate words. C0/C1 controls
// (newline and tab among them — every field is one line of the instruction)
// and the Unicode line and paragraph separators.
const BREAKING = /[\p{Cc}\u{2028}\u{2029}]/gu
// Invisible format characters are removed outright: they sit INSIDE words
// ("Ál" U+00AD "varez"), so a space would split the name. Zero-width
// space/joiners and LRM/RLM, the bidi embeddings, overrides and isolates
// (which can make an instruction read differently from how it displays), the
// Arabic letter mark, the word joiner and invisible operators, the soft
// hyphen and the BOM.
const INVISIBLE = /[\u{00AD}\u{061C}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}]/gu

const length = (text: string) => Array.from(text).length

/** One line: invisibles removed, breaks become spaces, runs collapse, ends trimmed. */
function line(value: string): string {
  return value.replace(INVISIBLE, '').replace(BREAKING, ' ').replace(/\s+/g, ' ').trim()
}

/** A title: no double quotes (it is quoted in the clause), cut at a word boundary. */
function title(value: string): string {
  const text = line(value.replace(/["“”„]/g, "'"))
  const points = Array.from(text)
  if (points.length <= CONTEXT_LIMITS.title) return text
  const cut = points.slice(0, CONTEXT_LIMITS.title).join('')
  // Cut mid-word only when the next character is not already a boundary.
  if (/\s/.test(points[CONTEXT_LIMITS.title]!)) return cut.trimEnd()
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd()
}

function tooBig(value: unknown): boolean {
  if (typeof value === 'string') return value.length > CONTEXT_CEILING.chars
  if (Array.isArray(value)) {
    return value.length > CONTEXT_CEILING.items || value.reduce((sum: number, item) => sum + (typeof item === 'string' ? item.length : 0), 0) > CONTEXT_CEILING.chars
  }
  return false
}

function readTitle(value: unknown, field: string): { ok: true; text?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'string') return { ok: false, error: `context.${field} must be a string` }
  const text = title(value)
  return text ? { ok: true, text } : { ok: true }
}

function readList(
  value: unknown,
  field: string,
  split: RegExp,
  count: number,
  max: number,
): { ok: true; list?: string[]; dropped: number } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, dropped: 0 }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return { ok: false, error: `context.${field} must be an array of strings` }
  }
  const entries = value.flatMap((item) => item.split(split)).map(line).filter(Boolean)
  // Blanks and repeats go BEFORE the count, so padding never costs a real
  // entry; repeats are not counted as dropped, since nothing is lost.
  const fitting = [...new Set(entries)]
  const kept = fitting.filter((entry) => length(entry) <= max)
  const list = kept.slice(0, count)
  const dropped = fitting.length - list.length
  return list.length > 0 ? { ok: true, list, dropped } : { ok: true, dropped }
}

/**
 * The bounded context, or none, plus how many entries were not used.
 *
 * "None" is load-bearing: `buildLiveSessionConfig` adds a hesitation clause
 * whenever a context object is present, even an empty one, so a page that
 * sends four blank fields must get `context` omitted — not `{}` — or its
 * instruction (and so what its token authorizes) differs from a page that
 * sent nothing.
 */
export function readSessionContext(value: unknown): ContextReading {
  if (value === undefined || value === null) return { ok: true, dropped: { speakers: 0, glossary: 0 } }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'context must be an object' }
  const raw = value as Record<string, unknown>
  for (const field of ['sessionTitle', 'eventName', 'speakers', 'glossary']) {
    if (tooBig(raw[field])) return { ok: false, error: `context.${field} is too large` }
  }

  const sessionTitle = readTitle(raw['sessionTitle'], 'sessionTitle')
  if (!sessionTitle.ok) return sessionTitle
  const eventName = readTitle(raw['eventName'], 'eventName')
  if (!eventName.ok) return eventName
  const speakers = readList(raw['speakers'], 'speakers', /[;；]/, CONTEXT_LIMITS.speakers, CONTEXT_LIMITS.speaker)
  if (!speakers.ok) return speakers
  const glossary = readList(raw['glossary'], 'glossary', /[,;，、；]/, CONTEXT_LIMITS.glossary, CONTEXT_LIMITS.term)
  if (!glossary.ok) return glossary

  const context: LiveSessionContext = {
    ...(sessionTitle.text ? { sessionTitle: sessionTitle.text } : {}),
    ...(eventName.text ? { eventName: eventName.text } : {}),
    ...(speakers.list ? { speakers: speakers.list } : {}),
    ...(glossary.list ? { glossary: glossary.list } : {}),
  }
  const dropped = { speakers: speakers.dropped, glossary: glossary.dropped }
  return Object.keys(context).length > 0 ? { ok: true, context, dropped } : { ok: true, dropped }
}
