import { describe, expect, it } from 'vitest'

import { detectEnVi, enVi } from '../src/lang/en-vi'
import type { LangTag, LanguagePack } from '../src/lang/types'
import {
  UtteranceMerger,
  countSentences,
  inferSourceLanguage,
  type IncomingFragment,
} from '../src/transcript/merge'

const now = 1_760_000_000_000

/** A merger with the bundled EN/VI pack injected — the production behavior. */
function merger(options: { minCharacters?: number; forcedSourceLang?: string } = {}) {
  return new UtteranceMerger({ pair: enVi.pair, detect: enVi.detect, ...options })
}

describe('the EN/VI detector', () => {
  it('classifies on per-token evidence, abstaining on digits and names', () => {
    expect(detectEnVi('vào đấy đấy.')).toBe('vi')
    expect(detectEnVi("That's it.")).toBe('en')
    expect(detectEnVi('1 2 3 4')).toBeNull()
    expect(detectEnVi('Techcombank 2026')).toBeNull()
    expect(detectEnVi('')).toBeNull()
  })

  it('reads content-word English, which no function-word list can', () => {
    // The complaint that started this: English without a function word
    // abstained, and every abstention fell through to a source-language
    // inference that was itself inverted. None of these carry one.
    expect(detectEnVi('Solana validators')).toBe('en')
    expect(detectEnVi('Smart contract deployment')).toBe('en')
    expect(detectEnVi('Transaction throughput matters')).toBe('en')
    expect(detectEnVi('sqrDAO builds developer tools')).toBe('en')
  })

  it('needs English morphology, not merely the absence of Vietnamese', () => {
    // Two romanized names are not Vietnamese either, and calling them English
    // would put a proper-noun caption on the wrong side of the same-language
    // veto. They abstain, and behavioral inference decides instead.
    expect(detectEnVi('Blockchain Summit')).toBeNull()
    expect(detectEnVi('Karaoke karaoke')).toBeNull()
    expect(detectEnVi('Da Nang 2026')).toBeNull()
  })

  it('still reads Vietnamese, including a line thick with English loanwords', () => {
    expect(detectEnVi('Chào buổi sáng mọi người')).toBe('vi')
    expect(detectEnVi('Trình xác thực Solana')).toBe('vi')
    expect(detectEnVi('Blockchain là một công nghệ sổ cái phân tán')).toBe('vi')
  })

  it('does not let a Vietnamese proper noun flip an English line', () => {
    // The prompt orders diacritics preserved, so correct English lines
    // routinely carry Vietnamese names; any-single-diacritic detection called
    // these 'vi', tripped the same-language veto, and deleted the correct line.
    expect(detectEnVi('Welcome to Đà Nẵng')).toBe('en')
    expect(detectEnVi('the CEO of the bank in Hà Nội')).toBe('en')
    expect(detectEnVi('Chào mừng đến Đà Nẵng')).toBe('vi')
  })
})

