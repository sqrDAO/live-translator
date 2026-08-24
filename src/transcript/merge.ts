/**
 * Fragment merging and the source-language decision.
 *
 * Pure and dependency-free: this is the logic the unit tests exercise
 * without a browser, a model or a store.
 *
 * The model emits incremental fragments for an in-progress utterance and marks
 * a turn complete when it finalizes. Two Live sessions run concurrently (one
 * per target language), so fragments for the same utterance arrive
 * interleaved from two sources and must be merged by utterance ID, not
 * appended in arrival order.
 *
 * Nothing here names a language. The pair and the text classifier come from
 * the configured `LanguagePack`; with the bundled EN/VI pack injected the
 * behavior is identical to the production feed's.
 *
 * Dropped in the port: `finalizeIdle()` (the losing half of an argument the
 * coordinator re-decided — idle retirement advances *both* target cursors,
 * which a per-utterance finalizer here could not), `trimRollingWindow()` and
 * `mayPublish()` (both mirror one host's store rules and live behind the
 * sink).
 */

import type { LangTag, LanguageDetector, LanguagePair } from '../lang/types.js'
import { otherOf } from '../lang/types.js'

export interface IncomingFragment {
  utteranceId: string
  /** Which Live session produced this fragment. */
  targetLang: LangTag
  /** Transcription of what was actually said. */
  originalText?: string
  /** Translation into `targetLang`. */
  translatedText?: string
  /** The model marked this turn complete. */
  final: boolean
  receivedAt: number
}

export interface MergedUtterance {
  utteranceId: string
  sourceLang: LangTag
  original: string
  translated: string
  final: boolean
  startedAt: number
  updatedAt: number
}

type Accumulated = Map<LangTag, { original: string; translated: string }>

/**
 * "Do not infer source language from the input transcript alone in
 * two-session mode."
 *
 * Both sessions transcribe the same audio, so the input transcript is identical
 * in both. What differs is the *output*: the session translating into the
 * second language produces a translation only when the speaker was not already
 * speaking it. The source language is therefore the target of whichever
 * session did the *least* translating.
 *
 * PROBED 2026-08-24 against `gemini-3.5-live-translate-preview`, both
 * directions, and the measured shape is stronger than the one this function
 * was written for: the same-language session does not echo, it says **nothing
 * at all**. On English speech the en-target session emits `inputTranscription`
 * and no output of any kind (91 frames, every `modelTurn` part silent audio);
 * on Vietnamese speech the vi-target session does the same. Only the
 * translating session ever produces output text.
 *
 * So silence is the discriminator, and ranking sessions by raw token overlap —
 * as this did — reads it exactly backwards: an empty translation scores 0,
 * the bottom of the scale, which labelled the session that stayed quiet as the
 * one that translated hardest. English speech was then attributed to the vi
 * session (whose translation shares proper nouns with its input, so it scored
 * *above* zero), `build()` went looking for the translation among the silent
 * session's fragments, found none, and published nothing at all
 * (fix-english-source-detection).
 */
export function inferSourceLanguage(
  fragments: IncomingFragment[],
  pair: LanguagePair,
  // Callers that already accumulated the per-target map pass it through so
  // one fragment does not cost two O(n) passes; the two-argument form stays
  // for the unit suite and any caller without one.
  accumulated?: Accumulated,
): LangTag | null {
  const byTarget = accumulated ?? accumulateByTarget(fragments)
  const [first, second] = pair

  const a = byTarget.get(first)
  const b = byTarget.get(second)
  if (!a && !b) return null

  // One session only: the normal case at the start of an utterance, before the
  // peer's first fragment lands, and the permanent case when one Live session
  // is degraded.
  if (!a || !b) {
    const only = a ?? b!
    const target: LangTag = a ? first : second
    // Silence alone decides nothing here. It is the signature of the
    // same-language session, but it is equally the signature of a translating
    // session whose output has not arrived yet, and one session cannot tell
    // those apart. Abstaining costs nothing: with no translation in hand
    // `build()` has nothing to publish under either label.
    switch (behaviourOf(only)) {
      case 'silent':
        return null
      case 'echo':
        return target
      default:
        return otherOf(pair, target)
    }
  }

  const behaviourA = behaviourOf(a)
  const behaviourB = behaviourOf(b)

  // The measured discriminator: exactly one session translated, so the other
  // one's target is the language the speaker was already speaking — whether
  // that session echoed the words back or, as the live protocol does, said
  // nothing.
  if (behaviourA === 'translating' && behaviourB !== 'translating') return second
  if (behaviourB === 'translating' && behaviourA !== 'translating') return first

  // Neither translated: two echoes, or two silences before either output
  // landed. No evidence either way.
  if (behaviourA !== 'translating' && behaviourB !== 'translating') return null

  // Both read as translations, which the protocol says should not happen —
  // one of them flipped direction. Fall back to the older, weaker ranking:
  // whichever output stays closer to its own input translated less.
  const overlapA = similarity(a.original, a.translated)
  const overlapB = similarity(b.original, b.translated)
  if (overlapA === overlapB) return null
  return overlapA > overlapB ? first : second
}

