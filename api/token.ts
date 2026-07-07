import { GoogleGenAI, Modality } from '@google/genai'

const MODEL = 'gemini-3.5-live-translate-preview'

// Vercel serverless mirror of the /api/token endpoint in server.ts.
// Mints a single-use ephemeral token so the API key never reaches the browser.
// The FULL session config must be pinned in liveConnectConstraints: pinning
// only the model locks the config to empty and the session silently ignores
// the client's translationConfig (no translation happens).
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' })
    return
  }
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY not configured' })
    return
  }
  const target = req.body?.target
  if (target !== 'en' && target !== 'vi') {
    res.status(400).json({ error: 'target must be "en" or "vi"' })
    return
  }
  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } })
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
    res.status(500).json({ error: 'failed to mint ephemeral token' })
  }
}
