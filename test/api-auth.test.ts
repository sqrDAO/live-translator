import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEV_USER,
  FIREBASE_CERTS_URL,
  authorize,
  bearerToken,
  handleRequestsRequest,
  handleSessionRequest,
  readFirebaseConfig,
  resetCertsCache,
  verifyFirebaseIdToken,
  type FetchLike,
} from '../api/_auth'

const PROJECT = 'live-test'
const NOW = Date.UTC(2026, 9, 17, 12)
const env = {
  FIREBASE_PROJECT_ID: PROJECT,
  FIREBASE_API_KEY: 'web-key',
  FIREBASE_AUTH_DOMAIN: `${PROJECT}.firebaseapp.com`,
  FIREBASE_APP_ID: '1:1:web:1',
}

/** A stand-in for Google: its own signing key, served as a JWKS. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'k1', alg: 'RS256', use: 'sig' }

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

function idToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header })
  const body = b64({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: 'uid-ana',
    email: 'Ana@Example.com',
    name: 'Ana',
    iat: NOW / 1000 - 10,
    auth_time: NOW / 1000 - 10,
    exp: NOW / 1000 + 3600,
    ...claims,
  })
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')
  return `${head}.${body}.${signature}`
}

/**
 * Google's key endpoint and a Firestore that holds `users/{uid}` records. It
 * records which bearer each call carried: the server must act as the caller,
 * so the rules apply.
 */
function fakeGoogle(records: Record<string, string> = {}, adminTokens: readonly string[] = []) {
  const calls: Array<{ url: string; method: string; bearer: string | null; body?: unknown }> = []
  const response = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'public, max-age=600' },
    json: async () => body,
  })
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const bearer = bearerToken(init?.headers?.['authorization'])
    calls.push({ url, method, bearer, ...(init?.body ? { body: JSON.parse(init.body) } : {}) })
    if (url === FIREBASE_CERTS_URL) return response(200, { keys: [jwk] })
    // Stands in for the rules: only admin tokens may read the admin list,
    // list requests or decide one.
    const admin = bearer !== null && adminTokens.includes(bearer)
    if (url.endsWith('/documents/config/admins')) return admin ? response(200, { fields: {} }) : response(403)
    if (url.endsWith('/documents:commit')) {
      if (!admin) return response(403)
      const write = (JSON.parse(init!.body!) as { writes: Array<{ update: { name: string; fields: { status: { stringValue: string } } } }> }).writes[0]!
      const uid = write.update.name.slice(write.update.name.lastIndexOf('/') + 1)
      if (!(uid in records)) return response(404)
      records[uid] = write.update.fields.status.stringValue
      return response(200)
    }
    if (/\/documents\/users\?pageSize=/.test(url)) {
      if (!admin) return response(403)
      const documents = Object.entries(records).map(([uid, status]) => ({
        name: `projects/${PROJECT}/databases/(default)/documents/users/${uid}`,
        fields: { email: { stringValue: `${uid}@x.io` }, status: { stringValue: status }, requestedAt: { timestampValue: '2026-10-17T00:00:00Z' } },
      }))
      return response(200, { documents })
    }
    const create = /\/documents\/users\?documentId=([^&]+)$/.exec(url)
    if (create && method === 'POST') {
      const uid = decodeURIComponent(create[1]!)
      if (uid in records) return response(409)
      const fields = (JSON.parse(init!.body!) as { fields: { status: { stringValue: string } } }).fields
      records[uid] = fields.status.stringValue
      return response(200)
    }
    const read = /\/documents\/users\/([^/?]+)$/.exec(url)
    if (read && method === 'GET') {
      const uid = decodeURIComponent(read[1]!)
      return uid in records ? response(200, { fields: { status: { stringValue: records[uid] } } }) : response(404)
    }
    return response(500)
  }
  return { fetch, calls, records }
}

beforeEach(resetCertsCache)

