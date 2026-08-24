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
  const output = serverContent.outputTranscription as { text?: string } | undefined

  return {
    ...(input?.text ? { inputText: input.text } : {}),
    ...(output?.text ? { outputText: output.text } : {}),
    ...(serverContent.turnComplete ? { turnComplete: true } : {}),
  }
}
