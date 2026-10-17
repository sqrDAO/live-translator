/**
 * Collapses a speaker's stutter: the same word said several times in a row.
 *
 * Probed 2026-10-17 (collapse-stutter): `gemini-3.5-live-translate-preview`
 * transcribes verbatim whatever `inputAudioTranscription` asks for — the
 * schema's `mode: 'SMART'` disfluency removal is validated by the token mint
 * and then ignored on both the constrained and the plain socket — and it
 * translates each repetition as a word: "rơi vào cái, cái, cái, cái sự ép
 * lớn" became "the, the, the, the big pressure". The instruction clause
 * against translating fillers did not move it either. The wall reads the
 * text, so the cleanup happens here, on the text.
 *
 * Two rules, because doubling is grammar in some languages and noise in
 * others:
 *   * a run of three or more of the same word keeps one, in any language;
 *   * a pair keeps one only for the words a pack names as fillers. A
 *     Vietnamese pair is often reduplication that carries meaning ("từ từ",
 *     "đi đi"), so only the pack can say which pairs are stutter ("cái cái").
 *
 * Words in a run may be separated by whitespace and commas — the model writes
 * a stutter both ways — but never by a sentence boundary, so "Go. Go. Go."
 * is three sentences, not a stutter. Han text has no spaces between words and
 * is left exactly as it is.
 */

/** A word: letters with their combining marks and inner apostrophes. */
const WORD = /\p{L}[\p{L}\p{M}'’]*/gu

/** What may sit between two words of one run. */
const RUN_GAP = /^[\s,]+$/u

/** Shortest run collapsed whatever the word. */
const MIN_RUN = 3

function key(word: string): string {
  return word.normalize('NFC').toLocaleLowerCase()
}

/**
 * `fillers` are compared case-insensitively and must be given lower-case and
 * NFC, as `LanguagePack.fillerWords` declares them.
 */
export function collapseStutter(text: string, fillers: ReadonlySet<string> = new Set()): string {
  const words = [...text.matchAll(WORD)]
  if (words.length < 2) return text

  let out = ''
  let cursor = 0
  let i = 0
  while (i < words.length) {
    const head = words[i]!
    const headKey = key(head[0])
    let end = i
    while (end + 1 < words.length) {
      const prev = words[end]!
      const next = words[end + 1]!
      const gap = text.slice(prev.index + prev[0].length, next.index)
      if (!RUN_GAP.test(gap) || key(next[0]) !== headKey) break
      end++
    }
    const length = end - i + 1
    if (length >= MIN_RUN || (length === 2 && fillers.has(headKey))) {
      // Keep the first word as spoken and whatever followed the last one.
      const last = words[end]!
      out += text.slice(cursor, head.index + head[0].length)
      cursor = last.index + last[0].length
    }
    i = end + 1
  }
  return out + text.slice(cursor)
}
