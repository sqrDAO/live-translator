/**
 * The bundled English/Vietnamese language pack.
 *
 * The detector is the one that shipped in production, moved here verbatim
 * from the transcript merge. It is deliberately a separate entry point
 * (`@sqrdao/live-translate/lang/en-vi`): another pair needs a different
 * classifier, and core must not carry this one's letter class and stopword
 * list as if they were general.
 */

import { ZH, isHanDominant } from './chinese.js'
import { EN, EN_MORPHOLOGY, EN_STOPWORDS, tokenize } from './english.js'
import type { LangTag, LanguagePack } from './types.js'
import { VI, VI_LETTERS, isVietnameseSyllable } from './vietnamese.js'

export { EN, VI }

/**
 * Classifies a text as Vietnamese, English, or neither, on proportional
 * evidence per token.
 *
 * A single Vietnamese letter must NOT decide 'vi': Gemini is instructed to
 * preserve diacritics, so a correct English line quoting a Vietnamese proper
 * noun ("Welcome to Đà Nẵng", "the CEO of the bank in Hà Nội") carries them
 * routinely, and 'café'/'José' land in the same letter class. Vietnamese
 * therefore needs at least half the tokens carrying Vietnamese letters AND
 * more of them than English function-word hits.
 *
 * English is then claimed by either of two routes: a function-word hit, or —
 * added 2026-08-24, fix-english-source-detection — a text whose every letter
 * token is impossible as a Vietnamese syllable AND which carries English
 * morphology somewhere. The second route is what finally reads content-word
 * English, which a closed-class list cannot; both of its conditions are
 * needed, since "not Vietnamese" alone is true of any two romanized names.
 *
 * Everything else abstains (`null`) — digits, a lone proper noun
 * ("Techcombank 2026"), a pair of them ("Blockchain Summit"), romanized
 * fragments — and an abstention must leave the caller's behavior exactly as
 * it was. Undiacriticized Vietnamese abstains too unless one of its
 * syllables collides with a short English function word ("an", "so"), which
 * the pinned "preserve diacritics" instruction makes an out-of-distribution
 * input rather than one worth a heuristic.
 *
 * Single-letter tokens are excluded from the evidence: a label letter
 * ("Phòng A") is not the English article, and a contraction fragment
 * ("that's" → "s") always arrives with its host word.
 */
export function detectEnVi(text: string): LangTag | null {
  const tokens = tokenize(text).filter((token) => token.length > 1)
  if (tokens.length === 0) return null
  const viTokens = tokens.filter((token) => VI_LETTERS.test(token)).length
  const enTokens = tokens.filter((token) => EN_STOPWORDS.has(token)).length
  if (viTokens * 2 >= tokens.length && viTokens > enTokens) return VI
  if (enTokens > 0) return EN

  // Digits carry no evidence in either direction, so they neither support the
  // verdict nor block it — "Blockchain Summit 2026" is decided by its two
  // words.
  const words = tokens.filter((token) => /\p{L}/u.test(token))
  if (
    words.length >= 2 &&
    words.every((word) => !isVietnameseSyllable(word)) &&
    words.some((word) => EN_MORPHOLOGY.test(word))
  ) {
    return EN
  }

  return null
}

/**
 * The bundled packs' output classifier, over all three bundled languages:
 * Chinese by script, then English or Vietnamese as `detectEnVi` reads them.
 *
 * Probed 2026-09-29: in a VI/ZH feed on Auto, the zh-target session answered
 * Vietnamese speech in English. The pair's own detector abstains on English,
 * so only a classifier that knows a language outside the pair can reject it.
 */
export function detectOutputLanguage(text: string): LangTag | null {
  return isHanDominant(text) ? ZH : detectEnVi(text)
}

/**
 * The pack the production feed ran with. The instruction clause is pinned
 * into every EN/VI ephemeral token, so its wording is load-bearing: the
 * config test holds the whole instruction byte-for-byte against what shipped.
 */
export const enVi: LanguagePack = {
  pair: [EN, VI],
  names: { [EN]: 'English', [VI]: 'Vietnamese' },
  detect: detectEnVi,
  detectOutput: detectOutputLanguage,
  instructionClauses: ['Preserve Vietnamese diacritics exactly.'],
}
