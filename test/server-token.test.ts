import { describe, expect, it, vi } from 'vitest'

import { enVi } from '../src/lang/en-vi'
import {
  AUTH_TOKENS_ENDPOINT,
  createDevStubToken,
  devStubTokenAllowed,
  isLoopbackHost,
  mintEphemeralToken,
  mintSessionToken,
  type FetchLike,
} from '../src/server/token'

/** An injected fetch: no network, records what it was called with. */
function stubFetch(response: { ok?: boolean; status?: number; body?: unknown; text?: string }) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => response.text ?? '',
      json: async () => response.body ?? {},
    }
  }
  return { fetch, calls }
}

describe('mintEphemeralToken — key in, token out, never the key', () => {
  it('posts to auth_tokens with the key header and the pinned constraints', async () => {
    const { fetch, calls } = stubFetch({ body: { name: 'ephemeral-abc' } })
    const token = await mintEphemeralToken({
      apiKey: 'secret-key',
      sessionConfig: { model: 'models/x', foo: 1 },
      expiresAt: '2026-08-24T00:15:00.000Z',
      fetch,
    })

    expect(token.token).toBe('ephemeral-abc')
    expect(calls[0]!.url).toBe(AUTH_TOKENS_ENDPOINT)
    expect(calls[0]!.init.headers['x-goog-api-key']).toBe('secret-key')
    const sent = JSON.parse(calls[0]!.init.body)
    expect(sent.uses).toBe(1)
    expect(sent.expireTime).toBe('2026-08-24T00:15:00.000Z')
    // The constraint field is flat `bidiGenerateContentSetup`, not the old
    // `liveConnectConstraints: { model, config }`.
    expect(sent.bidiGenerateContentSetup).toEqual({ model: 'models/x', foo: 1 })
    expect(sent).not.toHaveProperty('liveConnectConstraints')
  })

  it('never returns the API key, even if the upstream echoes it', async () => {
    const { fetch } = stubFetch({ body: { token: 'secret-key' } })
    await expect(
      mintEphemeralToken({ apiKey: 'secret-key', sessionConfig: {}, fetch }),
    ).rejects.toThrow(/echoed the API key/)
  })

  it('surfaces an upstream failure without forwarding the whole body', async () => {
    const { fetch } = stubFetch({ ok: false, status: 429, text: 'x'.repeat(1000) })
    await expect(mintEphemeralToken({ apiKey: 'k', sessionConfig: {}, fetch })).rejects.toThrow(/429/)
  })
})

describe('mintSessionToken — the two engine-owned steps of a host mint endpoint', () => {
  it('builds the pinned config and mints against it, returning the grant shape', async () => {
    const { fetch, calls } = stubFetch({ body: { name: 'ephemeral-vi' } })
    const grant = await mintSessionToken({
      apiKey: 'k',
      model: 'gemini-3.5-live-translate-preview',
      languages: enVi,
      target: 'vi',
      fetch,
    })
    expect(grant.token).toBe('ephemeral-vi')
    expect(grant.sessionConfig.model).toBe('models/gemini-3.5-live-translate-preview')
    const sent = JSON.parse(calls[0]!.init.body)
    expect(sent.bidiGenerateContentSetup.model).toBe('models/gemini-3.5-live-translate-preview')
  })

  it('refuses when the model is not configured', async () => {
    const { fetch } = stubFetch({ body: { name: 'x' } })
    await expect(
      mintSessionToken({ apiKey: 'k', model: undefined, languages: enVi, target: 'vi', fetch }),
    ).rejects.toThrow(/model is not configured/)
  })
})

describe('the localhost dev stub', () => {
  it('is allowed only under a development flag AND a loopback host, and is never a key', () => {
    expect(devStubTokenAllowed({ developmentEnvironment: true, requestHost: 'localhost:5173' })).toBe(true)
    expect(devStubTokenAllowed({ developmentEnvironment: true, requestHost: '127.0.0.1' })).toBe(true)
    expect(devStubTokenAllowed({ developmentEnvironment: false, requestHost: 'localhost' })).toBe(false)
    expect(devStubTokenAllowed({ developmentEnvironment: true, requestHost: 'example.com' })).toBe(false)
    expect(devStubTokenAllowed({ developmentEnvironment: true, requestHost: null })).toBe(false)
  })

  it('classifies loopback hosts', () => {
    expect(isLoopbackHost('localhost:3001')).toBe(true)
    expect(isLoopbackHost('[::1]:3001')).toBe(true)
    expect(isLoopbackHost('translate.example.com')).toBe(false)
  })

  it('produces a stub that opens nothing', () => {
    const stub = createDevStubToken()
    expect(stub.startsWith('dev-local-')).toBe(true)
  })
})

// Guard: nothing in the module reaches the real network at import time.
it('does not call fetch when only building constraints', () => {
  const spy = vi.fn()
  vi.stubGlobal('fetch', spy)
  createDevStubToken()
  expect(spy).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})
