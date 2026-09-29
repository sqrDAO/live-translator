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
import { enZh } from '@sqrdao/live-translate/lang/en-zh'
import { viZh } from '@sqrdao/live-translate/lang/vi-zh'
import {
  createDevStubToken,
  devStubTokenAllowed,
  mintSessionToken,
} from '@sqrdao/live-translate/server'
import type { LangTag, LanguagePack } from '@sqrdao/live-translate/server'

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

// The pairs the page may ask for, by the id it sends as `pair`; absent is EN/VI.
const PACKS: Readonly<Record<string, LanguagePack>> = { 'en-vi': enVi, 'en-zh': enZh, 'vi-zh': viZh }

const app = express()
app.use(express.json())

app.post('/api/token', async (req, res) => {
  const pairId: unknown = req.body?.pair ?? 'en-vi'
  const languages = typeof pairId === 'string' && Object.hasOwn(PACKS, pairId) ? PACKS[pairId]! : null
  if (!languages) {
    res.status(400).json({ error: `pair must be one of ${Object.keys(PACKS).join(', ')}` })
    return
  }
  const inPair = (value: unknown): value is LangTag => languages.pair.some((lang) => lang === value)
  const allowed = languages.pair.map((lang) => JSON.stringify(lang)).join(' or ')

  const target: unknown = req.body?.target
  if (!inPair(target)) {
    res.status(400).json({ error: `target must be ${allowed}` })
    return
  }

  // Optional operator-declared direction (caption-direction-control). Absent
  // means Auto: the session prompt keeps its per-utterance "translate, or
  // repeat if already in the target" hedge. Present, the model gets one
  // unconditional job, pinned into this token — which is why changing
  // direction needs a fresh mint and so a fresh session.
  const declared: unknown = req.body?.speakerLang
  if (declared !== undefined && !inPair(declared)) {
    res.status(400).json({ error: `speakerLang must be ${allowed}` })
    return
  }
  const speakerLang = declared as LangTag | undefined

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
      languages,
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
