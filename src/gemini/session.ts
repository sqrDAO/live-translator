import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai'
import { base64ToBytes } from '../audio/pcm'

export const MODEL = 'gemini-3.5-live-translate-preview'
export type Lang = 'en' | 'vi'

export type SessionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export interface SessionCallbacks {
  /** Translated audio: raw 16-bit 24kHz mono PCM */
  onAudio(pcm: Uint8Array): void
  /** Incremental transcription of what the mic heard */
  onInputText(text: string): void
  /** Incremental transcription of the translated speech */
  onOutputText(text: string): void
  onTurnComplete(): void
  onStatus(status: SessionStatus, detail?: string): void
}

async function fetchToken(target: Lang): Promise<string> {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`token endpoint HTTP ${res.status} ${body}`.trim())
  }
  const { token } = (await res.json()) as { token: string }
  if (!token) throw new Error('token endpoint returned no token')
  return token
}

/** One Live API connection translating auto-detected speech into `target`. */
export class TranslateSession {
  private session: Session | null = null
  private closedByUser = false

  constructor(
    readonly target: Lang,
    private cb: SessionCallbacks,
  ) {}

  async connect(): Promise<void> {
    this.closedByUser = false
    this.cb.onStatus('connecting')
    const token = await fetchToken(this.target)
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } })

    this.session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: this.target,
          echoTargetLanguage: false,
        },
      },
      callbacks: {
        onopen: () => this.cb.onStatus('open'),
        onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
        onerror: (e: ErrorEvent) => this.cb.onStatus('error', e.message),
        onclose: (e: CloseEvent) => {
          if (!this.closedByUser) this.cb.onStatus('closed', e.reason || `code ${e.code}`)
        },
      },
    })
  }

  private handleMessage(msg: LiveServerMessage): void {
    const sc = msg.serverContent
    if (!sc) return
    if (sc.inputTranscription?.text) this.cb.onInputText(sc.inputTranscription.text)
    if (sc.outputTranscription?.text) this.cb.onOutputText(sc.outputTranscription.text)
    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data
      if (data) this.cb.onAudio(base64ToBytes(data))
    }
    if (sc.turnComplete) this.cb.onTurnComplete()
  }

  /** base64 16-bit 16kHz mono PCM chunk */
  sendAudio(base64Pcm: string): void {
    this.session?.sendRealtimeInput({
      audio: { data: base64Pcm, mimeType: 'audio/pcm;rate=16000' },
    })
  }

  close(): void {
    this.closedByUser = true
    this.session?.close()
    this.session = null
    this.cb.onStatus('idle')
  }
}
