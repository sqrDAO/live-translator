/**
 * Gemini Live session configuration.
 *
 * Two rules are encoded here:
 *   * the model name is read from configuration, never hard-coded
 *   * the full Live API session config is pinned into the ephemeral token
 *     constraints, so a token cannot be re-used with a different, more
 *     expensive or more permissive configuration
 *
 * Isomorphic: the host's server pins it, the browser echoes it into the
 * session it opens, and an operator diagnostics panel may display it.
 */

import { assertLanguagePair, otherOf, type LangTag, type LanguagePack } from '../lang/types'

/**
 * Silence the model requires before it ends a turn.
 *
 * Exported because `engine.ts` must not split a speech run at a boundary the
 * model did not also see: a run shorter than this can sit inside one Gemini
 * turn, and pairing a run with a turn is what the latency measurement rests on.
 */
export const TURN_SILENCE_MS = 800

/**
 * Two Live sessions per feed, one per target language, both fed the same
 * audio. Conversation-mode two-way translation is achieved by running both
 * rather than by asking one session to auto-detect.
 */
/**
 * The instruction's translation clauses. Without `speakerLang` the session
 * must decide per utterance whether to translate or echo — the hedge that
 * lets a direction flip happen (caption-source-language-mislabel). With it,
 * the operator has declared what the microphone carries
 * (caption-direction-control) and the session gets a single unconditional
 * job: translate everything, or repeat everything.
 */
function directionClauses(languages: LanguagePack, target: LangTag, speakerLang?: LangTag): string[] {
  const name = (lang: LangTag) => nameOf(languages, lang)
  if (!speakerLang) {
    return [
      `Translate spoken input into ${name(target)}.`,
      `If the speaker is already speaking ${name(target)}, repeat their words verbatim without translating.`,
    ]
  }
  if (speakerLang === target) {
    return [
      `The speaker is speaking ${name(speakerLang)}.`,
      `Repeat their words verbatim in ${name(target)}; never translate.`,
    ]
  }
  return [
    `The speaker is speaking ${name(speakerLang)}.`,
    `Translate everything they say into ${name(target)}.`,
  ]
}

function nameOf(languages: LanguagePack, lang: LangTag): string {
  const name = languages.names[lang]
  if (!name) throw new Error(`no display name configured for language ${JSON.stringify(lang)}`)
  return name
}

/**
 * What this session is interpreting, in the model's own instruction.
 *
 * Every field is programme configuration the host already holds at mint time
 * — nothing here is written in the engine. It exists because an instruction
 * that names no event, session, speaker or organisation costs accuracy on
 * exactly the nouns a room cares about: in one recorded sample `Đấy là thứ
 * mấy hả?` became "Which day is that?" mid-lamination, where `thứ mấy` is
 * which *sample*.
 *
 * Reaches generated output only. A speaker's own words arrive as the other
 * session's raw `inputAudioTranscription`, which no instruction can touch — so
 * this helps the translated line and cannot fix a mistoned original
 * (caption-translation-quality, defect 1).
 *
 * Assembling this context — which event, which speakers, which glossary — is
 * the host's job. The engine only carries it into the instruction.
 */
export interface LiveSessionContext {
  /** The event's own name. */
  eventName?: string
  /** The session title the room is actually running. */
  sessionTitle?: string
  /** Speakers as "Name — Affiliation", or bare names where none is configured. */
  speakers?: string[]
  /**
   * Names to preserve verbatim: organisations, products, tracks. Which nouns
   * matter is programme content and changes per client, never per deployment.
   */
  glossary?: string[]
}

