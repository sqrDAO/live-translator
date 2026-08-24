/**
 * Ephemeral token exchange. Node only: key in, token out, never the key.
 *
 * This is the whole of the server surface. Who may mint, what lease they
 * hold, what is audited and what programme context primes the model are the
 * host's decisions; the host calls this once it has made them.
 */

import { randomUUID } from 'node:crypto'

import {
  assertModelConfigured,
  buildLiveSessionConfig,
  buildTokenConstraints,
  type LiveSessionConfigInput,
} from '../gemini/config.js'
import type { TokenGrant } from '../sink.js'

/**
 * Gemini ephemeral token lifetime.
 *
 * The token's `expireTime` bounds the Live session's whole messaging window,
 * not just the connect: at 5 minutes, production sessions died on an exact
 * 5 m 02 s cycle (measured 2026-08-12), each restart losing the model's
 * conversational context. 15 minutes covers one ~10-minute connection window
 * plus a resumption reconnect. A host whose own authority is longer-lived
 * than this must still re-mint per reconnect (`uses: 1`); a host whose
 * authority is shorter should shorten this, never lengthen it past the
 * authority a leaked token would otherwise outlive
 * (caption-session-resumption).
 */
export const TOKEN_MINUTES = 15

/**
 * v1beta, matching the Live WebSocket endpoint in `session/live-session.ts`.
 * Google removed `v1alpha/authTokens` (404) on 2026-08-09; `auth_tokens` is
 * the renamed surface (fix-caption-token-mint-endpoint).
 */
export const AUTH_TOKENS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens'

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}>

export interface MintEphemeralTokenInput {
  apiKey: string
  /** The exact setup the token pins; see `buildLiveSessionConfig`. */
  sessionConfig: Record<string, unknown>
  /** ISO instant; defaults to `TOKEN_MINUTES` from now. */
  expiresAt?: string
  /** Defaults to the real `fetch`; injected by the suite. */
  fetch?: FetchLike
}

export interface MintedToken {
  token: string
  expiresAt: string
}

export function isoMinutesFromNow(minutes: number, now: number = Date.now()): string {
  return new Date(now + minutes * 60_000).toISOString()
}

/**
 * Exchanges the server-held API key for a single-use ephemeral token whose
 * constraints pin the full session config.
 *
 * The response, the error and the returned object never carry the key. An
 * upstream error body may echo request details; it is truncated into the
 * error message for the host's log and must not be forwarded to a browser.
 */
export async function mintEphemeralToken(input: MintEphemeralTokenInput): Promise<MintedToken> {
  if (!input.apiKey) throw new Error('mintEphemeralToken: apiKey is required')
  const expiresAt = input.expiresAt ?? isoMinutesFromNow(TOKEN_MINUTES)
  const doFetch: FetchLike = input.fetch ?? (globalThis.fetch as unknown as FetchLike)

  const response = await doFetch(AUTH_TOKENS_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': input.apiKey,
    },
    body: JSON.stringify({
      // Single use: every reconnect re-mints, and the token a dead socket was
      // opened with cannot be presented again.
      uses: 1,
      expireTime: expiresAt,
      ...buildTokenConstraints(input.sessionConfig),
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`ephemeral token request failed: ${response.status} ${detail.slice(0, 300)}`)
  }

  const body = (await response.json()) as { name?: string; token?: string }
  const token = body.token ?? body.name
  if (!token) throw new Error('ephemeral token response contained no token')
  if (token === input.apiKey) throw new Error('ephemeral token response echoed the API key; refusing to return it')
  return { token, expiresAt }
}

export type MintSessionTokenInput = Omit<LiveSessionConfigInput, 'model'> & {
  apiKey: string
  /** From host configuration, never hard-coded; bare or `models/`-prefixed. */
  model: string | undefined
  expiresAt?: string
  fetch?: FetchLike
}

/** A grant as the engine's `mintToken` port returns it, plus its expiry. */
export interface SessionTokenGrant extends TokenGrant {
  expiresAt: string
  model: string
}

/**
 * Builds the pinned session config for one target and mints a token against
 * it — the two engine-owned steps of a host's mint endpoint.
 */
export async function mintSessionToken(input: MintSessionTokenInput): Promise<SessionTokenGrant> {
  const { apiKey, model, expiresAt, fetch, ...config } = input
  assertModelConfigured(model)
  const sessionConfig = buildLiveSessionConfig({ ...config, model })
  const minted = await mintEphemeralToken({
    apiKey,
    sessionConfig,
    ...(expiresAt ? { expiresAt } : {}),
    ...(fetch ? { fetch } : {}),
  })
  return { token: minted.token, expiresAt: minted.expiresAt, sessionConfig, model }
}

/**
 * The localhost raw-key fallback that must be impossible outside development.
 *
 * Gated on BOTH an explicit development-environment flag AND a loopback
 * request hostname, and even then it never returns a key: it returns a stub
 * token so a UI can be developed without Gemini credentials. A stub opens
 * nothing — the socket will be refused — which is the point.
 */
export function devStubTokenAllowed(input: {
  /** `true` only when the host's environment is explicitly development. */
  developmentEnvironment: boolean
  requestHost: string | null | undefined
}): boolean {
  if (!input.developmentEnvironment) return false
  return isLoopbackHost(input.requestHost)
}

export function isLoopbackHost(requestHost: string | null | undefined): boolean {
  if (!requestHost) return false
  const host = requestHost.trim().toLowerCase()
  // Bracketed IPv6, with or without a port: `[::1]` / `[::1]:3001`.
  const bracketed = /^\[([^\]]+)\]/.exec(host)
  if (bracketed) return bracketed[1] === '::1'
  // Bare IPv6 loopback (no port can be appended unambiguously).
  if (host === '::1') return true
  const hostname = host.split(':')[0] ?? ''
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

/** Development stub. Not a credential: it opens nothing. */
export function createDevStubToken(): string {
  return `dev-local-${randomUUID()}`
}
