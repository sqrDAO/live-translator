/**
 * Target-aware turn coordination.
 *
 * Gemini assigns no cross-session utterance ID. Each target therefore advances
 * its own ordered cursor when it completes a turn; matching cursor positions
 * are merged. A turn is retired before publication, so network latency cannot
 * keep later speech attached to an earlier turn.
 *
 * PROTOCOL FACT (2026-08-10, ADR-001 "measure, don't assume"): the current
 * Live API surface emits no `turnComplete` at all — none across whole probe
 * sessions and none in a live operator run. Idle retirement is therefore the
 * ONLY turn boundary in practice, and it must advance the cursors itself; the
 * previous quarantine (exit only via the next `turnComplete`) turned the first
 * ≥1.5 s pause into a permanent stall that discarded every later caption
 * (fix-caption-idle-turn-boundary). `turnComplete` handling is kept in case
 * the API reintroduces it.
 */

import type { LangTag, LanguageDetector, LanguagePair } from '../lang/types.js'
import { assertLanguagePair } from '../lang/types.js'
import {
  UtteranceMerger,
  countSentences,
  type IncomingFragment,
  type MergedUtterance,
} from './merge.js'

export interface TurnMessage {
  inputText?: string
  outputText?: string
  turnComplete?: boolean
}

export type TurnPublication =
  | { kind: 'partial' | 'final'; utteranceId: string; merged: MergedUtterance }
  /**
   * The turn retired with no publishable merge (caption-source-language-
   * mislabel): any partial already on the wall for this utterance is stale —
   * possibly mislabeled — and will never be corrected by a final, so the
   * publisher must take it down.
   */
  | { kind: 'retract'; utteranceId: string }

interface TurnState {
  completedTargets: Set<LangTag>
  lastUpdatedAt: number
  /** When this turn opened. `lastUpdatedAt` measures silence; this measures age. */
  startedAt: number
}

export interface TargetTurnCoordinatorOptions {
  pair: LanguagePair
  detect: LanguageDetector
  forcedSourceLang?: LangTag
  /**
   * An utterance's ceiling, in sentences and in wall time
   * (caption-utterance-cap). Idle retirement is the only turn boundary the
   * protocol gives us — see the header — so without these a conversation that
   * never leaves a 1.5 s gap accumulates into one segment far longer than a
   * wall's row budget can render, and the display trims the head off the line
   * the room reads.
   *
   * Both are evaluated once, on the merged source text, and never per
   * target: the two sessions accumulate different amounts of text for the
   * same speech, so a threshold each evaluated for itself would fire at
   * different moments and desynchronise the utterance ids the merge depends
   * on. One decision followed by `retire()` moves both cursors together.
   */
  maxUtteranceMs?: number
  maxUtteranceSentences?: number
}

export class TargetTurnCoordinator {
  private readonly merger: UtteranceMerger
  private readonly pair: LanguagePair
  private readonly targetTurns = new Map<LangTag, number>()
  private readonly turns = new Map<number, TurnState>()
  private readonly maxUtteranceMs: number
  private readonly maxUtteranceSentences: number

  constructor(
    private readonly idleFinalizeMs: number,
    options: TargetTurnCoordinatorOptions,
  ) {
    assertLanguagePair(options.pair)
    this.pair = options.pair
    for (const target of this.pair) this.targetTurns.set(target, 0)
    this.maxUtteranceMs = options.maxUtteranceMs ?? Number.POSITIVE_INFINITY
    this.maxUtteranceSentences = options.maxUtteranceSentences ?? Number.POSITIVE_INFINITY
    this.merger = new UtteranceMerger({
      pair: options.pair,
      detect: options.detect,
      ...(options.forcedSourceLang ? { forcedSourceLang: options.forcedSourceLang } : {}),
    })
  }

  /**
   * Drops every open turn and its fragments, for a feed that has stopped.
   *
   * Without it, turns still open at `stop()` kept their `TurnState` and their
   * accumulated text, and the next `start()` published them: the first idle
   * poll found them quiet, retired them as finals, and the new session opened
   * with speech from before the operator pressed stop, carrying pre-stop
   * timestamps.
   *
   * The cursors are deliberately NOT rewound. They are what utterance ids are
   * built from, and a host that has not purged its surface must never see an
   * id from the last run reused for different words.
   */
  reset(): void {
    this.turns.clear()
    this.merger.reset()
  }

