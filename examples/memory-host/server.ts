/**
 * The reference host's token endpoint. Node only.
 *
 * This is the whole of the host's server responsibility: key in, token out.
 * A real host adds its own answers to "who may mint" and "what programme
 * context primes the model" around this call — this example answers neither,
 * because they are the host's to answer, not the engine's.
 */

import 'dotenv/config'
import express from 'express'

import { enVi } from '@sqrdao/live-translate/lang/en-vi'
import {
  createDevStubToken,
  devStubTokenAllowed,
  mintSessionToken,
} from '@sqrdao/live-translate/server'
import type { LangTag } from '@sqrdao/live-translate/server'

const PORT = Number(process.env.PORT ?? 3001)
const MODEL = process.env.GEMINI_LIVE_MODEL ?? 'gemini-3.5-live-translate-preview'
const apiKey = process.env.GEMINI_API_KEY
const developmentEnvironment = (process.env.APP_ENV ?? 'development') === 'development'

const app = express()
app.use(express.json())

app.post('/api/token', async (req, res) => {
  const target = req.body?.target as LangTag | undefined
  if (target !== 'en' && target !== 'vi') {
    res.status(400).json({ error: 'target must be "en" or "vi"' })
    return
  }

  try {
    if (!apiKey) {
      // The localhost-only stub: no key configured, so no real session — but
      // never a key to the browser either. Gated on BOTH the dev flag AND a
      // loopback host.
      if (devStubTokenAllowed({ developmentEnvironment, requestHost: req.headers.host ?? null })) {
        res.json({ token: createDevStubToken(), sessionConfig: {}, stub: true })
        return
      }
      res.status(500).json({ error: 'GEMINI_API_KEY is not configured' })
      return
    }

    // The two engine-owned steps: build the pinned config for this target and
    // mint a single-use token against it. A real host would assemble
    // `context` (event, speakers, glossary) here from what it holds.
    const grant = await mintSessionToken({
      apiKey,
      model: MODEL,
      languages: enVi,
      target,
    })
    res.json({ token: grant.token, sessionConfig: grant.sessionConfig })
  } catch (error) {
    // The upstream body may echo request details; it is logged, never returned.
    console.error('[token] mint failed:', error)
    res.status(500).json({ error: 'failed to mint ephemeral token' })
  }
})

app.use(express.static('dist'))

app.listen(PORT, () => {
  console.log(`memory-host → http://localhost:${PORT} (token endpoint /api/token)`)
})
