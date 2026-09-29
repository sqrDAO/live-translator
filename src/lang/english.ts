/**
 * English evidence shared by the packs that pair English with another
 * language. Internal: each pack's detector decides how to weigh it against
 * its partner's script, so none of this is a detector on its own.
 */

import type { LangTag } from './types.js'

export const EN: LangTag = 'en'

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
export const EN_STOPWORDS = new Set([
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
 * English inflection and derivation, as suffixes.
 *
 * Failing the Vietnamese syllable acceptor says only "not Vietnamese", which two
 * romanized proper nouns satisfy as readily as two English words — and a pair
 * of names is exactly the text this detector is supposed to abstain on. So
 * the second route asks for one positive sign of English morphology as well.
 * "Solana validators" and "Transaction throughput matters" carry one;
 * "Blockchain Summit" and "Karaoke karaoke" do not, and go on abstaining.
 *
 * The four-letter floor keeps the short suffixes from matching what is really
 * a stem: `-er` must not fire on "her", `-ed` on "red", `-s` on "is".
 */
export const EN_MORPHOLOGY = /^.{2,}(?:ing|tion|sion|ment|ness|able|ible|ance|ence|ship|hood|ward|ally|ies|ers|ors|ist|ism|ity|ive|ous|ly|ed|er|or|s)$/u

/** Lower-cased, NFC-normalized letter/digit runs; punctuation splits. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}
