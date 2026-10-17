import { describe, expect, it } from 'vitest'
import { createMintToken, type TokenClientDeps } from '../src/token-client'

function recorder(status = 200) {
  const bodies: Record<string, unknown>[] = []
  const headers: Record<string, string>[] = []
  let unauthorized = 0
  const deps: TokenClientDeps = {
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      headers.push(init.headers)
      return {
        ok: status === 200,
        status,
        text: async () => 'nope',
        json: async () => ({ token: 't', sessionConfig: { model: 'm' } }),
      }
    },
    bearer: async () => 'id-token',
    onUnauthorized: () => { unauthorized++ },
  }
  return { deps, bodies, headers, unauthorized: () => unauthorized }
}

describe('createMintToken', () => {
  it('sends the pair, direction and context with every mint, reconnects included', async () => {
    const { deps, bodies, headers } = recorder()
    const mint = createMintToken({ pair: 'en-vi', speakerLang: 'vi', context: { glossary: ['Messi'] } }, deps)
    await mint('en')
    await mint('en')

    expect(bodies).toEqual([
      { pair: 'en-vi', speakerLang: 'vi', context: { glossary: ['Messi'] }, target: 'en' },
      { pair: 'en-vi', speakerLang: 'vi', context: { glossary: ['Messi'] }, target: 'en' },
    ])
    expect(headers[0]!['authorization']).toBe('Bearer id-token')
  })

  it("keeps a run's settings when a late mint lands after the next run is built", async () => {
    // restartIfRunning(): the old engine is still tearing down — and may still
    // reconnect — when the new one is built with the edited details.
    const { deps, bodies } = recorder()
    const context = { glossary: ['Messi'] }
    const oldRun = createMintToken({ pair: 'en-vi', speakerLang: null, context }, deps)
    context.glossary.push('edited after start')
    const newRun = createMintToken({ pair: 'en-zh', speakerLang: 'en', context: { glossary: ['Álvarez'] } }, deps)
    await newRun('zh')
    await oldRun('vi')

    expect(bodies[1]).toEqual({ pair: 'en-vi', context: { glossary: ['Messi'] }, target: 'vi' })
  })

  it('omits Auto and an absent context rather than sending nulls', async () => {
    const { deps, bodies } = recorder()
    await createMintToken({ pair: 'en-vi', speakerLang: null, context: null }, deps)('vi')
    expect(bodies[0]).toEqual({ pair: 'en-vi', target: 'vi' })
  })

  it('reports a refused caller and throws', async () => {
    const r = recorder(403)
    await expect(createMintToken({ pair: 'en-vi', speakerLang: null, context: null }, r.deps)('vi')).rejects.toThrow(/403/)
    expect(r.unauthorized()).toBe(1)
  })
})
