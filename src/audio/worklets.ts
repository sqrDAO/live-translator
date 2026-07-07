// AudioWorklet processors, inlined as source strings and loaded via Blob URLs
// so the PWA needs no extra worklet asset files.

const CAPTURE_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) {
      const copy = new Float32Array(ch.length)
      copy.set(ch)
      this.port.postMessage(copy, [copy.buffer])
    }
    return true
  }
}
registerProcessor('capture', CaptureProcessor)
`

function blobUrl(src: string): string {
  return URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
}

export async function loadCaptureWorklet(ctx: AudioContext): Promise<void> {
  await ctx.audioWorklet.addModule(blobUrl(CAPTURE_SRC))
}
