/**
 * Vercel serverless mirror of the reference host's token endpoint.
 *
 * The deployed twin of `examples/memory-host/server.ts`: key in, token out,
 * never the key. It owns no protocol knowledge of its own — the pinned
 * session config and the mint call both come from `@sqrdao/live-translate`,
 * so this file cannot drift from the engine the way its predecessor did.
 *
 * It imports the engine from `../src` rather than the published `dist`
 * because the package is built with `moduleResolution: bundler`: `dist`
 * carries extensionless relative imports that Node's ESM loader will not
 * resolve. The function bundler compiles the source directly and the
 * question does not arise.
 */

import { authorize, type Authorization } from './_auth.js'
import { readSessionContext } from './_context.js'
import { enVi } from '../src/lang/en-vi.js'
import { enZh } from '../src/lang/en-zh.js'
import type { LangTag, LanguagePack } from '../src/lang/types.js'
import { viZh } from '../src/lang/vi-zh.js'
import {
  mintSessionToken,
  type MintSessionTokenInput,
  type SessionTokenGrant,
} from '../src/server/token.js'

export interface TokenEndpointResult {
  status: number
  body: Record<string, unknown>
}

type Mint = (input: MintSessionTokenInput) => Promise<SessionTokenGrant>

/**
 * The pairs a caller may ask for, by the id the browser sends as `pair`.
 * Absent means `en-vi`, the only pair callers sent before the others existed.
 */
export const LANGUAGE_PACKS: Readonly<Record<string, LanguagePack>> = {
  'en-vi': enVi,
  'en-zh': enZh,
  'vi-zh': viZh,
}

/** Vercel parses a JSON body for us; a raw string is still accepted. */
type TokenBody = { pair?: unknown; target?: unknown; speakerLang?: unknown; context?: unknown }

function parseBody(body: unknown): TokenBody | null {
  let parsed = body
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  return parsed as TokenBody
}

function readPack(value: unknown): LanguagePack | null {
  if (value === undefined || value === null) return enVi
  return typeof value === 'string' && Object.hasOwn(LANGUAGE_PACKS, value) ? LANGUAGE_PACKS[value]! : null
}

function readLang(value: unknown, pack: LanguagePack): LangTag | null {
  return pack.pair.find((lang) => lang === value) ?? null
}

function oneOf(pack: LanguagePack): string {
  return pack.pair.map((lang) => JSON.stringify(lang)).join(' or ')
}

/**
 * The endpoint's whole decision, free of the serverless request objects so
 * the suite can drive it without a network or a key.
 */
export async function handleTokenRequest(input: {
  method: string | undefined
  body: unknown
  /** Who is asking, decided by `authorize` before any of this runs. */
  authorization: Authorization
  apiKey: string | undefined
  model: string | undefined
  mint?: Mint
}): Promise<TokenEndpointResult> {
  if (input.method !== 'POST') {
    return { status: 405, body: { error: 'method not allowed' } }
  }

  // Each mint spends the deployment's Gemini quota, so it is the thing the
  // sign-in protects: hiding the page alone would leave this callable by anyone
  // who has the URL.
  if (!input.authorization.ok) {
    return { status: input.authorization.status, body: { error: input.authorization.error } }
  }

  const body = parseBody(input.body)
  const languages = readPack(body?.pair)
  if (!languages) {
    return { status: 400, body: { error: `pair must be one of ${Object.keys(LANGUAGE_PACKS).join(', ')}` } }
  }
  const target = readLang(body?.target, languages)
  if (!target) {
    return { status: 400, body: { error: `target must be ${oneOf(languages)}` } }
  }

  // Optional: the operator-declared speaker language
  // (caption-direction-control). Absent means Auto, and the session prompt
  // keeps its per-utterance "translate, or repeat if already in the target"
  // hedge. Present, it pins one unconditional job into the token.
  //
  // A value that is neither language is a 400 rather than a silent fall back
  // to Auto: the caller asked for a direction, and a feed that quietly went
  // back to guessing would look exactly like one that had not.
  const declared = body?.speakerLang
  const speakerLang = declared === undefined || declared === null ? null : readLang(declared, languages)
  if (declared !== undefined && declared !== null && !speakerLang) {
    return { status: 400, body: { error: `speakerLang must be ${oneOf(languages)}` } }
  }

  // Optional programme context (session title, speakers, names). Read before
  // the key checks so a malformed one is the caller's 400 on every
  // deployment, configured or not. Over-long is truncated, wrong-shaped is
  // refused — see `api/_context.ts` for why each.
  const reading = readSessionContext(body?.context)
  if (!reading.ok) {
    return { status: 400, body: { error: reading.error } }
  }

  if (!input.apiKey) {
    // No localhost stub here. That path exists in the reference host so a UI
    // can be built without credentials; a deployed function is never the
    // place for it, and its loopback gate could not fire here anyway.
    return { status: 500, body: { error: 'GEMINI_API_KEY is not configured' } }
  }

  // Named separately from the mint failure below: an unset model is a
  // deployment that was never configured, not an upstream that refused.
  // ADR-001 — the model is verified per deployment, never assumed.
  if (!input.model || !input.model.trim()) {
    return { status: 500, body: { error: 'GEMINI_LIVE_MODEL is not configured' } }
  }

  try {
    // The two engine-owned steps: build the pinned config for this target and
    // mint a single-use token against it. The context is the operator's,
    // carried on every mint the page makes — reconnects included, since each
    // single-use token pins its own copy of the instruction.
    const mint = input.mint ?? mintSessionToken
    const grant = await mint({
      apiKey: input.apiKey,
      model: input.model,
      languages,
      target,
      ...(speakerLang ? { speakerLang } : {}),
      ...(reading.context ? { context: reading.context } : {}),
    })
    return { status: 200, body: { token: grant.token, sessionConfig: grant.sessionConfig } }
  } catch (error) {
    // The upstream body may echo request details; it is logged, never returned.
    console.error('[token] mint failed:', error)
    return { status: 500, body: { error: 'failed to mint ephemeral token' } }
  }
}

interface ServerlessRequest {
  method?: string | undefined
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
}

interface ServerlessResponse {
  status(code: number): ServerlessResponse
  json(body: unknown): unknown
}

export default async function handler(req: ServerlessRequest, res: ServerlessResponse): Promise<void> {
  const header = req.headers?.['authorization']
  const result = await handleTokenRequest({
    method: req.method,
    body: req.body,
    authorization: await authorize(
      // Never the development bypass on a deployment.
      { authorization: Array.isArray(header) ? header[0] : header, host: null, developmentEnvironment: false },
      process.env,
    ),
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_LIVE_MODEL,
  })
  res.status(result.status).json(result.body)
}