/**
 * What one session did with the audio.
 *
 * `silent` is a first-class answer, not a degenerate `translating`: under the
 * measured protocol it is what the same-language session always does, and
 * conflating the two is the bug above.
 */
type SessionBehaviour = 'silent' | 'echo' | 'translating'

function behaviourOf(entry: { original: string; translated: string }): SessionBehaviour {
  if (!entry.translated.trim()) return 'silent'
  return isPassthrough(entry.original, entry.translated) ? 'echo' : 'translating'
}

/**
 * Transcription frames are incremental deltas, not cumulative snapshots
 * (protocol drift observed 2026-08-10: "Hello everyone, and welcome to the",
 * then " annual", then " forum." — each fragment is only the new text). An
 * utterance's text for one session is therefore the concatenation of that
 * session's fragments in arrival order; taking the newest fragment — as this
 * module did when frames were cumulative — shattered every sentence into its
 * last few words (fix-caption-idle-turn-boundary).
 *
 * Accumulated per target, never across targets: both sessions transcribe the
 * same audio independently and their transcripts differ in wording, so an
 * interleaved concatenation would duplicate every phrase.
 */
function accumulateByTarget(fragments: IncomingFragment[]): Accumulated {
  const byTarget: Accumulated = new Map()
  for (const fragment of fragments) {
    const entry = byTarget.get(fragment.targetLang) ?? { original: '', translated: '' }
    if (fragment.originalText) entry.original += fragment.originalText
    if (fragment.translatedText) entry.translated += fragment.translatedText
    byTarget.set(fragment.targetLang, entry)
  }
  return byTarget
}

/** Deltas arrive with their own leading spaces; joining can still double up. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A session that emitted no output yet, or output that shares most of its
 * tokens with the input, was repeating rather than translating.
 */
function isPassthrough(original: string, translated: string): boolean {
  if (!translated.trim()) return false
  return similarity(original, translated) >= 0.6
}

/** Cheap token-overlap ratio; enough to separate a translation from an echo. */
function similarity(a: string, b: string): number {
  const left = tokenize(a)
  const right = tokenize(b)
  if (left.length === 0 || right.length === 0) return 0
  const rightSet = new Set(right)
  const shared = left.filter((token) => rightSet.has(token)).length
  return shared / Math.max(left.length, right.length)
}

/**
 * Sentence terminators, counted only where one actually ends a sentence:
 * followed by whitespace or the end of the text, and not preceded by a digit.
 *
 * The digit guard is what keeps "1.5 giây" and "v1.2." from reading as two
 * sentences. It costs the reverse case — a sentence genuinely ending in a
 * figure, "the target is 2026." — which under-counts and so retires later than
 * asked. That is the safe direction: a late split shows one long caption, an
 * early split cuts a sentence in half.
 */
const SENTENCE_END = /[.!?…]+(?=\s|$)/gu

/**
 * How many complete sentences a transcript holds.
 *
 * Latin-punctuated languages share these terminators; a pair whose script
 * ends sentences differently (`。`) needs this widened, which is the one place
 * `src/transcript` knows anything about a script (caption-utterance-cap).
 */
export function countSentences(text: string): number {
  let sentences = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    const preceding = match.index > 0 ? text[match.index - 1] : undefined
    if (preceding && /\d/u.test(preceding)) continue
    sentences += 1
  }
  return sentences
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

export interface UtteranceMergerOptions {
  /** The two languages the feed interprets between. */
  pair: LanguagePair
  /** Text classifier for the pair; `null` abstains. */
  detect: LanguageDetector
  /** Fragments shorter than this are treated as phantom noise. */
  minCharacters?: number
  /**
   * Operator-declared speaker language (caption-direction-control): the
   * label is taken as ground truth, bypassing behavioral inference and
   * text detection. The same-language veto still applies.
   */
  forcedSourceLang?: LangTag
}

/**
 * Accumulates fragments per utterance and decides when a segment is ready to be
 * published.
 */
export class UtteranceMerger {
  private readonly fragments = new Map<string, IncomingFragment[]>()
  private readonly startedAt = new Map<string, number>()
  private readonly pair: LanguagePair
  private readonly detect: LanguageDetector

  /**
   * Drops every accumulated fragment. A stopped feed's half-heard speech is
   * not the next session's to publish.
   */
  reset(): void {
    this.fragments.clear()
    this.startedAt.clear()
  }

  constructor(private readonly options: UtteranceMergerOptions) {
    this.pair = options.pair
    this.detect = options.detect
    if (options.forcedSourceLang !== undefined) otherOf(this.pair, options.forcedSourceLang)
  }