describe('configuration', () => {
  it('needs all four Firebase settings, and names the missing one', () => {
    expect(readFirebaseConfig(env)).toEqual({
      ok: true,
      config: { projectId: PROJECT, apiKey: 'web-key', authDomain: `${PROJECT}.firebaseapp.com`, appId: '1:1:web:1' },
    })
    expect(readFirebaseConfig({ ...env, FIREBASE_APP_ID: ' ' })).toEqual({ ok: false, error: 'FIREBASE_APP_ID is not configured' })
  })

  it('reads only a well-formed bearer header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
    expect(bearerToken('bearer  abc')).toBe('abc')
    for (const header of [undefined, '', 'Basic abc', 'Bearer', 'Bearer a b']) expect(bearerToken(header)).toBeNull()
  })
})

describe('Firebase ID token verification', () => {
  const verifyAt = (token: string, fetch = fakeGoogle().fetch) =>
    verifyFirebaseIdToken(token, { projectId: PROJECT, fetch, now: NOW })

  it('accepts a current token for this project, lowercasing the email', async () => {
    await expect(verifyAt(idToken())).resolves.toEqual({ uid: 'uid-ana', email: 'ana@example.com', name: 'Ana' })
  })

  it.each([
    ['another project', { aud: 'other-project' }],
    ['another issuer', { iss: 'https://securetoken.google.com/other-project' }],
    ['an expired token', { exp: NOW / 1000 - 3600 }],
    ['a token issued in the future', { iat: NOW / 1000 + 3600 }],
    ['a sign-in in the future', { auth_time: NOW / 1000 + 3600 }],
    ['no subject', { sub: '' }],
  ])('refuses %s', async (_name, claims) => {
    await expect(verifyAt(idToken(claims))).rejects.toThrow()
  })

  it('refuses a token whose payload was altered after signing', async () => {
    const [head, , signature] = idToken().split('.')
    const forged = `${head}.${b64({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'admin', exp: NOW / 1000 + 60, iat: 0, auth_time: 0 })}.${signature}`
    await expect(verifyAt(forged)).rejects.toThrow('bad signature')
  })

  it('refuses any algorithm but RS256, before looking up a key', async () => {
    const google = fakeGoogle()
    const unsigned = `${b64({ alg: 'none', kid: 'k1' })}.${b64({ aud: PROJECT })}.`
    await expect(verifyAt(unsigned, google.fetch)).rejects.toThrow('unsupported token header')
    expect(google.calls).toHaveLength(0)
  })

  it('caches the key set, and refetches once for an unknown key id', async () => {
    const google = fakeGoogle()
    await verifyAt(idToken(), google.fetch)
    await verifyAt(idToken(), google.fetch)
    expect(google.calls).toHaveLength(1)
    await expect(verifyAt(idToken({}, { kid: 'rotated' }), google.fetch)).rejects.toThrow('unknown signing key')
    expect(google.calls).toHaveLength(2)
  })
})

