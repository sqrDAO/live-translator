/**
 * The language layer.
 *
 * The engine runs exactly two Gemini Live sessions, one per target language,
 * and decides per utterance which of the two the speaker used. Nothing in
 * `src/transcript` or `src/session` names a language: the pair, the display
 * names and the text classifier are all supplied by a `LanguagePack`, and the
 * bundled EN/VI one lives in `./en-vi` (exported as
 * `@sqrdao/live-translate/lang/en-vi`), not in core.
 */

/** A language tag as the host and the model agree on it: `'en'`, `'vi'`, `'ko'`… */
export type LangTag = string

/**
 * The two languages a feed interprets between, in a fixed order.
 *
 * The order is part of the pinned session instruction ("a bilingual
 * English/Vietnamese event"), so it is a tuple, not a set.
 */
export type LanguagePair = readonly [LangTag, LangTag]

/** Display names, in the language the model is instructed in. */
export type LanguageNames = Readonly<Record<LangTag, string>>

/**
 * Classifies a text as one of the pair's languages, or abstains.
 *
 * `null` means abstain, and an abstention must leave behavior exactly as if
 * no detector had been consulted: the merge then falls through to behavioral
 * echo-versus-translation inference. A detector must never answer a tag
 * outside its pair.
 */
export type LanguageDetector = (text: string) => LangTag | null

/**
 * Everything the engine needs to know about one language pair.
 *
 * `instructionClauses` are appended to the pinned session instruction, after
 * the generic ones — the place for script-specific orders such as "preserve
 * diacritics". They are part of what the ephemeral token authorizes, so a
 * pack must not change them casually.
 */
export interface LanguagePack {
  readonly pair: LanguagePair
  readonly names: LanguageNames
  readonly detect: LanguageDetector
  readonly instructionClauses?: readonly string[]
}

/** The other member of the pair. Throws on a tag outside the pair. */
export function otherOf(pair: LanguagePair, lang: LangTag): LangTag {
  if (lang === pair[0]) return pair[1]
  if (lang === pair[1]) return pair[0]
  throw new Error(`language ${JSON.stringify(lang)} is not in the pair ${JSON.stringify(pair)}`)
}

/** Guards a configured pair before anything is built on it. */
export function assertLanguagePair(pair: LanguagePair): void {
  const [a, b] = pair
  if (!a || !b) throw new Error('a language pair needs two non-empty tags')
  if (a === b) throw new Error(`a language pair needs two distinct tags, got ${JSON.stringify(a)} twice`)
}
