import 'dotenv/config'
import express from 'express'
import { GoogleGenAI, Modality } from '@google/genai'

const PORT = Number(process.env.PORT ?? 3001)
const MODEL = 'gemini-3.5-live-translate-preview'

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey || apiKey === 'your-key-here') {
  console.error('Set GEMINI_API_KEY in .env (copy .env.example)')
  process.exit(1)
}

const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } })
const app = express()
app.use(express.json())

// Mints a single-use ephemeral token so the API key never reaches the browser.
// The FULL session config must be pinned in liveConnectConstraints: pinning
// only the model locks the config to empty and the session silently ignores
// the client's translationConfig (no translation happens).
app.post('/api/token', async (req, res) => {
  const target = req.body?.target
  if (target !== 'en' && target !== 'vi') {
    res.status(400).json({ error: 'target must be "en" or "vi"' })
    return
  }
  try {
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            translationConfig: { targetLanguageCode: target, echoTargetLanguage: false },
          },
        },
      },
    })
    if (!token.name) throw new Error('token response had no name')
    res.json({ token: token.name })
  } catch (err) {
    console.error('[token] ephemeral token mint failed:', err)
    // Localhost-only escape hatch: the preview model may not support ephemeral
    // tokens yet. Never do this for non-local hosts.
    const local = req.hostname === 'localhost' || req.hostname === '127.0.0.1'
    if (local) {
      console.warn('[token] falling back to raw API key (localhost only)')
      res.json({ token: apiKey, insecureFallback: true })
    } else {
      res.status(500).json({ error: 'failed to mint ephemeral token' })
    }
  }
})

app.use(express.static('dist'))

app.listen(PORT, () => {
  console.log(`live-translator server → http://localhost:${PORT} (token endpoint /api/token)`)
})
