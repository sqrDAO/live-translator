/**
 * AudioWorklet processor source.
 *
 * Descends from `sqrdao-intern/live-translator`
 *   commit 7273d39cf6c228f2445bbb0fbe3e17401f74412f
 *
 * Kept as a string and served as a blob URL so no build step, static asset or
 * CDN fetch is involved - the publisher has to start reliably on a venue
 * network that may be filtering.
 *
 * The processor does the minimum possible work on the audio thread: copy the
 * mono frame and post it. All resampling, PCM conversion, chunking and voice
 * detection happen on the main thread, where they are testable.
 */

export const WORKLET_NAME = 'live-translate-capture-processor'

export const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const channel = input[0]
    if (!channel || channel.length === 0) return true

    // Copy: the underlying buffer is reused by the audio thread on the next
    // render quantum, so posting it directly would deliver mutated samples.
    this.port.postMessage(new Float32Array(channel))
    return true
  }
}

registerProcessor(${JSON.stringify(WORKLET_NAME)}, CaptureProcessor)
`