  accept(target: LangTag, message: TurnMessage, now: number): TurnPublication[] {
    if (!message.inputText && !message.outputText && !message.turnComplete) return []

    const turnIndex = this.cursor(target)
    const utteranceId = idFor(turnIndex)
    const state = this.turns.get(turnIndex) ?? {
      completedTargets: new Set<LangTag>(),
      lastUpdatedAt: now,
      startedAt: now,
    }
    state.lastUpdatedAt = now
    this.turns.set(turnIndex, state)

    const fragment: IncomingFragment = {
      utteranceId,
      targetLang: target,
      ...(message.inputText ? { originalText: message.inputText } : {}),
      ...(message.outputText ? { translatedText: message.outputText } : {}),
      final: Boolean(message.turnComplete),
      receivedAt: now,
    }
    const merged = this.merger.add(fragment)

    if (message.turnComplete) {
      state.completedTargets.add(target)
      // The target's next frame is its next turn, even if its peer is slower.
      this.targetTurns.set(target, turnIndex + 1)
    }

    if (state.completedTargets.size === this.pair.length) {
      return this.retire(turnIndex, 'final')
    }

    // The sentence cap fires on the fragment that *completes* the Nth sentence,
    // and publishes everything received up to that fragment. It does not split
    // the fragment: deltas are a few words, so the overshoot past the sentence
    // end is small, whereas splitting would mean re-seeding the next turn with
    // a per-target remainder and is the kind of surgery this pipeline has
    // already been burned by. Counted on the source transcript, not the
    // translation, so the boundary is the speaker's rather than the model's.
    if (merged && countSentences(merged.original) >= this.maxUtteranceSentences) {
      return this.retire(turnIndex, 'final')
    }

    return merged ? [{ kind: 'partial', utteranceId, merged }] : []
  }

  /**
   * Retires every turn that has gone quiet or simply run too long, whether it
   * has a displayable segment or not.
   *
   * Age is the backstop for the case the sentence cap cannot see: a speaker who
   * never finishes a sentence, or a stream whose merge is not publishable yet
   * and therefore has no transcript to count.
   */
  finalizeIdle(now: number): TurnPublication[] {
    const publications: TurnPublication[] = []
    for (const [turnIndex, state] of [...this.turns]) {
      const quiet = now - state.lastUpdatedAt >= this.idleFinalizeMs
      const overlong = now - state.startedAt >= this.maxUtteranceMs
      if (!quiet && !overlong) continue
      publications.push(...this.retire(turnIndex, 'final'))
    }
    return publications
  }

  private cursor(target: LangTag): number {
    const index = this.targetTurns.get(target)
    if (index === undefined) {
      throw new Error(`target ${JSON.stringify(target)} is not in the pair ${JSON.stringify(this.pair)}`)
    }
    return index
  }

  private retire(turnIndex: number, kind: TurnPublication['kind']): TurnPublication[] {
    const utteranceId = idFor(turnIndex)
    const merged = this.merger.get(utteranceId)

    this.merger.release(utteranceId)
    this.turns.delete(turnIndex)
    // A retired turn is a turn boundary for BOTH targets, completed or not.
    //
    // This used to quarantine an uncompleted target instead (discard its
    // frames until its next `turnComplete`), so a delayed frame could not
    // become the successor's first fragment. The protocol removed
    // `turnComplete` (see the header), which turned that quarantine into a
    // permanent stall: after the first idle retirement nothing was ever
    // published again. Advancing the cursor accepts the smaller cost — a
    // frame arriving more than `idleFinalizeMs` after its turn's last
    // activity joins the next utterance, where under a completion-less
    // protocol it is almost always genuinely next-utterance speech.
    for (const target of this.pair) {
      if (this.cursor(target) <= turnIndex) {
        this.targetTurns.set(target, turnIndex + 1)
      }
    }

    return merged
      ? [{ kind, utteranceId, merged: { ...merged, final: kind === 'final' } }]
      : [{ kind: 'retract', utteranceId }]
  }
}

function idFor(turnIndex: number): string {
  return `u${turnIndex}`
}
