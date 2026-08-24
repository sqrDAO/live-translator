/**
 * The bundled English/Vietnamese language pack.
 *
 * The detector is the one that shipped in production, moved here verbatim
 * from the transcript merge. It is deliberately a separate entry point
 * (`@sqrdao/live-translate/lang/en-vi`): another pair needs a different
 * classifier, and core must not carry this one's letter class and stopword
 * list as if they were general.
 */

import type { LangTag, LanguagePack } from './types.js'

export const EN: LangTag = 'en'
export const VI: LangTag = 'vi'

/** Any Vietnamese-specific letter (đ, breve/circumflex/horn vowels, tone marks). */
const VI_LETTERS =
  /[ăâđêôơưàảãáạằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ]/u

/**
 * Common English function words.
 *
 * A hit is required before ASCII-only text may be called English through this
 * route, so romanized names and numbers abstain instead. The list is
 * deliberately closed-class: content words belong to the syllable route
 * below, which does not need a vocabulary.
 *
 * Widened 2026-08-24 (fix-english-source-detection) after measuring the old
 * list against real conference fragments: "Good morning", "Next slide
 * please", "Any questions" and "Let's start" all abstained, and every
 * abstention landed on a source-language inference that was itself broken.
 * Only words that are not also plausible bare Vietnamese syllables were
 * added — the short ambiguous ones ('to', 'do', 'in', 'so') were already
 * here and are left as they were.
 */
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'am', 'i', 'you', 'we', 'they', 'he', 'she', 'it', 'this', 'that',
  'these', 'those', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'as', 'so', 'if', 'then', 'than', 'not', 'no', 'yes', 'do', 'does', 'did',
  'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'what',
  'when', 'where', 'who', 'how', 'why', 'there', 'here', 'my', 'your', 'our',
  'their', 'his', 'her', 'its', 'me', 'us', 'them', 'about', 'all', 'very',
  'just', 'now', 'today', 'thank', 'thanks', 'hello', 'welcome', 'everyone',
  's', 't', 're', 've', 'll', 'd',
  // Added 2026-08-24.
  'let', 'please', 'next', 'more', 'most', 'some', 'any', 'every', 'other',
  'another', 'much', 'many', 'few', 'first', 'second', 'because', 'while',
  'which', 'whose', 'whom', 'being', 'may', 'might', 'must', 'shall',
  'going', 'want', 'need', 'know', 'think', 'said', 'says', 'see', 'look',
  'make', 'made', 'take', 'get', 'give', 'come', 'good', 'great', 'right',
  'through', 'during', 'without', 'within', 'into', 'onto', 'over', 'under',
  'again', 'still', 'even', 'also', 'both', 'each', 'such', 'same', 'own',
  'too', 'well', 'back', 'down', 'out', 'off', 'up', 'okay', 'sure',
  'really', 'actually', 'maybe', 'everybody', 'something', 'nothing',
])

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

function isVietnameseSyllable(token: string): boolean {
  return VI_SYLLABLE.test(token)
}

/**
 * English inflection and derivation, as suffixes.
 *
 * Failing the Vietnamese acceptor above says only "not Vietnamese", which two
 * romanized proper nouns satisfy as readily as two English words — and a pair
 * of names is exactly the text this detector is supposed to abstain on. So
 * the second route asks for one positive sign of English morphology as well.
 * "Solana validators" and "Transaction throughput matters" carry one;
 * "Blockchain Summit" and "Karaoke karaoke" do not, and go on abstaining.
 *
 * The four-letter floor keeps the short suffixes from matching what is really
 * a stem: `-er` must not fire on "her", `-ed` on "red", `-s` on "is".
 */
const EN_MORPHOLOGY = /^.{2,}(?:ing|tion|sion|ment|ness|able|ible|ance|ence|ship|hood|ward|ally|ies|ers|ors|ist|ism|ity|ive|ous|ly|ed|er|or|s)$/u

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

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
 * The pack the production feed ran with. The instruction clause is pinned
 * into every EN/VI ephemeral token, so its wording is load-bearing: the
 * config test holds the whole instruction byte-for-byte against what shipped.
 */
export const enVi: LanguagePack = {
  pair: [EN, VI],
  names: { [EN]: 'English', [VI]: 'Vietnamese' },
  detect: detectEnVi,
  instructionClauses: ['Preserve Vietnamese diacritics exactly.'],
}