describe('source-language inference and fragment merge', () => {
  it('infers the source language from the output transcription, not the input', () => {
    const source = inferSourceLanguage(
      [
        { utteranceId: 'u1', targetLang: 'vi', originalText: 'Hello', translatedText: 'Xin chào', final: false, receivedAt: now },
        { utteranceId: 'u1', targetLang: 'en', originalText: 'Hello', translatedText: 'Hello', final: false, receivedAt: now },
      ],
      enVi.pair,
    )
    expect(source).toBe('en')
  })

  it('accumulates delta fragments from one session into one segment', () => {
    const m = merger()
    m.add({ utteranceId: 'u1', targetLang: 'vi', originalText: 'Good morning', translatedText: 'Chào buổi sáng', final: false, receivedAt: now })
    const merged = m.add({
      utteranceId: 'u1',
      targetLang: 'vi',
      originalText: ' everyone',
      translatedText: ' mọi người',
      final: true,
      receivedAt: now + 200,
    })
    expect(merged).not.toBeNull()
    expect(merged!.original).toBe('Good morning everyone')
    expect(merged!.translated).toBe('Chào buổi sáng mọi người')
    expect(merged!.final).toBe(true)
  })

  it('drops a phantom fragment that carries no intelligible original', () => {
    const merged = merger({ minCharacters: 3 }).add({
      utteranceId: 'u1',
      targetLang: 'vi',
      originalText: 'a',
      final: false,
      receivedAt: now,
    })
    expect(merged).toBeNull()
  })

  it('labels a segment by its text when it contradicts the behavioral inference', () => {
    // The vi-target session heard Vietnamese but answered in English — a flip.
    // Echo-vs-translation inference concludes English; the transcript decides.
    const merged = merger().add({
      utteranceId: 'u15',
      targetLang: 'vi',
      originalText: 'vào đấy đấy.',
      translatedText: "That's it.",
      final: false,
      receivedAt: now,
    })
    expect(merged).not.toBeNull()
    expect(merged!.sourceLang).toBe('vi')
    expect(merged!.translated).toBe("That's it.")
  })

  it('never publishes a pair that reads as one language on both lines', () => {
    const merged = merger().add({
      utteranceId: 'u1',
      targetLang: 'vi',
      originalText: 'The market is growing quickly',
      translatedText: 'Revenue was very strong this year',
      final: false,
      receivedAt: now,
    })
    expect(merged).toBeNull()
  })

  it('selects the correct session\'s pair when inference alone would pick the wrong one', () => {
    const m = merger()
    m.add({
      utteranceId: 'u1',
      targetLang: 'vi',
      originalText: 'Chúng ta ở Đà Nẵng',
      translatedText: 'We are in Da Nang city now',
      final: false,
      receivedAt: now,
    })
    const merged = m.add({
      utteranceId: 'u1',
      targetLang: 'en',
      originalText: 'Chúng ta ở Đà Nẵng',
      translatedText: 'We are in Đà Nẵng',
      final: false,
      receivedAt: now + 10,
    })
    // Inference alone reads the en session as the passthrough and would label
    // the speaker 'en'; deciding source from the transcript first outranks it.
    expect(
      inferSourceLanguage(
        [
          { utteranceId: 'u1', targetLang: 'vi', originalText: 'Chúng ta ở Đà Nẵng', translatedText: 'We are in Da Nang city now', final: false, receivedAt: now },
          { utteranceId: 'u1', targetLang: 'en', originalText: 'Chúng ta ở Đà Nẵng', translatedText: 'We are in Đà Nẵng', final: false, receivedAt: now + 10 },
        ],
        enVi.pair,
      ),
    ).toBe('en')
    expect(merged!.sourceLang).toBe('vi')
    expect(merged!.translated).toBe('We are in Đà Nẵng')
  })

  it('a forced label outranks detection, but the same-language veto survives it', () => {
    const forced = merger({ forcedSourceLang: 'vi' })
    const merged = forced.add({
      utteranceId: 'u1',
      targetLang: 'en',
      originalText: 'Xin chào các bạn',
      translatedText: 'Hello friends',
      final: false,
      receivedAt: now,
    })
    expect(merged!.sourceLang).toBe('vi')
    expect(merged!.translated).toBe('Hello friends')

    const echo = merger({ forcedSourceLang: 'vi' }).add({
      utteranceId: 'u1',
      targetLang: 'en',
      originalText: 'Hello everyone',
      translatedText: 'Hello everyone and welcome',
      final: false,
      receivedAt: now,
    })
    expect(echo).toBeNull()
  })

  it('counts only real sentence ends, guarding decimals', () => {
    expect(countSentences('One. Two. Three.')).toBe(3)
    expect(countSentences('About 1.5 to 2.5 and 3.5 seconds')).toBe(0)
  })
})

describe('the live protocol shape, as probed', () => {
  // PROBED 2026-08-24 against `gemini-3.5-live-translate-preview`, both
  // directions: the session whose target is the language being spoken emits
  // `inputTranscription` and NO output of any kind — not an echo, nothing.
  // Only the translating session produces output text. Every other fixture in
  // this file predates that measurement and models an echo instead, which is
  // why none of them caught the inversion below.
  const EN_SPEECH = { original: 'Solana validators', translated: 'Trình xác thực Solana' }
  const VI_SPEECH = { original: 'Chào buổi sáng mọi người', translated: 'Good morning everyone' }

  it('reads the silent session as the speaker\'s language, not as the hardest translator', () => {
    // The silent session scores zero token overlap, the bottom of the scale,
    // so ranking by overlap alone concluded the *opposite* of the truth: it
    // labelled English speech 'vi' because the vi session's translation
    // shared "Solana" with its own input and so scored above zero.
    expect(
      inferSourceLanguage(
        [
          { utteranceId: 'u1', targetLang: 'vi', originalText: EN_SPEECH.original, translatedText: EN_SPEECH.translated, final: false, receivedAt: now },
          { utteranceId: 'u1', targetLang: 'en', originalText: EN_SPEECH.original, final: false, receivedAt: now + 10 },
        ],
        enVi.pair,
      ),
    ).toBe('en')

    expect(
      inferSourceLanguage(
        [
          { utteranceId: 'u1', targetLang: 'en', originalText: VI_SPEECH.original, translatedText: VI_SPEECH.translated, final: false, receivedAt: now },
          { utteranceId: 'u1', targetLang: 'vi', originalText: VI_SPEECH.original, final: false, receivedAt: now + 10 },
        ],
        enVi.pair,
      ),
    ).toBe('vi')
  })

  it('publishes English speech the detector cannot name', () => {
    // "Solana validators" carries no English function word. Before the
    // inference was corrected this whole utterance was dropped: the label
    // came out 'vi', `build()` then looked for the translation among the
    // silent session's fragments, found none, and returned null.
    const m = merger()
    m.add({ utteranceId: 'u1', targetLang: 'vi', originalText: EN_SPEECH.original, translatedText: EN_SPEECH.translated, final: false, receivedAt: now })
    const merged = m.add({ utteranceId: 'u1', targetLang: 'en', originalText: EN_SPEECH.original, final: false, receivedAt: now + 10 })
    expect(merged).toMatchObject({ sourceLang: 'en', original: EN_SPEECH.original, translated: EN_SPEECH.translated })
  })

  it('publishes Vietnamese speech the same way, from the mirrored shape', () => {
    const m = merger()
    m.add({ utteranceId: 'u1', targetLang: 'en', originalText: VI_SPEECH.original, translatedText: VI_SPEECH.translated, final: false, receivedAt: now })
    const merged = m.add({ utteranceId: 'u1', targetLang: 'vi', originalText: VI_SPEECH.original, final: false, receivedAt: now + 10 })
    expect(merged).toMatchObject({ sourceLang: 'vi', original: VI_SPEECH.original, translated: VI_SPEECH.translated })
  })

  it('abstains while one session is silent and alone, rather than guessing', () => {
    // Silence is only the speaker's-language signature once the peer has
    // produced output. On its own it is equally a translating session whose
    // output has not landed, and nothing can be published under either label.
    expect(
      inferSourceLanguage(
        [{ utteranceId: 'u1', targetLang: 'en', originalText: EN_SPEECH.original, final: false, receivedAt: now }],
        enVi.pair,
      ),
    ).toBeNull()
  })

  it('falls through to inference when the two transcripts disagree', () => {
    // Both sessions transcribe the same audio; here the vi session mangles
    // Vietnamese speech into something that reads as English. Consulting it
    // first and taking the first non-null answer — the old rule — labelled
    // the speaker 'en' and the utterance was lost. A disagreement is not
    // evidence, so behaviour decides: the vi session is the silent one.
    const labels: Record<string, LangTag> = {
      'Chào buổi sáng': 'vi',
      'Good morning': 'en',
      'Chow boy sang': 'en',
    }
    const m = new UtteranceMerger({ pair: enVi.pair, detect: (text) => labels[text.trim()] ?? null })
    m.add({ utteranceId: 'u1', targetLang: 'en', originalText: 'Chào buổi sáng', translatedText: 'Good morning', final: false, receivedAt: now })
    const merged = m.add({ utteranceId: 'u1', targetLang: 'vi', originalText: 'Chow boy sang', final: false, receivedAt: now + 10 })
    expect(merged).toMatchObject({ sourceLang: 'vi', original: 'Chào buổi sáng', translated: 'Good morning' })
  })
})

