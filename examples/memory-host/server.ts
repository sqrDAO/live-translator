/**
 * The reference host's token endpoint. Node only.
 *
 * Key in, token out — for a signed-in, approved caller only. "Who may mint"
 * is answered by `api/_auth.ts` (Firebase sign-in, admin-approved requests),
 * shared with the deployed functions so the two cannot disagree. "What
 * programme context primes the model" is the operator's, typed into the page
 * and bounded by `api/_context.ts` — likewise shared.
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

import { authorize, handleRequestsRequest, handleSessionRequest } from '../../api/_auth.js'
import { readSessionContext } from '../../api/_context.js'

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

const authRequest = (req: express.Request) => ({
  authorization: req.headers.authorization,
  host: req.headers.host ?? null,
  developmentEnvironment,
})

app.all('/api/session', async (req, res) => {
  const result = await handleSessionRequest({ ...authRequest(req), method: req.method, env: process.env })
  res.setHeader('Cache-Control', 'no-store')
  res.status(result.status).json(result.body)
})

app.all('/api/requests', async (req, res) => {
  const result = await handleRequestsRequest({ ...authRequest(req), method: req.method, body: req.body, env: process.env })
  res.setHeader('Cache-Control', 'no-store')
  res.status(result.status).json(result.body)
})

app.post('/api/token', async (req, res) => {
  const authorization = await authorize(authRequest(req), process.env)
  if (!authorization.ok) {
    res.status(authorization.status).json({ error: authorization.error })
    return
  }

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

  // Optional programme context: over-long is truncated, wrong-shaped is a 400.
  const reading = readSessionContext(req.body?.context)
  if (!reading.ok) {
    res.status(400).json({ error: reading.error })
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
    // mint a single-use token against it, with the operator's context if any.
    const grant = await mintSessionToken({
      apiKey,
      model: MODEL,
      languages,
      target,
      ...(speakerLang ? { speakerLang } : {}),
      ...(reading.context ? { context: reading.context } : {}),
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
