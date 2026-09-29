/**
 * The bundled Vietnamese/Chinese language pack, Simplified script
 * (`@sqrdao/live-translate/lang/vi-zh`).
 */

import { ZH, SIMPLIFIED_CLAUSE, isHanDominant, withoutHan } from './chinese.js'
import { tokenize } from './english.js'
import type { LangTag, LanguagePack } from './types.js'
import { VI, VI_LETTERS } from './vietnamese.js'

export { VI, ZH }

/**
 * Classifies a text as Chinese, Vietnamese, or neither.
 *
 * The two scripts do not overlap, so this is simpler than EN/VI: Chinese by
 * Han (`isHanDominant`, checked first so a Chinese line quoting "Đà Nẵng"
 * stays Chinese), Vietnamese when at least half the non-Han tokens carry a
 * Vietnamese letter. Undiacriticized text — a romanized name, digits, an
 * English product name — abstains.
 */
export function detectViZh(text: string): LangTag | null {
  if (isHanDominant(text)) return ZH

  const tokens = tokenize(withoutHan(text)).filter((token) => token.length > 1)
  const viTokens = tokens.filter((token) => VI_LETTERS.test(token)).length
  if (viTokens > 0 && viTokens * 2 >= tokens.length) return VI

  return null
}

export const viZh: LanguagePack = {
  pair: [VI, ZH],
  names: { [VI]: 'Vietnamese', [ZH]: 'Chinese' },
  detect: detectViZh,
  instructionClauses: ['Preserve Vietnamese diacritics exactly.', SIMPLIFIED_CLAUSE],
}