describe('a third pair drives the merge without touching src/transcript', () => {
  // en/ko: a detector that recognises Hangul, EN function words, else abstains.
  const HANGUL = /[가-힣]/u
  const EN_WORDS = new Set(['the', 'is', 'we', 'are', 'in', 'hello', 'and', 'a', 'to'])
  const enKo: LanguagePack = {
    pair: ['en', 'ko'],
    names: { en: 'English', ko: 'Korean' },
    detect: (text) => {
      const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
      if (tokens.some((t) => HANGUL.test(t))) return 'ko'
      return tokens.some((t) => EN_WORDS.has(t.replace(/[^a-z]/g, ''))) ? 'en' : null
    },
  }

  function koMerger() {
    return new UtteranceMerger({ pair: enKo.pair, detect: enKo.detect })
  }

  it('merges, decides source and vetoes for en/ko exactly as for en/vi', () => {
    // EN speaker: the ko session translates, the en session echoes.
    const m = koMerger()
    m.add({ utteranceId: 'u1', targetLang: 'ko', originalText: 'Hello', translatedText: '안녕하세요', final: false, receivedAt: now })
    const merged = m.add({
      utteranceId: 'u1',
      targetLang: 'en',
      originalText: 'Hello',
      translatedText: 'Hello',
      final: true,
      receivedAt: now + 10,
    })
    expect(merged!.sourceLang).toBe('en')
    expect(merged!.original).toBe('Hello')
    expect(merged!.translated).toBe('안녕하세요')

    // The same-language veto still fires: two English lines is garbage.
    const vetoed = koMerger().add({
      utteranceId: 'u2',
      targetLang: 'ko',
      originalText: 'the market is here',
      translatedText: 'we are in the room',
      final: false,
      receivedAt: now,
    })
    expect(vetoed).toBeNull()
  })

  it('falls through to echo-vs-translation inference when the detector abstains', () => {
    // The detector below always abstains; behavior must be exactly as if none
    // were consulted, i.e. inference decides.
    const abstaining: LanguagePack = { pair: ['en', 'ko'], names: enKo.names, detect: () => null }
    const m = new UtteranceMerger({ pair: abstaining.pair, detect: abstaining.detect })
    m.add({ utteranceId: 'u1', targetLang: 'ko', originalText: 'Hello', translatedText: '안녕', final: false, receivedAt: now })
    const merged = m.add({
      utteranceId: 'u1',
      targetLang: 'en',
      originalText: 'Hello',
      translatedText: 'Hello',
      final: true,
      receivedAt: now + 10,
    })
    // en echoes (passthrough), ko translates → source is en.
    expect(merged!.sourceLang).toBe('en')
    expect(merged!.translated).toBe('안녕')
  })
})

// Compile-time guard: the fragment shape carries no app identifier.
const _shape: IncomingFragment = { utteranceId: 'u0', targetLang: 'en', final: false, receivedAt: 0 }
void _shape
