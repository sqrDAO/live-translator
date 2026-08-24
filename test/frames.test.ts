import { describe, expect, it } from 'vitest'

import { parseLiveMessage } from '../src/gemini/frames'

const frame = (serverContent: Record<string, unknown>): string =>
  JSON.stringify({ serverContent })

describe('the model translation is read from the shape a TEXT session sends', () => {
  it('reads the translation from modelTurn text parts', async () => {
    // The defect this pins: the config asks for `responseModalities: ['TEXT']`,
    // so the model emits no audio and `outputAudioTranscription` produces
    // nothing. Reading only `outputTranscription` left `outputText` unset on
    // every frame, `UtteranceMerger.build()` refuses an utterance with no
    // translation, and the feed published nothing at all — with the whole
    // suite green, because every authored frame used the audio shape.
    const parsed = await parseLiveMessage(
      frame({
        inputTranscription: { text: 'Good morning' },
        modelTurn: { parts: [{ text: 'Chào buổi sáng' }] },
      }),
    )
    expect(parsed).toEqual({ inputText: 'Good morning', outputText: 'Chào buổi sáng' })
  })

  it('concatenates several text parts in one frame', async () => {
    // Each part is a delta the merge accumulates; taking only the first
    // silently truncated the translation.
    const parsed = await parseLiveMessage(
      frame({ modelTurn: { parts: [{ text: 'Chào ' }, { text: 'buổi ' }, { text: 'sáng' }] } }),
    )
    expect(parsed?.outputText).toBe('Chào buổi sáng')
  })

  it('skips non-text parts rather than stringifying them', async () => {
    const parsed = await parseLiveMessage(
      frame({
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } }, { text: 'Xin chào' }],
        },
      }),
    )
    expect(parsed?.outputText).toBe('Xin chào')
  })

  it('still accepts outputTranscription, for a deployment configured for AUDIO', async () => {
    // ADR-001: the shape is verified per deployment, never assumed, and it has
    // already moved twice. An AUDIO session must keep working through this
    // same parser.
    const parsed = await parseLiveMessage(frame({ outputTranscription: { text: 'Xin chào' } }))
    expect(parsed?.outputText).toBe('Xin chào')
  })

  it('prefers modelTurn text when a frame somehow carries both', async () => {
    const parsed = await parseLiveMessage(
      frame({
        modelTurn: { parts: [{ text: 'from modelTurn' }] },
        outputTranscription: { text: 'from transcription' },
      }),
    )
    expect(parsed?.outputText).toBe('from modelTurn')
  })

  it('leaves outputText unset for a frame with no translation', async () => {
    const parsed = await parseLiveMessage(
      frame({ inputTranscription: { text: 'Good morning' }, modelTurn: { parts: [] } }),
    )
    expect(parsed).toEqual({ inputText: 'Good morning' })
    expect(parsed).not.toHaveProperty('outputText')
  })
})
