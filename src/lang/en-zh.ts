/**
 * The bundled English/Chinese language pack, Simplified script
 * (`@sqrdao/live-translate/lang/en-zh`).
 */

import { ZH, SIMPLIFIED_CLAUSE, isHanDominant, withoutHan } from './chinese.js'
import { EN, EN_MORPHOLOGY, EN_STOPWORDS, tokenize } from './english.js'
import type { LangTag, LanguagePack } from './types.js'

export { EN, ZH }

/**
 * Classifies a text as Chinese, English, or neither.
 *
 * Chinese is decided by script (`isHanDominant`). English then takes the same
 * two routes as in the EN/VI pack, read over the non-Han text only: a
 * function-word hit, or two or more words with English morphology somewhere.
 * The second route needs no "not a syllable of the partner" check here, as it
 * does against Vietnamese: pinyin syllables end in a vowel, `n`, `ng` or
 * `r`, and none is long enough to carry the suffixes `EN_MORPHOLOGY` accepts,
 * so a romanized Chinese name ("Zhang Wei", "Xiamen") abstains on its own.
 *
 * Single-letter tokens are excluded, as in EN/VI.
 */
export function detectEnZh(text: string): LangTag | null {
  if (isHanDominant(text)) return ZH

  const tokens = tokenize(withoutHan(text)).filter((token) => token.length > 1)
  if (tokens.some((token) => EN_STOPWORDS.has(token))) return EN

  const words = tokens.filter((token) => /\p{L}/u.test(token))
  if (words.length >= 2 && words.some((word) => EN_MORPHOLOGY.test(word))) return EN

  return null
}

export const enZh: LanguagePack = {
  pair: [EN, ZH],
  names: { [EN]: 'English', [ZH]: 'Chinese' },
  detect: detectEnZh,
  instructionClauses: [SIMPLIFIED_CLAUSE],
}
