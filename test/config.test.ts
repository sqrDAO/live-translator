import { describe, expect, it } from 'vitest'

import { buildLiveSessionConfig, buildTokenConstraints } from '../src/gemini/config'
import { enVi } from '../src/lang/en-vi'
import type { LanguagePack } from '../src/lang/types'

const MODEL = 'gemini-3.5-live-translate-preview'

function instruction(config: Record<string, unknown>): string {
  return (config.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text
}

describe('the EN/VI instruction is byte-identical to what production pinned', () => {
  // The instruction is pinned into the ephemeral token, so a difference here
  // is a difference in what the token authorizes. This is the whole reason the
  // language pair was lifted to a pack without changing the wording: the
  // literal below is what shipped, and it must survive the extraction exactly.
  const PINNED_VI =
    'You are a live conference interpreter for a bilingual English/Vietnamese event. ' +
    'Translate spoken input into Vietnamese. ' +
    'If the speaker is already speaking Vietnamese, repeat their words verbatim without translating. ' +
    'Every word of your output must be in Vietnamese — never respond in English. ' +
    'Never add commentary, greetings, apologies, or descriptions of audio. ' +
    'If the audio contains no intelligible speech, output nothing at all. ' +
    'Preserve Vietnamese diacritics exactly. ' +
    'Preserve proper nouns, product names and figures.'

  it('pins the target-VI instruction verbatim', () => {
    expect(instruction(buildLiveSessionConfig({ model: MODEL, languages: enVi, target: 'vi' }))).toBe(
      PINNED_VI,
    )
  })

  it('pins the target-EN instruction verbatim', () => {
    const PINNED_EN =
      'You are a live conference interpreter for a bilingual English/Vietnamese event. ' +
      'Translate spoken input into English. ' +
      'If the speaker is already speaking English, repeat their words verbatim without translating. ' +
      'Every word of your output must be in English — never respond in Vietnamese. ' +
      'Never add commentary, greetings, apologies, or descriptions of audio. ' +
      'If the audio contains no intelligible speech, output nothing at all. ' +
      'Preserve Vietnamese diacritics exactly. ' +
      'Preserve proper nouns, product names and figures.'
    expect(instruction(buildLiveSessionConfig({ model: MODEL, languages: enVi, target: 'en' }))).toBe(
      PINNED_EN,
    )
  })
})

describe('ephemeral token constraints — the exact wire shape', () => {
  const sessionConfig = buildLiveSessionConfig({ model: MODEL, languages: enVi, target: 'vi' })
  const constraints = buildTokenConstraints(sessionConfig)

  it('pins the session config under bidiGenerateContentSetup, flat', () => {
    expect(constraints.bidiGenerateContentSetup).toBe(sessionConfig)
    // Full resource name: a bare id on the constrained WebSocket is resolved
    // as a project-scoped reference and the session is refused.
    expect(constraints.bidiGenerateContentSetup.model).toBe(`models/${MODEL}`)
  })

  it('leaves an already-prefixed model name single-prefixed', () => {
    const prefixed = buildLiveSessionConfig({ model: `models/${MODEL}`, languages: enVi, target: 'en' })
    expect(prefixed.model).toBe(`models/${MODEL}`)
  })

  it('carries no key from the removed liveConnectConstraints shape', () => {
    expect(constraints).not.toHaveProperty('liveConnectConstraints')
    expect(constraints.bidiGenerateContentSetup).not.toHaveProperty('config')
  })

  it('contains only fields the strict parser accepts', () => {
    const allowed = new Set([
      'model',
      'generationConfig',
      'systemInstruction',
      'tools',
      'realtimeInputConfig',
      'sessionResumption',
      'contextWindowCompression',
      'inputAudioTranscription',
      'outputAudioTranscription',
      'historyConfig',
    ])
    for (const key of Object.keys(constraints.bidiGenerateContentSetup)) {
      expect(allowed, `unknown field ${key} would be rejected by the API`).toContain(key)
    }
  })

  it('pins resumption enabled with no handle, and sliding-window compression', () => {
    expect(constraints.bidiGenerateContentSetup.sessionResumption).toEqual({})
    expect(constraints.bidiGenerateContentSetup.contextWindowCompression).toEqual({
      slidingWindow: {},
    })
  })

  it('pins the authorized modality and both transcriptions', () => {
    const setup = constraints.bidiGenerateContentSetup as {
      generationConfig?: { responseModalities?: string[] }
      inputAudioTranscription?: unknown
      outputAudioTranscription?: unknown
    }
    expect(setup.generationConfig?.responseModalities).toEqual(['TEXT'])
    expect(setup.inputAudioTranscription).toEqual({})
    expect(setup.outputAudioTranscription).toEqual({})
  })
})

describe('operator-declared direction', () => {
  it('pins a translate-only instruction when the speaker differs from the target', () => {
    const text = instruction(
      buildLiveSessionConfig({ model: MODEL, languages: enVi, target: 'en', speakerLang: 'vi' }),
    )
    expect(text).toContain('The speaker is speaking Vietnamese.')
    expect(text).toContain('Translate everything they say into English.')
    expect(text).not.toContain('repeat their words verbatim without translating')
  })

  it('pins a repeat-only instruction when the speaker matches the target', () => {
    const text = instruction(
      buildLiveSessionConfig({ model: MODEL, languages: enVi, target: 'vi', speakerLang: 'vi' }),
    )
    expect(text).toContain('The speaker is speaking Vietnamese.')
    expect(text).toContain('never translate')
  })
})

describe('programme context in the pinned instruction', () => {
  const withContext = (context: Parameters<typeof buildLiveSessionConfig>[0]['context']) =>
    instruction(
      buildLiveSessionConfig({ model: MODEL, languages: enVi, target: 'vi', ...(context ? { context } : {}) }),
    )

  it('omitted context leaves the instruction byte-identical to the one without it', () => {
    expect(withContext(undefined)).toBe(
      instruction(buildLiveSessionConfig({ model: MODEL, languages: enVi, target: 'vi' })),
    )
  })

  it('names the session, the event, the speakers and the glossary', () => {
    const text = withContext({
      eventName: 'Some Forum 2026',
      sessionTitle: 'Panel: Human Ingenuity',
      speakers: ['Alex Vance — Innovate Hub', 'Lê Mai Lan — University'],
      glossary: ['sqrDAO', 'TCBS'],
    })
    expect(text).toContain('"Panel: Human Ingenuity" at "Some Forum 2026"')
    expect(text).toContain('Alex Vance — Innovate Hub; Lê Mai Lan — University')
    expect(text).toContain('Reproduce these names exactly as written: sqrDAO, TCBS.')
    expect(text).toContain('false starts')
  })

  it('deduplicates and drops blanks rather than emitting an empty clause', () => {
    const text = withContext({ sessionTitle: 'Morning Plenary', speakers: ['An', '', 'An', '   '] })
    expect(text).toContain('The speakers are: An.')
    expect(text).not.toContain('; ;')
    expect(text).not.toContain(': .')
  })

  it('pins the context into the token constraints, not just the local session', () => {
    const config = buildLiveSessionConfig({
      model: MODEL,
      languages: enVi,
      target: 'vi',
      context: { glossary: ['sqrDAO'] },
    })
    const pinned = buildTokenConstraints(config).bidiGenerateContentSetup as Record<string, unknown>
    expect(instruction(pinned)).toContain('sqrDAO')
  })
})

describe('a third language pair the repository configures nowhere', () => {
  // en/ko drives the config without a diacritics clause, proving the pair and
  // its script rules are the pack's, not core's.
  const enKo: LanguagePack = {
    pair: ['en', 'ko'],
    names: { en: 'English', ko: 'Korean' },
    detect: () => null,
  }

  it('builds an EN/KO instruction with no Vietnamese wording', () => {
    const text = instruction(buildLiveSessionConfig({ model: MODEL, languages: enKo, target: 'ko' }))
    expect(text).toBe(
      'You are a live conference interpreter for a bilingual English/Korean event. ' +
        'Translate spoken input into Korean. ' +
        'If the speaker is already speaking Korean, repeat their words verbatim without translating. ' +
        'Every word of your output must be in Korean — never respond in English. ' +
        'Never add commentary, greetings, apologies, or descriptions of audio. ' +
        'If the audio contains no intelligible speech, output nothing at all. ' +
        'Preserve proper nouns, product names and figures.',
    )
    expect(text).not.toContain('Vietnamese')
  })
})
