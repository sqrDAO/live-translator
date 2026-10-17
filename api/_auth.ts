/**
 * Who may use the deployed host: Firebase sign-in, with self-serve access
 * requests approved by an admin.
 *
 * The engine is deliberately silent on identity (README, "The boundary"), so
 * this is the host's answer, shared by the Vercel functions and the reference
 * host's Express server. The `_` prefix keeps Vercel from deploying this file
 * as an endpoint of its own.
 *
 * The flow: the page signs in with Firebase Auth and sends its ID token as a
 * bearer token. The first sign-in files `users/{uid}` in Firestore as
 * `pending`; an admin flips it to `approved` (or `denied`) in the Firebase
 * console. Every mint verifies the ID token and re-reads that record, so a
 * change takes effect on the person's next mint.
 *
 * Firestore is read and written with the caller's own ID token, through the
 * REST API, so `firestore.rules` applies: a person can file their own request
 * and read it, never change it. That keeps this server free of a
 * service-account key, and keeps `node:crypto` the only thing it needs —
 * the package gains no dependency.
 */

import { createPublicKey, verify, type JsonWebKey } from 'node:crypto'

import { devStubTokenAllowed } from '../src/server/token.js'

/** Firebase signs ID tokens with these keys; Google rotates them. */
export const FIREBASE_CERTS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
const FIRESTORE_URL = 'https://firestore.googleapis.com/v1'

/** Tolerated clock difference between this server and Google's, in seconds. */
const CLOCK_SKEW_S = 60

/** The public web config the page initializes Firebase with. Not a secret. */
export interface FirebaseWebConfig {
  apiKey: string
  authDomain: string
  projectId: string
  appId: string
}

export type FirebaseConfigResult = { ok: true; config: FirebaseWebConfig } | { ok: false; error: string }

const CONFIG_ENV: ReadonlyArray<[keyof FirebaseWebConfig, string]> = [
  ['projectId', 'FIREBASE_PROJECT_ID'],
  ['apiKey', 'FIREBASE_API_KEY'],
  ['authDomain', 'FIREBASE_AUTH_DOMAIN'],
  ['appId', 'FIREBASE_APP_ID'],
]

/**
 * Reads the Firebase settings, failing closed: a deployment missing any of
 * them admits nobody rather than everybody.
 */
export function readFirebaseConfig(env: Record<string, string | undefined>): FirebaseConfigResult {
  const config: Partial<FirebaseWebConfig> = {}
  for (const [field, name] of CONFIG_ENV) {
    const value = env[name]?.trim()
    if (!value) return { ok: false, error: `${name} is not configured` }
    config[field] = value
  }
  return { ok: true, config: config as FirebaseWebConfig }
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}>

export interface AuthDeps {
  /** Defaults to the real `fetch`; injected by the suite. */
  fetch?: FetchLike
  now?: number
}

const realFetch = (deps: AuthDeps): FetchLike => deps.fetch ?? (globalThis.fetch as unknown as FetchLike)

// --- Firebase ID token -------------------------------------------------------

interface CachedCerts {
  keys: Map<string, JsonWebKey>
  expiresAt: number
}

let certsCache: CachedCerts | null = null

/** Test seam: drops the cached key set so a suite starts from nothing. */
export function resetCertsCache(): void {
  certsCache = null
}

async function loadCerts(doFetch: FetchLike, now: number): Promise<CachedCerts> {
  const response = await doFetch(FIREBASE_CERTS_URL)
  if (!response.ok) throw new Error(`Firebase certs request failed: ${response.status}`)
  const body = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: string }> }
  const keys = new Map<string, JsonWebKey>()
  for (const key of body.keys ?? []) if (key.kid) keys.set(key.kid, key)
  // Google publishes how long the set may be cached; an hour when it does not say.
  const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')
  const ttlMs = maxAge ? Number(maxAge[1]) * 1000 : 3_600_000
  certsCache = { keys, expiresAt: now + ttlMs }
  return certsCache
}

async function signingKey(kid: string, doFetch: FetchLike, now: number): Promise<JsonWebKey | null> {
  const cached = certsCache && certsCache.expiresAt > now ? certsCache : await loadCerts(doFetch, now)
  const key = cached.keys.get(kid)
  if (key || cached !== certsCache) return key ?? null
  // An unknown kid on a cached set may be a rotation the cache predates:
  // refetch once rather than refusing every sign-in until the cache expires.
  return (await loadCerts(doFetch, now)).keys.get(kid) ?? null
}

function decodeSegment(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  if (!parsed || typeof parsed !== 'object') throw new Error('malformed segment')
  return parsed as Record<string, unknown>
}