/** Deduplicates while preserving order, and drops blanks. */
function distinct(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * The context clauses, or none at all.
 *
 * Absent context must produce a byte-identical instruction to the one that
 * shipped before this existed: the instruction is pinned into the ephemeral
 * token, so a difference here is a difference in what the token authorizes.
 */
function contextClauses(context: LiveSessionContext | undefined): string[] {
  if (!context) return []
  const clauses: string[] = []

  const where = distinct([context.sessionTitle, context.eventName])
  if (where.length > 0) {
    clauses.push(`You are interpreting "${where.join('" at "')}".`)
  }

  const speakers = distinct(context.speakers ?? [])
  if (speakers.length > 0) {
    clauses.push(`The speakers are: ${speakers.join('; ')}.`)
  }

  const glossary = distinct(context.glossary ?? [])
  if (glossary.length > 0) {
    // "Reproduce" rather than "preserve": the general preservation clause below
    // already covers proper nouns, and what this adds is the spelling the model
    // would otherwise transliterate — "sqrDAO" is not a word it can guess.
    clauses.push(`Reproduce these names exactly as written: ${glossary.join(', ')}.`)
  }

  // Defect 3 and 4 in the same sample: `nó sẽ Ừ` became "it will… Yeah", and a
  // single utterance rendered as "it's not that big. But it's too small."
  // Neither is a vocabulary problem, so neither is helped by the glossary.
  clauses.push(
    'Speakers hesitate, restart and correct themselves; render the sentence they land on, not the false starts, and never translate a filler word as if it carried meaning.',
  )

  return clauses
}

export interface LiveSessionConfigInput {
  model: string
  /** The pair, names and script clauses the instruction is written for. */
  languages: LanguagePack
  target: LangTag
  /** Operator-declared speaker language; absent means auto (bidirectional). */
  speakerLang?: LangTag
  /** Programme context for this feed; absent leaves the instruction as it was. */
  context?: LiveSessionContext
}

/**
 * The full setup object for one target-language session.
 *
 * With the bundled EN/VI pack and no context the `systemInstruction` is
 * byte-identical to the one the production feed pinned into its tokens — the
 * config test holds that string literally. Changing any wording here changes
 * what every minted token authorizes.
 */
export function buildLiveSessionConfig(input: LiveSessionConfigInput): Record<string, unknown> {
  const { languages, target } = input
  assertLanguagePair(languages.pair)
  const [first, second] = languages.pair
  const name = (lang: LangTag) => nameOf(languages, lang)
  // Validates `target` is in the pair as a side effect.
  const other = otherOf(languages.pair, target)

  return {
    // Full resource name, not the bare id: on the constrained (token-based)
    // WebSocket a bare name is resolved as a project-scoped reference and the
    // session is closed with "token-based requests cannot use project-scoped
    // features such as tuned models" (probed 2026-08-10,
    // fix-caption-live-socket-auth).
    model: input.model.startsWith('models/') ? input.model : `models/${input.model}`,
    generationConfig: {
      // Translated audio is discarded unless a host enables playback, so only
      // text is requested.
      responseModalities: ['TEXT'],
      temperature: 0,
      candidateCount: 1,
    },
    systemInstruction: {
      parts: [
        {
          text: [
            `You are a live conference interpreter for a bilingual ${name(first)}/${name(second)} event.`,
            ...contextClauses(input.context),
            ...directionClauses(languages, target, input.speakerLang),
            // A session that answers in the wrong direction relabels the
            // speaker downstream (caption-source-language-mislabel): the
            // output language is not the model's choice to make.
            `Every word of your output must be in ${name(target)} — never respond in ${name(other)}.`,
            `Never add commentary, greetings, apologies, or descriptions of audio.`,
            `If the audio contains no intelligible speech, output nothing at all.`,
            // Script-specific orders come from the pack (EN/VI: diacritics),
            // ahead of the generic preservation clause, so the joined string
            // reads as the one sentence pair that shipped.
            ...(languages.instructionClauses ?? []),
            `Preserve proper nouns, product names and figures.`,
          ].join(' '),
        },
      ],
    },
    // Both transcriptions are requested. The output transcription is the
    // session discriminator used to infer the source language.
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        // The engine already gates on its own adaptive noise floor, so the
        // model's VAD is set permissively and used only for turn boundaries.
        disabled: false,
        silenceDurationMs: TURN_SILENCE_MS,
      },
    },
    // Empty object = enabled. The server then streams `sessionResumptionUpdate`
    // handles, and a reconnect presents the newest one to continue the model's
    // context instead of cold-starting — the handle itself is added by the
    // session manager at reconnect time and is never part of this pinned
    // config (caption-session-resumption).
    sessionResumption: {},
    // Resumption lifts the ~10-minute *connection* limit; this lifts the
    // 15-minute *session duration* cap, which is shorter than every 90-minute
    // programme block. Default window sizes: the defaults are tuned to the
    // model's context limit, and nothing about captioning argues for others
    // (caption-session-survives-90-minutes).
    contextWindowCompression: { slidingWindow: {} },
  }
}

/**
 * The constraint object attached to the ephemeral token.
 *
 * Pinning the full config means a leaked token can only open the session the
 * server authorized: same model, same modality, same instruction.
 *
 * The field is `bidiGenerateContentSetup`, flat, per the v1beta AuthToken
 * schema (the API discovery document, not the docs page, is the authority —
 * Google renamed this from `liveConnectConstraints: { model, config }` and the
 * strict parser rejects unknown fields).
 */
export function buildTokenConstraints(sessionConfig: Record<string, unknown>): {
  bidiGenerateContentSetup: Record<string, unknown>
} {
  return { bidiGenerateContentSetup: sessionConfig }
}

/** Sanity check before a rehearsal: the model name comes from configuration. */
export function assertModelConfigured(model: string | undefined): asserts model is string {
  if (!model || !model.trim()) {
    throw new Error(
      'The Gemini Live model is not configured. The model name must come from host configuration and be verified before each deployment (ADR-001: measure, do not assume).',
    )
  }
}