  add(fragment: IncomingFragment): MergedUtterance | null {
    const existing = this.fragments.get(fragment.utteranceId) ?? []
    existing.push(fragment)
    this.fragments.set(fragment.utteranceId, existing)
    if (!this.startedAt.has(fragment.utteranceId)) {
      this.startedAt.set(fragment.utteranceId, fragment.receivedAt)
    }
    return this.build(fragment.utteranceId)
  }

  /** Returns the current displayable snapshot without retiring the utterance. */
  get(utteranceId: string): MergedUtterance | null {
    return this.build(utteranceId)
  }

  private build(utteranceId: string): MergedUtterance | null {
    const fragments = this.fragments.get(utteranceId)
    if (!fragments || fragments.length === 0) return null

    const byTarget = accumulateByTarget(fragments)
    const [first, second] = this.pair

    // The source language is decided BEFORE the pair is selected. An
    // operator-declared direction (caption-direction-control) short-circuits
    // the decision entirely — no detection, no inference; the control exists
    // to end the guessing. In Auto, both sessions transcribe the same audio,
    // so either session's input transcript is a witness for the speaker's
    // language, and the text outranks behavioral echo-vs-translation
    // inference: a session that flips direction — answering second-language
    // speech in the first language — otherwise relabels the speaker and the
    // wall renders the swap (production u15–u19, 2026-08-10: `sourceLang`
    // labelled with the first language over a second-language original).
    // Deciding after selection, as an earlier fix did, published texts chosen
    // under the wrong label and never reconsulted the other session's pair.
    // Behavioral inference stays as the fallback when both transcripts
    // abstain (no script evidence, no function words).
    //
    // Both transcripts are consulted, and they must agree. The production
    // feed asked the second language's session first and took the first
    // non-null answer, which made consultation order the tiebreak whenever
    // two transcripts of the same audio disagreed — a one-word English
    // fragment the vi session mangled into something diacritic-heavy
    // outvoted a clean English transcript sitting in the other session. A
    // disagreement is not evidence; it falls through to behavioral
    // inference, which the protocol answers cleanly.
    const detectedBySecond = this.detect(byTarget.get(second)?.original ?? '')
    const detectedByFirst = this.detect(byTarget.get(first)?.original ?? '')
    const detectedBySpeech =
      detectedBySecond && detectedByFirst && detectedBySecond !== detectedByFirst
        ? null
        : (detectedBySecond ?? detectedByFirst)

    const sourceLang =
      this.options.forcedSourceLang ??
      detectedBySpeech ??
      inferSourceLanguage(fragments, this.pair, byTarget)
    if (!sourceLang) return null

    // Both texts come from the *translating* session (the one whose target is
    // not the source language): its output is the translation, and its input
    // transcript is the original that translation was made from, so the pair
    // is internally consistent. The source-target session's transcript is the
    // fallback for a degraded one-session feed.
    const translating = byTarget.get(otherOf(this.pair, sourceLang))
    const sourceSession = byTarget.get(sourceLang)
    const original = collapse(translating?.original || sourceSession?.original || '')

    // Prefer the translating session's output. When it is missing or reads as
    // the source language itself (an echo), a source-target session that
    // flipped direction holds the only translation there is — the u15 case,
    // where the second-language session answered second-language speech in
    // the first language. The veto below still rejects whatever ends up
    // selected if it reads wrong.
    let translated = collapse(translating?.translated ?? '')
    if (!translated || this.detect(translated) === sourceLang) {
      const flipped =
        sourceSession && !isPassthrough(sourceSession.original, sourceSession.translated)
          ? collapse(sourceSession.translated)
          : ''
      if (flipped && this.detect(flipped) !== sourceLang) translated = flipped
    }

    // A combined segment must have both display languages. A source
    // transcript without its translation would otherwise publish an empty
    // bubble on every surface.
    if (!original || !translated) return null

    // Never publish a pair that reads as one language on both lines,
    // whatever the operator declared. Two forms of the same veto: the pair
    // detects as one language outright (which also catches an echo under a
    // forced label), or the translation detects as the language the label
    // says was spoken.
    const detectedOriginal = this.detect(original)
    const detectedTranslated = this.detect(translated)
    if (detectedOriginal && detectedTranslated && detectedOriginal === detectedTranslated) {
      return null
    }
    if (detectedTranslated && detectedTranslated === sourceLang) return null

    const minCharacters = this.options.minCharacters ?? 2
    if (original.length < minCharacters) return null

    return {
      utteranceId,
      sourceLang,
      original,
      translated,
      final: fragments.some((f) => f.final),
      startedAt: this.startedAt.get(utteranceId) ?? fragments[0]!.receivedAt,
      updatedAt: Math.max(...fragments.map((f) => f.receivedAt)),
    }
  }

  release(utteranceId: string): void {
    this.fragments.delete(utteranceId)
    this.startedAt.delete(utteranceId)
  }

  get pendingCount(): number {
    return this.fragments.size
  }
}