export interface FirebaseUser {
  uid: string
  email: string | null
  /** False for an email/password account whose link has not been clicked. */
  emailVerified: boolean
  name: string | null
}

/**
 * Verifies a Firebase Auth ID token the way the Admin SDK does: RS256, a
 * current Google signing key, this project as audience and issuer, unexpired,
 * and a non-empty subject. Throws on anything else.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  options: { projectId: string } & AuthDeps,
): Promise<FirebaseUser> {
  const now = options.now ?? Date.now()
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('not a JWT')
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
  const header = decodeSegment(headerPart)
  // RS256 only: a token naming any other algorithm, `none` included, is refused
  // before a key is ever looked up.
  if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') throw new Error('unsupported token header')

  const jwk = await signingKey(header['kid'], realFetch(options), now)
  if (!jwk) throw new Error('unknown signing key')
  const signed = verify(
    'RSA-SHA256',
    Buffer.from(`${headerPart}.${payloadPart}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(signaturePart, 'base64url'),
  )
  if (!signed) throw new Error('bad signature')

  const claims = decodeSegment(payloadPart)
  if (claims['aud'] !== options.projectId) throw new Error('wrong audience')
  if (claims['iss'] !== `https://securetoken.google.com/${options.projectId}`) throw new Error('wrong issuer')
  const nowS = now / 1000
  if (typeof claims['exp'] !== 'number' || claims['exp'] + CLOCK_SKEW_S < nowS) throw new Error('expired')
  for (const claim of ['iat', 'auth_time']) {
    if (typeof claims[claim] !== 'number' || (claims[claim] as number) - CLOCK_SKEW_S > nowS) {
      throw new Error(`bad ${claim}`)
    }
  }
  if (typeof claims['sub'] !== 'string' || !claims['sub'] || claims['sub'].length > 128) throw new Error('bad subject')
  return {
    uid: claims['sub'],
    email: typeof claims['email'] === 'string' ? claims['email'].toLowerCase() : null,
    emailVerified: claims['email_verified'] === true,
    name: typeof claims['name'] === 'string' ? claims['name'] : null,
  }
}

// --- Access record -----------------------------------------------------------

export type AccessStatus = 'approved' | 'pending' | 'denied'

function userDocUrl(projectId: string, uid: string): string {
  return `${FIRESTORE_URL}/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`
}

/**
 * The caller's access record, read as the caller. `null` when none has been
 * filed. Anything but an exact `approved` or `denied` reads as `pending`, so
 * a typo in the console withholds access rather than granting it.
 */
