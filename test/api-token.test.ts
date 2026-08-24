import { describe, expect, it } from 'vitest'

import handlerModule, { handleTokenRequest } from '../api/token'
import type { MintSessionTokenInput, SessionTokenGrant } from '../src/server/token'

/** Records what the endpoint asked the engine to mint; never hits a network. */
function stubMint(grant?: Partial<SessionTokenGrant>) {
  const calls: MintSessionTokenInput[] = []
  const mint = async (input: MintSessionTokenInput): Promise<SessionTokenGrant> => {
    calls.push(input)
    return {
      token: grant?.token ?? 'ephemeral-abc',
      sessionConfig: grant?.sessionConfig ?? { model: 'models/m' },
      expiresAt: grant?.expiresAt ?? '2026-08-24T00:15:00.000Z',
      model: grant?.model ?? 'models/m',
    }
  }
  return { mint, calls }
}

const ok = { method: 'POST', apiKey: 'secret-key', model: 'gemini-live' }

describe('api/token — the deployed mint endpoint', () => {
  it('returns the token and the pinned sessionConfig the engine expects', async () => {
    const { mint, calls } = stubMint()
    const result = await handleTokenRequest({ ...ok, body: { target: 'vi' }, mint })

    expect(result.status).toBe(200)
    // The `TokenGrant` shape the browser's `mintToken` port destructures.
    expect(result.body).toEqual({ token: 'ephemeral-abc', sessionConfig: { model: 'models/m' } })
    expect(calls[0]!.target).toBe('vi')
    expect(calls[0]!.model).toBe('gemini-live')
  })

  it('accepts a raw JSON string body as well as a parsed one', async () => {
    const { mint, calls } = stubMint()
    const result = await handleTokenRequest({ ...ok, body: JSON.stringify({ target: 'en' }), mint })

    expect(result.status).toBe(200)
    expect(calls[0]!.target).toBe('en')
  })

  it('rejects anything but POST', async () => {
    const { mint, calls } = stubMint()
    const result = await handleTokenRequest({ ...ok, method: 'GET', body: { target: 'en' }, mint })

    expect(result.status).toBe(405)
    expect(calls).toHaveLength(0)
  })

  it('rejects a target outside the pair', async () => {
    const { mint, calls } = stubMint()
    for (const body of [{ target: 'fr' }, { target: undefined }, null, 'not json']) {
      expect((await handleTokenRequest({ ...ok, body, mint })).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  it('reports a missing key and a missing model as distinct misconfigurations', async () => {
    const { mint, calls } = stubMint()
    const noKey = await handleTokenRequest({ ...ok, apiKey: undefined, body: { target: 'en' }, mint })
    const noModel = await handleTokenRequest({ ...ok, model: '  ', body: { target: 'en' }, mint })

    expect(noKey.status).toBe(500)
    expect(noKey.body['error']).toMatch(/GEMINI_API_KEY/)
    expect(noModel.status).toBe(500)
    expect(noModel.body['error']).toMatch(/GEMINI_LIVE_MODEL/)
    // Neither reached the engine: no token was minted for a broken deployment.
    expect(calls).toHaveLength(0)
  })

  it('never forwards an upstream failure body to the browser', async () => {
    const mint = async (): Promise<SessionTokenGrant> => {
      throw new Error('ephemeral token request failed: 429 {"key":"secret-key"}')
    }
    const result = await handleTokenRequest({ ...ok, body: { target: 'en' }, mint })

    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'failed to mint ephemeral token' })
    expect(JSON.stringify(result.body)).not.toContain('secret-key')
  })

  it('writes the result through the serverless response object', async () => {
    const written: Array<{ status: number; body: unknown }> = []
    let status = 0
    const res = {
      status(code: number) {
        status = code
        return res
      },
      json(body: unknown) {
        written.push({ status, body })
        return body
      },
    }
    await handlerModule({ method: 'GET', body: {} }, res)

    expect(written).toEqual([{ status: 405, body: { error: 'method not allowed' } }])
  })
})
