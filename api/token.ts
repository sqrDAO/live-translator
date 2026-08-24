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

import { enVi } from '../src/lang/en-vi.js'
import type { LangTag } from '../src/lang/types.js'
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

/** Vercel parses a JSON body for us; a raw string is still accepted. */
function parseBody(body: unknown): { target?: unknown; speakerLang?: unknown } | null {
  let parsed = body
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  return parsed as { target?: unknown; speakerLang?: unknown }
}

function readLang(value: unknown): LangTag | null {
  if (value === 'en') return 'en'
  if (value === 'vi') return 'vi'
  return null
}

/**
 * The endpoint's whole decision, free of the serverless request objects so
 * the suite can drive it without a network or a key.
 */
export async function handleTokenRequest(input: {
  method: string | undefined
  body: unknown
  apiKey: string | undefined
  model: string | undefined
  mint?: Mint
}): Promise<TokenEndpointResult> {
  if (input.method !== 'POST') {
    return { status: 405, body: { error: 'method not allowed' } }
  }

  const body = parseBody(input.body)
  const target = readLang(body?.target)
  if (!target) {
    return { status: 400, body: { error: 'target must be "en" or "vi"' } }
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
  const speakerLang = declared === undefined || declared === null ? null : readLang(declared)
  if (declared !== undefined && declared !== null && !speakerLang) {
    return { status: 400, body: { error: 'speakerLang must be "en" or "vi"' } }
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
    // mint a single-use token against it. A host with programme context
    // (event, speakers, glossary) would assemble and pass it here.
    const mint = input.mint ?? mintSessionToken
    const grant = await mint({
      apiKey: input.apiKey,
      model: input.model,
      languages: enVi,
      target,
      ...(speakerLang ? { speakerLang } : {}),
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
}

interface ServerlessResponse {
  status(code: number): ServerlessResponse
  json(body: unknown): unknown
}

export default async function handler(req: ServerlessRequest, res: ServerlessResponse): Promise<void> {
  const result = await handleTokenRequest({
    method: req.method,
    body: req.body,
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_LIVE_MODEL,
  })
  res.status(result.status).json(result.body)
}