describe('authorize — who may mint', () => {
  const request = (token?: string) => ({
    authorization: token ? `Bearer ${token}` : undefined,
    host: 'translate.example.com',
    developmentEnvironment: false,
  })

  it('admits an approved caller, reading the record as that caller', async () => {
    const google = fakeGoogle({ 'uid-ana': 'approved' })
    const token = idToken()
    const result = await authorize(request(token), env, { fetch: google.fetch, now: NOW })

    expect(result).toEqual({ ok: true, email: 'ana@example.com' })
    const read = google.calls.find((call) => call.url.includes('/documents/users/uid-ana'))!
    expect(read.bearer).toBe(token)
  })

  it.each([['pending'], ['denied'], ['Approved'], ['']])('refuses a record that says %j', async (status) => {
    const google = fakeGoogle({ 'uid-ana': status })
    expect(await authorize(request(idToken()), env, { fetch: google.fetch, now: NOW })).toMatchObject({ ok: false, status: 403 })
  })

  it('admits an admin with no approved record of their own', async () => {
    const token = idToken()
    const google = fakeGoogle({}, [token])
    expect(await authorize(request(token), env, { fetch: google.fetch, now: NOW })).toEqual({ ok: true, email: 'ana@example.com' })
  })

  it('refuses a caller with no record, and files none: only /api/session requests access', async () => {
    const google = fakeGoogle()
    expect(await authorize(request(idToken()), env, { fetch: google.fetch, now: NOW })).toMatchObject({ ok: false, status: 403 })
    expect(google.records).toEqual({})
  })

  it('refuses no token, or a bad one, with 401', async () => {
    const google = fakeGoogle({ 'uid-ana': 'approved' })
    expect(await authorize(request(), env, { fetch: google.fetch, now: NOW })).toMatchObject({ ok: false, status: 401 })
    const expired = idToken({ exp: NOW / 1000 - 3600 })
    expect(await authorize(request(expired), env, { fetch: google.fetch, now: NOW })).toMatchObject({ ok: false, status: 401 })
  })

  it('fails closed when Firestore cannot be read', async () => {
    const google = fakeGoogle()
    const failing: FetchLike = async (url, init) =>
      url === FIREBASE_CERTS_URL ? google.fetch(url, init) : { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) }
    expect(await authorize(request(idToken()), env, { fetch: failing, now: NOW })).toMatchObject({ ok: false, status: 500 })
  })

  it('fails closed when the deployment is not configured', async () => {
    expect(await authorize(request(idToken()), { ...env, FIREBASE_API_KEY: '' })).toMatchObject({ ok: false, status: 500 })
  })

  it('uses the development user only on a dev flag, a loopback host and no Firebase project', async () => {
    const local = { authorization: undefined, host: 'localhost:5173', developmentEnvironment: true }
    expect(await authorize(local, {})).toEqual({ ok: true, email: DEV_USER })
    expect(await authorize({ ...local, developmentEnvironment: false }, {})).toMatchObject({ ok: false, status: 500 })
    expect(await authorize({ ...local, host: 'translate.example.com' }, {})).toMatchObject({ ok: false, status: 500 })
    // A configured project always means real sign-in, on localhost too.
    expect(await authorize(local, env)).toMatchObject({ ok: false, status: 401 })
  })
})

describe('/api/session', () => {
  const post = (token: string | undefined, google: ReturnType<typeof fakeGoogle>) =>
    handleSessionRequest(
      {
        method: 'POST',
        authorization: token ? `Bearer ${token}` : undefined,
        host: 'translate.example.com',
        developmentEnvironment: false,
        env,
      },
      { fetch: google.fetch, now: NOW },
    )

  it('hands the page the public web config', async () => {
    const result = await handleSessionRequest({ method: 'GET', authorization: undefined, host: null, developmentEnvironment: false, env })
    expect(result.status).toBe(200)
    expect(result.body['firebase']).toEqual({ projectId: PROJECT, apiKey: 'web-key', authDomain: `${PROJECT}.firebaseapp.com`, appId: '1:1:web:1' })
  })

  it('files a pending request on first sign-in, as the caller', async () => {
    const google = fakeGoogle()
    const token = idToken()
    const result = await post(token, google)

    expect(result).toEqual({ status: 200, body: { email: 'ana@example.com', access: 'pending', admin: false } })
    expect(google.records).toEqual({ 'uid-ana': 'pending' })
    const create = google.calls.find((call) => call.method === 'POST')!
    expect(create.bearer).toBe(token)
    expect(create.body).toEqual({
      fields: {
        email: { stringValue: 'ana@example.com' },
        status: { stringValue: 'pending' },
        requestedAt: { timestampValue: new Date(NOW).toISOString() },
        name: { stringValue: 'Ana' },
      },
    })
  })

  it('reports an existing record without filing another', async () => {
    for (const status of ['approved', 'denied', 'pending'] as const) {
      const google = fakeGoogle({ 'uid-ana': status })
      expect((await post(idToken(), google)).body).toEqual({ email: 'ana@example.com', access: status, admin: false })
      expect(google.calls.some((call) => call.method === 'POST')).toBe(false)
    }
  })

  it('reports an admin as approved and files no request for them', async () => {
    const token = idToken()
    const google = fakeGoogle({}, [token])
    expect((await post(token, google)).body).toEqual({ email: 'ana@example.com', access: 'approved', admin: true })
    expect(google.records).toEqual({})
  })

  it('refuses a missing or unverifiable token', async () => {
    const google = fakeGoogle()
    expect((await post(undefined, google)).status).toBe(401)
    expect((await post(idToken({ aud: 'other' }), google)).status).toBe(401)
    expect(google.records).toEqual({})
  })

  it('reports the development user when no project is configured locally', async () => {
    const result = await handleSessionRequest({ method: 'GET', authorization: undefined, host: '127.0.0.1:3001', developmentEnvironment: true, env: {} })
    expect(result.body).toMatchObject({ email: DEV_USER, access: 'approved', dev: true })
  })
})

