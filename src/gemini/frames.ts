/**
 * Live API frame parsing.
 *
 * PROTOCOL CAVEAT (ADR-001): the message shape below matches what was observed
 * on the pinned preview model. It is verified per deployment, never assumed —
 * the protocol has already moved twice in this code's short life.
 */

export interface ParsedLiveMessage {
  inputText?: string
  outputText?: string
  turnComplete?: boolean
  /** Newest resumable handle from a `sessionResumptionUpdate` frame. */
  resumptionHandle?: string
  /** A `goAway` frame: the server will close this connection shortly. */
  goAway?: boolean
}

/**
 * Defensive parse of one Live API frame.
 *
 * The socket delivers either a string or a Blob depending on the browser, and
 * the payload shape is only guaranteed for the pinned preview model, so every
 * field is read optionally and an unrecognized frame is ignored rather than
 * throwing inside a WebSocket handler.
 *
 * Transcription frames are incremental deltas, not cumulative snapshots: the
 * text here is only the new text, and `transcript/merge.ts` accumulates it.
 */
export async function parseLiveMessage(data: unknown): Promise<ParsedLiveMessage | null> {
  let text: string
  if (typeof data === 'string') text = data
  else if (typeof Blob !== 'undefined' && data instanceof Blob) text = await data.text()
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data)
  else return null

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }

  // Session lifecycle frames arrive at the top level, outside `serverContent`
  // (caption-session-resumption).
  const frame = payload as {
    serverContent?: Record<string, unknown>
    sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean }
    goAway?: Record<string, unknown>
  }
  const update = frame.sessionResumptionUpdate
  if (update?.resumable && typeof update.newHandle === 'string' && update.newHandle) {
    return { resumptionHandle: update.newHandle }
  }
  if (frame.goAway) return { goAway: true }

  const serverContent = frame.serverContent
  if (!serverContent) return null

  const input = serverContent.inputTranscription as { text?: string } | undefined
  const outputText = readOutputText(serverContent)

  return {
    ...(input?.text ? { inputText: input.text } : {}),
    ...(outputText ? { outputText } : {}),
    ...(serverContent.turnComplete ? { turnComplete: true } : {}),
  }
}

/**
 * The model's translation, under `responseModalities: ['TEXT']`.
 *
 * It arrives as `modelTurn.parts[].text`. `outputAudioTranscription` — which
 * this once read exclusively — transcribes the model's *audio*, so it is
 * simply absent under a TEXT modality: reading only that field left
 * `outputText` unset on every frame, and `UtteranceMerger.build()` refuses an
 * utterance with no translation, so every turn retired as a retract and the
 * feed published nothing at all. The suite could not see it, because every
 * frame it fed was hand-authored in the audio shape.
 *
 * `outputTranscription` is still accepted as a fallback. ADR-001: the shape is
 * verified per deployment and has already moved twice, and a deployment
 * configured for AUDIO must keep working through this same parser.
 */
function readOutputText(serverContent: Record<string, unknown>): string | undefined {
  const modelTurn = serverContent.modelTurn as { parts?: unknown } | undefined
  if (Array.isArray(modelTurn?.parts)) {
    // Concatenated, not first-wins: one frame can carry several text parts,
    // and each is a delta the merge accumulates. Non-text parts (inline audio
    // under a mixed modality) are skipped rather than stringified.
    const text = modelTurn.parts
      .map((part) => (part as { text?: unknown } | null)?.text)
      .filter((value): value is string => typeof value === 'string')
      .join('')
    if (text) return text
  }
  const transcription = serverContent.outputTranscription as { text?: string } | undefined
  return transcription?.text || undefined
}
