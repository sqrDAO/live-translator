/**
 * Chinese evidence shared by the packs that include Chinese. Internal: each
 * pack's detector decides what to do with the text that is not Han.
 *
 * The packs interpret Mandarin speech and write Simplified Chinese, under the
 * tag `'zh'`. Traditional output would need its own tag and clause, not a
 * flag on these packs: the clause is pinned into every minted token.
 */

import type { LangTag } from './types.js'

export const ZH: LangTag = 'zh'

/** Pinned into every token a Chinese pack mints; its wording is load-bearing. */
export const SIMPLIFIED_CLAUSE = 'Write Chinese in Simplified characters only, never Traditional.'

const HAN = /\p{Script=Han}/gu
const LATIN_WORD = /\p{Script=Latin}+/gu

/** The text with every Han character replaced by a space. */
export function withoutHan(text: string): string {
  return text.replace(HAN, ' ')
}

/**
 * Whether Han characters carry the text.
 *
 * Chinese is written without spaces, so it cannot be counted in whitespace
 * tokens the way English and Vietnamese are: a whole clause is one "token".
 * Each Han character is counted instead, weighed against Latin words. A
 * Chinese word runs about two characters, so Han must outnumber Latin words
 * two to one — enough that a Chinese line quoting a product name ("我们在
 * Solana 上部署") is Chinese, and an English line that kept a Chinese name
 * ("Welcome to 北京") is not.
 *
 * One Han character with nothing else is Chinese: neither English nor
 * Vietnamese output carries Han, so it is strong evidence on its own.
 */
export function isHanDominant(text: string): boolean {
  const han = text.match(HAN)?.length ?? 0
  if (han === 0) return false
  const latinWords = withoutHan(text).match(LATIN_WORD)?.length ?? 0
  return han >= latinWords * 2
}
