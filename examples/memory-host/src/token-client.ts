/**
 * The host's authorization hook, built once per engine.
 *
 * The engine calls `mintToken` once per target at start and again on every
 * reconnect (tokens are single-use). It hits the host's own endpoint; the API
 * key never reaches this code.
 *
 * Per engine, not per page (review of 2026-10-17): the pair, the declared
 * direction and the session details are pinned into each token, and a run
 * must mint every one of its tokens against the same three. A module-level
 * hook reading live state let a late mint from a run being torn down by
 * `restartIfRunning()` send the NEXT run's settings — two sessions of one
 * feed pinned to different instructions. The closure fixes them at build time.
 */

import type { LangTag, LiveSessionContext, MintToken, TokenGrant } from '@sqrdao/live-translate'

export interface TokenRequest {
  pair: string
  /** The operator-declared speaker language; `null` is Auto. */
  speakerLang: LangTag | null
  /** Session details as typed; `null` sends none. */
  context: LiveSessionContext | null
}

export interface TokenClientDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
    ok: boolean
    status: number
    text(): Promise<string>
    json(): Promise<unknown>
  }>
  /** The current Firebase ID token, fetched per mint (it refreshes near expiry). */
  bearer: () => Promise<string | null>
  /** Signed out elsewhere, or access withdrawn: no reconnect will succeed. */
  onUnauthorized: () => void
}

export function createMintToken(request: TokenRequest, deps: TokenClientDeps): MintToken {
  // Copied, so a caller mutating its object later cannot reach this run.
  const body = {
    pair: request.pair,
    ...(request.speakerLang ? { speakerLang: request.speakerLang } : {}),
    ...(request.context ? { context: structuredClone(request.context) } : {}),
  }
  return async (target): Promise<TokenGrant> => {
    const bearer = await deps.bearer()
    const response = await deps.fetch('/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      // Everything travels with every mint, reconnects included: the session
      // prompt is pinned into the token, so a reconnect that forgot the
      // direction or the glossary would silently lose it mid-session.
      body: JSON.stringify({ ...body, target }),
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) deps.onUnauthorized()
      const detail = await response.text().catch(() => '')
      throw new Error(`token endpoint HTTP ${response.status} ${detail}`.trim())
    }
    const { token, sessionConfig } = (await response.json()) as TokenGrant
    if (!token) throw new Error('token endpoint returned no token')
    return { token, sessionConfig: sessionConfig ?? {} }
  }
}
