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
// Opt IN, not out. Defaulting this to 'development' meant the stub path was
// live unless someone remembered to set APP_ENV — the opposite of the gate the
// comment below and .env.example both describe. The loopback check kept it
// from being reachable in practice, but this is a reference host other
// projects start from, and a security gate that defaults open is the wrong
// shape to copy.
const developmentEnvironment = process.env.APP_ENV === 'development'

const app = express()
app.use(express.json())

app.post('/api/token', async (req, res) => {
  const target = req.body?.target as LangTag | undefined
  if (target !== 'en' && target !== 'vi') {
    res.status(400).json({ error: 'target must be "en" or "vi"' })
    return
  }

  // Optional operator-declared direction (caption-direction-control). Absent
  // means Auto: the session prompt keeps its per-utterance "translate, or
  // repeat if already in the target" hedge. Present, the model gets one
  // unconditional job, pinned into this token — which is why changing
  // direction needs a fresh mint and so a fresh session.
  const speakerLang = req.body?.speakerLang as LangTag | undefined
  if (speakerLang !== undefined && speakerLang !== 'en' && speakerLang !== 'vi') {
    res.status(400).json({ error: 'speakerLang must be "en" or "vi"' })
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
      ...(speakerLang ? { speakerLang } : {}),
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