describe('/api/requests — admins deciding', () => {
  const call = (method: string, token: string | undefined, google: ReturnType<typeof fakeGoogle>, body?: unknown) =>
    handleRequestsRequest(
      { method, body, authorization: token ? `Bearer ${token}` : undefined, host: null, developmentEnvironment: false, env },
      { fetch: google.fetch, now: NOW },
    )

  it('lists requests for an admin', async () => {
    const token = idToken()
    const google = fakeGoogle({ bob: 'pending', cy: 'approved' }, [token])
    const result = await call('GET', token, google)

    expect(result.status).toBe(200)
    expect(result.body['requests']).toEqual([
      { uid: 'bob', email: 'bob@x.io', name: null, status: 'pending', requestedAt: '2026-10-17T00:00:00Z', decidedBy: null, decidedAt: null },
      { uid: 'cy', email: 'cy@x.io', name: null, status: 'approved', requestedAt: '2026-10-17T00:00:00Z', decidedBy: null, decidedAt: null },
    ])
  })

  it('records a decision as the admin, with a server timestamp', async () => {
    const token = idToken()
    const google = fakeGoogle({ bob: 'pending' }, [token])
    expect(await call('POST', token, google, { uid: 'bob', status: 'approved' })).toEqual({ status: 200, body: { uid: 'bob', status: 'approved' } })
    expect(google.records['bob']).toBe('approved')

    const commit = google.calls.find((c) => c.url.endsWith(':commit'))!
    expect(commit.bearer).toBe(token)
    expect(commit.body).toMatchObject({
      writes: [{
        update: { fields: { status: { stringValue: 'approved' }, decidedBy: { stringValue: 'ana@example.com' } } },
        updateMask: { fieldPaths: ['status', 'decidedBy'] },
        updateTransforms: [{ fieldPath: 'decidedAt', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: true },
      }],
    })
  })

  it('refuses a non-admin, and changes nothing', async () => {
    const google = fakeGoogle({ bob: 'pending' })
    expect((await call('GET', idToken(), google)).status).toBe(403)
    expect((await call('POST', idToken(), google, { uid: 'bob', status: 'approved' })).status).toBe(403)
    expect(google.records['bob']).toBe('pending')
  })

  it('refuses a bad uid or status, and reports a missing request', async () => {
    const token = idToken()
    const google = fakeGoogle({ bob: 'pending' }, [token])
    for (const body of [{ uid: '../config/admins', status: 'approved' }, { uid: 'bob', status: 'owner' }, {}, 'not json']) {
      expect((await call('POST', token, google, body)).status).toBe(400)
    }
    expect((await call('POST', token, google, { uid: 'nobody', status: 'approved' })).status).toBe(404)
    expect(google.records['bob']).toBe('pending')
  })

  it('needs a signed-in caller', async () => {
    expect((await call('GET', undefined, fakeGoogle())).status).toBe(401)
  })
})
