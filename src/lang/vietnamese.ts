/**
 * Vietnamese evidence shared by the packs that include Vietnamese. Internal:
 * each pack's detector decides how to weigh it against its partner's script.
 */

import type { LangTag } from './types.js'

export const VI: LangTag = 'vi'

/** Any Vietnamese-specific letter (đ, breve/circumflex/horn vowels, tone marks). */
export const VI_LETTERS =
  /[ăâđêôơưàảãáạằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ]/u

/**
 * Vietnamese syllable structure, as an acceptor.
 *
 * Vietnamese is monosyllabic and written one syllable per token, and the
 * syllable is a small closed grammar: an optional onset from a fixed
 * inventory, one to three vowels, an optional coda from a fixed inventory of
 * eight. Nothing else occurs — no consonant clusters after the onset, no
 * codas in `b d g k l r s v`, and no `f j w z` anywhere in the alphabet.
 *
 * A token this rejects is therefore not a Vietnamese word, whatever else it
 * may be. That is the negative evidence the detector was missing: it could
 * recognise Vietnamese by its diacritics, but it could only recognise English
 * by a closed-class function word, so content-word English — "Solana
 * validators", "Smart contract deployment", "Transaction throughput matters"
 * — abstained. Every one of those tokens fails this acceptor.
 *
 * The onset alternation is ordered longest-first so `ngh` wins over `ng` and
 * `ng` over `n`; `gi`/`qu` fall back to the bare consonant when no vowel
 * follows, which is what keeps "gì" and "quý" accepted.
 */
const VI_VOWELS = 'aàảãáạăằẳẵắặâầẩẫấậeèẻẽéẹêềểễếệiìỉĩíịoòỏõóọôồổỗốộơờởỡớợuùủũúụưừửữứựyỳỷỹýỵ'
const VI_SYLLABLE = new RegExp(
  `^(?:ngh|ng|nh|ch|gh|gi|kh|ph|th|tr|qu|[bcdđghklmnpqrstvx])?[${VI_VOWELS}]{1,3}(?:ch|ng|nh|[cmnpt])?$`,
  'u',
)

export function isVietnameseSyllable(token: string): boolean {
  return VI_SYLLABLE.test(token)
}
