/**
 * The bundled Vietnamese/Chinese language pack, Simplified script
 * (`@sqrdao/live-translate/lang/vi-zh`).
 */

import { ZH, SIMPLIFIED_CLAUSE, isHanDominant, withoutHan } from './chinese.js'
import { EN_STOPWORDS, tokenize } from './english.js'
import { detectOutputLanguage } from './en-vi.js'
import type { LangTag, LanguagePack } from './types.js'
import { VI, VI_LETTERS } from './vietnamese.js'

export { VI, ZH }

/**
 * Classifies a text as Chinese, Vietnamese, or neither.
 *
 * The two scripts do not overlap, so this is simpler than EN/VI: Chinese by
 * Han (`isHanDominant`, checked first so a Chinese line quoting "Đà Nẵng"
 * stays Chinese), Vietnamese when at least half the non-Han tokens carry a
 * Vietnamese letter and they outnumber English function words. Undiacriticized
 * text — a romanized name, digits, an English product name — abstains.
 *
 * English is not in this pair, but the model writes it anyway (see `viZh`),
 * and English quoting a Vietnamese place ("Welcome to Đà Nẵng") must not read
 * as Vietnamese: the merge would veto it as an echo and drop the speaker's
 * caption, where abstaining lets `detectOutput` drop only the translation.
 * The function-word guard is the same one `detectEnVi` applies.
 */
export function detectViZh(text: string): LangTag | null {
  if (isHanDominant(text)) return ZH

  const tokens = tokenize(withoutHan(text)).filter((token) => token.length > 1)
  const viTokens = tokens.filter((token) => VI_LETTERS.test(token)).length
  const enTokens = tokens.filter((token) => EN_STOPWORDS.has(token)).length
  if (viTokens > 0 && viTokens * 2 >= tokens.length && viTokens > enTokens) return VI

  return null
}

/**
 * PROBED 2026-09-29 against `gemini-3.5-live-translate-preview`, in the
 * browser with synthesized speech:
 *   * Chinese speech, Auto: the vi session translates into Vietnamese and the
 *     zh session stays silent, the same shape as EN/VI.
 *   * Vietnamese speech, Auto: the zh session translates into **English**,
 *     not Chinese. Adding "Never respond in English." to the instruction did
 *     not change it, so the clause is not pinned.
 *   * Vietnamese speech, declared VI→ZH: correct Simplified Chinese.
 * `detectOutput` drops the English translation, so Auto shows the Vietnamese
 * caption untranslated rather than wrong; a VI/ZH feed with Vietnamese
 * speakers should still declare the direction to get Chinese at all.
 */
export const viZh: LanguagePack = {
  pair: [VI, ZH],
  names: { [VI]: 'Vietnamese', [ZH]: 'Chinese' },
  detect: detectViZh,
  detectOutput: detectOutputLanguage,
  instructionClauses: ['Preserve Vietnamese diacritics exactly.', SIMPLIFIED_CLAUSE],
}
