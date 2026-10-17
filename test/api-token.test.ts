import { describe, expect, it } from 'vitest'

import { CONTEXT_CEILING, CONTEXT_LIMITS } from '../api/_context'
import handlerModule, { handleTokenRequest } from '../api/token'
import { buildLiveSessionConfig } from '../src/gemini/config'
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

const ok = {
  method: 'POST',
  apiKey: 'secret-key',
  model: 'gemini-live',
  authorization: { ok: true, email: 'ana@example.com' },
} as const

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

  it('mints nothing for a caller who is not signed in or not approved', async () => {
    const { mint, calls } = stubMint()
    const anonymous = await handleTokenRequest({
      ...ok,
      authorization: { ok: false, status: 401, error: 'sign in required' },
      body: { target: 'en' },
      mint,
    })
    const removed = await handleTokenRequest({
      ...ok,
      authorization: { ok: false, status: 403, error: 'not approved' },
      body: { target: 'en' },
      mint,
    })

    expect(anonymous).toEqual({ status: 401, body: { error: 'sign in required' } })
    expect(removed).toEqual({ status: 403, body: { error: 'not approved' } })
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

/**
 * The declared direction (caption-direction-control) has to survive the trip
 * through the endpoint, because it is the *token* that carries it: the model's
 * job — translate everything, or repeat everything — is pinned into the
 * session prompt at mint time. An endpoint that dropped it would leave the
 * captions labelled with the operator's choice while both sessions went on
 * guessing per utterance, which is the mislabelling the control exists to end.
 */
describe('api/token — the operator-declared direction', () => {
  it('passes a declared speaker language through to the mint', async () => {
    const { mint, calls } = stubMint()
    const result = await handleTokenRequest({ ...ok, body: { target: 'vi', speakerLang: 'en' }, mint })

    expect(result.status).toBe(200)
    expect(calls[0]!.speakerLang).toBe('en')
  })

  it('survives a raw JSON string body', async () => {
    const { mint, calls } = stubMint()
    const body = JSON.stringify({ target: 'en', speakerLang: 'vi' })
    expect((await handleTokenRequest({ ...ok, body, mint })).status).toBe(200)
    expect(calls[0]!.speakerLang).toBe('vi')
  })

  it('leaves it unset for Auto, so the prompt keeps its per-utterance hedge', async () => {
    const { mint, calls } = stubMint()
    for (const body of [{ target: 'vi' }, { target: 'vi', speakerLang: undefined }]) {
      expect((await handleTokenRequest({ ...ok, body, mint })).status).toBe(200)
    }
    // Absent, not merely falsy: `buildLiveSessionConfig` branches on presence.
    for (const call of calls) expect('speakerLang' in call).toBe(false)
  })

  it('refuses an unrecognised direction instead of falling back to Auto', async () => {
    // Silently downgrading would be indistinguishable, from the feed, from a
    // direction that was honoured — and the operator only reaches for this
    // control when Auto has already got it wrong.
    const { mint, calls } = stubMint()
    for (const speakerLang of ['fr', 'EN', '', 'auto', 1]) {
      const result = await handleTokenRequest({ ...ok, body: { target: 'vi', speakerLang }, mint })
      expect(result.status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })
})

/**
 * The pair is pinned into the token just as the direction is, so the endpoint
 * must mint against the pack the page asked for — and a page that sends no
 * pair, as every page did before Chinese, must keep getting EN/VI.
 */
describe('api/token — the language pair', () => {
  it('defaults to EN/VI when no pair is sent', async () => {
    const { mint, calls } = stubMint()
    expect((await handleTokenRequest({ ...ok, body: { target: 'vi' }, mint })).status).toBe(200)
    expect(calls[0]!.languages.pair).toEqual(['en', 'vi'])
  })

  it('mints against the requested Chinese pair', async () => {
    const { mint, calls } = stubMint()
    for (const [pair, target, speakerLang] of [['en-zh', 'zh', 'en'], ['vi-zh', 'vi', 'zh']] as const) {
      const result = await handleTokenRequest({ ...ok, body: { pair, target, speakerLang }, mint })
      expect(result.status).toBe(200)
    }
    expect(calls.map((call) => [call.languages.pair, call.target, call.speakerLang])).toEqual([
      [['en', 'zh'], 'zh', 'en'],
      [['vi', 'zh'], 'vi', 'zh'],
    ])
  })

  it('refuses an unknown pair, and a target or direction outside the chosen pair', async () => {
    const { mint, calls } = stubMint()
    for (const body of [
      { pair: 'en-fr', target: 'en' },
      { pair: 'toString', target: 'en' },
      { pair: 'en-zh', target: 'vi' },
      { pair: 'vi-zh', target: 'zh', speakerLang: 'en' },
    ]) {
      expect((await handleTokenRequest({ ...ok, body, mint })).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })
})

/**
 * Programme context (2026-10-17): the glossary clause is the one thing that
 * kept names in the input transcription, so the page sends it with every
 * mint. It is pinned into the token verbatim, which is why the endpoint bounds
 * it — wrong shape refused, over-long truncated (`api/_context.ts`).
 */
describe('api/token — programme context', () => {
  /** A mint that builds the real pinned config, to read the instruction back. */
  function configMint() {
    const configs: Record<string, unknown>[] = []
    const mint = async (input: MintSessionTokenInput): Promise<SessionTokenGrant> => {
      const { apiKey: _apiKey, model, expiresAt: _expiresAt, fetch: _fetch, ...rest } = input
      const sessionConfig = buildLiveSessionConfig({ ...rest, model: model! })
      configs.push(sessionConfig)
      return { token: 't', sessionConfig, expiresAt: 'x', model: model! }
    }
    const instruction = (i: number) =>
      (configs[i]!['systemInstruction'] as { parts: Array<{ text: string }> }).parts[0]!.text
    return { mint, instruction }
  }

  it('passes a cleaned context through to the mint', async () => {
    const { mint, calls } = stubMint()
    const context = {
      sessionTitle: '  Panel:\tthe future\nof football  ',
      speakers: ['Emiliano Martinez — Aston Villa', '', 'Lionel Messi'],
      glossary: ['Julián Álvarez', 'Julián Álvarez', ' sqrDAO '],
    }
    const result = await handleTokenRequest({ ...ok, body: { target: 'vi', context }, mint })

    expect(result.status).toBe(200)
    expect(calls[0]!.context).toEqual({
      sessionTitle: 'Panel: the future of football',
      speakers: ['Emiliano Martinez — Aston Villa', 'Lionel Messi'],
      glossary: ['Julián Álvarez', 'sqrDAO'],
    })
  })

  it('puts the glossary into the pinned instruction', async () => {
    const { mint, instruction } = configMint()
    const body = { target: 'vi', context: { glossary: ['Emiliano Martinez', 'Julián Álvarez'] } }
    expect((await handleTokenRequest({ ...ok, body, mint })).status).toBe(200)
    expect(instruction(0)).toContain('Reproduce these names exactly as written: Emiliano Martinez, Julián Álvarez.')
  })

  it('keeps the instruction byte-identical when the context is absent, null or all blank', async () => {
    const { mint, instruction } = configMint()
    const bodies = [
      { target: 'vi' },
      { target: 'vi', context: null },
      { target: 'vi', context: {} },
      { target: 'vi', context: { sessionTitle: '   ', speakers: ['', ' \n '], glossary: [] } },
    ]
    for (const body of bodies) expect((await handleTokenRequest({ ...ok, body, mint })).status).toBe(200)
    // An empty context object would add the hesitation clause; it must be omitted.
    for (let i = 1; i < bodies.length; i++) expect(instruction(i)).toBe(instruction(0))
    expect(instruction(0)).not.toContain('hesitate')
  })

  it('turns line-breaking controls into spaces and removes invisible format characters', async () => {
    const { mint, calls } = stubMint()
    const context = {
      sessionTitle: 'A\u{0000}B\u{202E}evil\u{202C}\u{2028}C',
      // Soft hyphen, word joiner, invisible separator, Arabic letter mark,
      // zero-width space — each inside a name, which must come out whole.
      glossary: ['Ál\u{00AD}varez', 'Mes\u{2060}si', 'Mar\u{2063}tinez', 'Ju\u{061C}lián', 'x\u{200B}y'],
    }
    expect((await handleTokenRequest({ ...ok, body: { target: 'vi', context }, mint })).status).toBe(200)
    expect(calls[0]!.context).toEqual({
      sessionTitle: 'A Bevil C',
      glossary: ['Álvarez', 'Messi', 'Martinez', 'Julián', 'xy'],
    })
  })

  it('drops an over-long name rather than cutting it, and keeps the first entries past the count', async () => {
    const { mint, calls } = stubMint()
    const long = (n: number, fill: string) => fill.repeat(n)
    const context = {
      speakers: ['Lionel Messi', long(CONTEXT_LIMITS.speaker + 1, 's'), ...Array.from({ length: 30 }, (_, i) => `Speaker ${i}`)],
      glossary: [long(CONTEXT_LIMITS.term, 'g'), long(CONTEXT_LIMITS.term + 1, 'h'), ...Array.from({ length: 200 }, (_, i) => `Term ${i}`)],
    }
    expect((await handleTokenRequest({ ...ok, body: { target: 'vi', context }, mint })).status).toBe(200)

    const got = calls[0]!.context!
    expect(got.speakers).toHaveLength(CONTEXT_LIMITS.speakers)
    expect(got.glossary).toHaveLength(CONTEXT_LIMITS.glossary)
    // Exactly at the limit is kept; one past it is gone, not shortened.
    expect(got.glossary![0]).toBe(long(CONTEXT_LIMITS.term, 'g'))
    expect(got.glossary![1]).toBe('Term 0')
    expect(got.glossary!.some((g) => g.startsWith('h'))).toBe(false)
    expect(got.speakers!.slice(0, 2)).toEqual(['Lionel Messi', 'Speaker 0'])
  })

  it('cuts an over-long title at a word boundary', async () => {
    const { mint, calls } = stubMint()
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const context = { sessionTitle: words, eventName: words }
    expect((await handleTokenRequest({ ...ok, body: { target: 'vi', context }, mint })).status).toBe(200)

    const got = calls[0]!.context!
    expect(Array.from(got.sessionTitle!).length).toBeLessThanOrEqual(CONTEXT_LIMITS.title)
    // A whole-word prefix: never "word1" left over from "word17".
    expect(words.startsWith(`${got.sessionTitle!} `)).toBe(true)
    expect(got.eventName).toBe(got.sessionTitle)
  })

  it('takes the delimiters of the instruction clauses out of the text', async () => {
    const { mint, calls } = stubMint()
    const context = {
      sessionTitle: 'The "future" of “football”',
      speakers: ['Emiliano Martinez — Aston Villa, goalkeeper; Lionel Messi'],
      glossary: ['Lionel Messi, Julián Álvarez; sqrDAO、EMpower'],
    }
    expect((await handleTokenRequest({ ...ok, body: { target: 'vi', context }, mint })).status).toBe(200)
    expect(calls[0]!.context).toEqual({
      sessionTitle: "The 'future' of 'football'",
      // A comma stays inside a speaker; a semicolon (the clause's joiner) splits.
      speakers: ['Emiliano Martinez — Aston Villa, goalkeeper', 'Lionel Messi'],
      glossary: ['Lionel Messi', 'Julián Álvarez', 'sqrDAO', 'EMpower'],
    })
  })

  it('refuses a payload past the raw ceiling before cleaning it', async () => {
    const { mint, calls } = stubMint()
    for (const context of [
      { sessionTitle: 'x'.repeat(CONTEXT_CEILING.chars + 1) },
      { glossary: Array(CONTEXT_CEILING.items + 1).fill('a') },
      { speakers: ['y'.repeat(CONTEXT_CEILING.chars + 1)] },
    ]) {
      expect((await handleTokenRequest({ ...ok, body: { target: 'vi', context }, mint })).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  it('cuts by code point, never through a surrogate pair', async () => {
    const { mint, calls } = stubMint()
    const context = { sessionTitle: '😀'.repeat(200) }
    expect((await handleTokenRequest({ ...ok, body: { target: 'vi', context }, mint })).status).toBe(200)
    expect(Array.from(calls[0]!.context!.sessionTitle!)).toEqual(Array(CONTEXT_LIMITS.title).fill('😀'))
  })

  it('refuses a wrongly shaped context instead of minting past it', async () => {
    const { mint, calls } = stubMint()
    for (const context of [
      'Messi',
      ['Messi'],
      42,
      { sessionTitle: 7 },
      { eventName: ['x'] },
      { speakers: 'Messi' },
      { speakers: ['Messi', 7] },
      { glossary: [{ name: 'Messi' }] },
    ]) {
      const result = await handleTokenRequest({ ...ok, body: { target: 'vi', context }, mint })
      expect(result.status).toBe(400)
      expect(result.body['error']).toMatch(/^context/)
    }
    expect(calls).toHaveLength(0)
  })

  it('survives a raw JSON string body', async () => {
    const { mint, calls } = stubMint()
    const body = JSON.stringify({ target: 'en', context: { glossary: ['Lionel Messi'] } })
    expect((await handleTokenRequest({ ...ok, body, mint })).status).toBe(200)
    expect(calls[0]!.context).toEqual({ glossary: ['Lionel Messi'] })
  })

  it('still mints nothing for an unapproved caller, context or not', async () => {
    const { mint, calls } = stubMint()
    const result = await handleTokenRequest({
      ...ok,
      authorization: { ok: false, status: 403, error: 'not approved' },
      body: { target: 'vi', context: { glossary: ['Messi'] } },
      mint,
    })
    expect(result.status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})
