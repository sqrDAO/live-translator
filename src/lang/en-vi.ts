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
 * Common English function words. A hit is required before ASCII-only text may
 * be called English, so romanized names and numbers abstain instead.
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
])

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
 * more of them than English function-word hits; English needs at least one
 * function-word hit. Everything else — digits, proper nouns, romanized
 * fragments — abstains (`null`), and an abstention must leave the caller's
 * behavior exactly as it was.
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
  return enTokens > 0 ? EN : null
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