export async function readAccess(
  user: FirebaseUser,
  idToken: string,
  projectId: string,
  deps: AuthDeps = {},
): Promise<AccessStatus | null> {
  const response = await realFetch(deps)(userDocUrl(projectId, user.uid), {
    headers: { authorization: `Bearer ${idToken}` },
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`access record read failed: ${response.status}`)
  const body = (await response.json()) as { fields?: { status?: { stringValue?: string } } }
  const status = body.fields?.status?.stringValue
  return status === 'approved' || status === 'denied' ? status : 'pending'
}

/** Files the caller's first request as `pending`. A concurrent duplicate is harmless. */
export async function requestAccess(
  user: FirebaseUser,
  idToken: string,
  projectId: string,
  deps: AuthDeps = {},
): Promise<void> {
  if (!user.email) throw new Error('an access request needs an email to show the admin')
  const fields: Record<string, unknown> = {
    email: { stringValue: user.email },
    status: { stringValue: 'pending' },
    requestedAt: { timestampValue: new Date(deps.now ?? Date.now()).toISOString() },
    ...(user.name ? { name: { stringValue: user.name } } : {}),
  }
  const url = `${FIRESTORE_URL}/projects/${projectId}/databases/(default)/documents/users?documentId=${encodeURIComponent(user.uid)}`
  const response = await realFetch(deps)(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  // 409: a second tab filed it first.
  if (!response.ok && response.status !== 409) throw new Error(`access request failed: ${response.status}`)
}

/**
 * Whether the caller is an admin: `config/admins` is readable only by the
 * emails it lists, so the read succeeding is the answer. The list itself
 * lives in Firestore and the rules, never in this server.
 */
export async function isAdmin(idToken: string, projectId: string, deps: AuthDeps = {}): Promise<boolean> {
  const url = `${FIRESTORE_URL}/projects/${projectId}/databases/(default)/documents/config/admins`
  const response = await realFetch(deps)(url, { headers: { authorization: `Bearer ${idToken}` } })
  if (response.ok) return true
  if (response.status === 403 || response.status === 404) return false
  throw new Error(`admin check failed: ${response.status}`)
}

export interface AccessRequest {
  uid: string
  email: string | null
  name: string | null
  status: AccessStatus
  requestedAt: string | null
  decidedBy: string | null
  decidedAt: string | null
}

type FirestoreFields = Record<string, { stringValue?: string; timestampValue?: string } | undefined>

function fromDocument(doc: { name: string; fields?: FirestoreFields }): AccessRequest {
  const field = (key: string) => doc.fields?.[key]?.stringValue ?? doc.fields?.[key]?.timestampValue ?? null
  const status = field('status')
  return {
    uid: decodeURIComponent(doc.name.slice(doc.name.lastIndexOf('/') + 1)),
    email: field('email'),
    name: field('name'),
    status: status === 'approved' || status === 'denied' ? status : 'pending',
    requestedAt: field('requestedAt'),
    decidedBy: field('decidedBy'),
    decidedAt: field('decidedAt'),
  }
}

/** Every access request, newest first. Admins only — the rules refuse anyone else. */
export async function listRequests(idToken: string, projectId: string, deps: AuthDeps = {}): Promise<AccessRequest[]> {
  const requests: AccessRequest[] = []
  let pageToken = ''
  do {
    const url =
      `${FIRESTORE_URL}/projects/${projectId}/databases/(default)/documents/users?pageSize=300&orderBy=requestedAt%20desc` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
    const response = await realFetch(deps)(url, { headers: { authorization: `Bearer ${idToken}` } })
    if (!response.ok) throw new Error(`request list failed: ${response.status}`)
    const body = (await response.json()) as { documents?: Array<{ name: string; fields?: FirestoreFields }>; nextPageToken?: string }
    for (const doc of body.documents ?? []) requests.push(fromDocument(doc))
    pageToken = body.nextPageToken ?? ''
  } while (pageToken)
  return requests
}

/**
 * An admin's decision on one request. `decidedAt` is the server's commit
 * time, which is what the rules require — a client clock cannot backdate it.
 * Returns false when the request does not exist.
 */
export async function decideRequest(
  input: { uid: string; status: AccessStatus; decidedBy: string },
  idToken: string,
  projectId: string,
  deps: AuthDeps = {},
): Promise<boolean> {
  const database = `projects/${projectId}/databases/(default)`
  const response = await realFetch(deps)(`${FIRESTORE_URL}/${database}/documents:commit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: `${database}/documents/users/${input.uid}`,
            fields: { status: { stringValue: input.status }, decidedBy: { stringValue: input.decidedBy } },
          },
          updateMask: { fieldPaths: ['status', 'decidedBy'] },
          updateTransforms: [{ fieldPath: 'decidedAt', setToServerValue: 'REQUEST_TIME' }],
          currentDocument: { exists: true },
        },
      ],
    }),
  })
  if (response.ok) return true
  // A failed precondition is a missing document; anything else is a real failure.
  if (response.status === 400 || response.status === 404) return false
  throw new Error(`decision failed: ${response.status}`)
}

// --- Request decisions -------------------------------------------------------

export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '')
  return match ? match[1]! : null
}

export interface AuthRequest {
  /** The `Authorization` header: `Bearer <Firebase ID token>`. */
  authorization: string | null | undefined
  /** The `Host` header, for the development bypass's loopback check. */
  host: string | null | undefined
  /** Whether this request may use the localhost-only development bypass. */
  developmentEnvironment: boolean
}

/** Stands in for a signed-in user only where the dev stub token would be allowed. */
export const DEV_USER = 'dev@localhost'

export type Authorization =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403 | 500; error: string }

function devBypass(request: AuthRequest, env: Record<string, string | undefined>): boolean {
  return (
    !env['FIREBASE_PROJECT_ID'] &&
    devStubTokenAllowed({ developmentEnvironment: request.developmentEnvironment, requestHost: request.host })
  )
}

/**
 * May this request mint? A valid Firebase ID token whose access record is
 * `approved`, or — with no Firebase project configured, on a development
 * flag AND a loopback host only — the development user.
 */
export async function authorize(
  request: AuthRequest,
  env: Record<string, string | undefined>,
  deps: AuthDeps = {},
): Promise<Authorization> {
  const firebase = readFirebaseConfig(env)
  if (!firebase.ok) {
    if (devBypass(request, env)) return { ok: true, email: DEV_USER }
    return { ok: false, status: 500, error: firebase.error }
  }
  const { projectId } = firebase.config
  const idToken = bearerToken(request.authorization)
  if (!idToken) return { ok: false, status: 401, error: 'sign in required' }

  let user: FirebaseUser
  try {
    user = await verifyFirebaseIdToken(idToken, { projectId, ...deps })
  } catch (error) {
    console.warn('[auth] ID token refused:', error instanceof Error ? error.message : error)
    return { ok: false, status: 401, error: 'sign in required' }
  }
  try {
    // Admins approve others, so they never wait on approval themselves.
    const allowed = (await readAccess(user, idToken, projectId, deps)) === 'approved' || (await isAdmin(idToken, projectId, deps))
    if (!allowed) return { ok: false, status: 403, error: 'not approved' }
  } catch (error) {
    console.error('[auth]', error)
    return { ok: false, status: 500, error: 'could not check access' }
  }
  return { ok: true, email: user.email ?? user.uid }
}

export interface SessionResult {
  status: number
  body: Record<string, unknown>
}

/**
 * `/api/session`. GET hands the page the Firebase web config it needs to
 * offer sign-in. POST, with the ID token, reports the caller's access —
 * filing a `pending` request on the first sign-in with a verified email, and
 * answering `unverified` until then.
 */
export async function handleSessionRequest(
  input: AuthRequest & { method: string | undefined; env: Record<string, string | undefined> },
  deps: AuthDeps = {},
): Promise<SessionResult> {
  const firebase = readFirebaseConfig(input.env)
  if (!firebase.ok) {
    if (devBypass(input, input.env)) return { status: 200, body: { firebase: null, email: DEV_USER, access: 'approved', dev: true } }
    return { status: 500, body: { error: firebase.error } }
  }
  const { config } = firebase

  if (input.method === 'GET') return { status: 200, body: { firebase: config } }
  if (input.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } }

  const idToken = bearerToken(input.authorization)
  if (!idToken) return { status: 401, body: { error: 'sign in required' } }
  let user: FirebaseUser
  try {
    user = await verifyFirebaseIdToken(idToken, { projectId: config.projectId, ...deps })
  } catch (error) {
    console.warn('[session] ID token refused:', error instanceof Error ? error.message : error)
    return { status: 401, body: { error: 'sign in could not be verified' } }
  }

  try {
    if (await isAdmin(idToken, config.projectId, deps)) {
      return { status: 200, body: { email: user.email, access: 'approved', admin: true } }
    }
    let access: AccessStatus | 'unverified' | null = await readAccess(user, idToken, config.projectId, deps)
    // An unverified address could be anyone's, and the admin decides by the
    // address shown: the rules refuse the request until the link is clicked.
    if (access === null && !user.emailVerified) access = 'unverified'
    if (access === null) {
      await requestAccess(user, idToken, config.projectId, deps)
      access = 'pending'
    }
    return { status: 200, body: { email: user.email, access, admin: false } }
  } catch (error) {
    console.error('[session]', error)
    return { status: 500, body: { error: 'could not check access' } }
  }
}

/**
 * `/api/requests`, for admins. GET lists every request; POST
 * `{ uid, status }` decides one. Whether the caller is an admin is the
 * rules' call: a non-admin's Firestore read or write comes back 403, and so
 * does this.
 */
export async function handleRequestsRequest(
  input: AuthRequest & { method: string | undefined; body: unknown; env: Record<string, string | undefined> },
  deps: AuthDeps = {},
): Promise<SessionResult> {
  const firebase = readFirebaseConfig(input.env)
  if (!firebase.ok) return { status: 500, body: { error: firebase.error } }
  const { projectId } = firebase.config
  if (input.method !== 'GET' && input.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } }

  const idToken = bearerToken(input.authorization)
  if (!idToken) return { status: 401, body: { error: 'sign in required' } }
  let user: FirebaseUser
  try {
    user = await verifyFirebaseIdToken(idToken, { projectId, ...deps })
  } catch (error) {
    console.warn('[requests] ID token refused:', error instanceof Error ? error.message : error)
    return { status: 401, body: { error: 'sign in required' } }
  }

  try {
    // Checked up front so a non-admin gets a clear 403 rather than whatever
    // the Firestore call's refusal happens to look like.
    if (!(await isAdmin(idToken, projectId, deps))) return { status: 403, body: { error: 'admins only' } }
    if (input.method === 'GET') return { status: 200, body: { requests: await listRequests(idToken, projectId, deps) } }

    let body = input.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        body = null
      }
    }
    const { uid, status } = (body ?? {}) as { uid?: unknown; status?: unknown }
    if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return { status: 400, body: { error: 'uid is required' } }
    if (status !== 'approved' && status !== 'denied' && status !== 'pending') {
      return { status: 400, body: { error: 'status must be approved, denied or pending' } }
    }
    if (!user.email) return { status: 403, body: { error: 'admins only' } }
    const found = await decideRequest({ uid, status, decidedBy: user.email }, idToken, projectId, deps)
    return found ? { status: 200, body: { uid, status } } : { status: 404, body: { error: 'no such request' } }
  } catch (error) {
    console.error('[requests]', error)
    return { status: 500, body: { error: 'could not reach the request list' } }
  }
}
