/**
 * The page's side of sign-in. The server decides (`api/_auth.ts`); this signs
 * in with Firebase Auth, asks the server where the account stands, and hands
 * the token endpoint a fresh ID token on every mint.
 */

import { initializeApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from 'firebase/auth'

/** Where a request stands; `unverified` is an email/password account that has not clicked its link. */
export type Access = 'approved' | 'pending' | 'denied' | 'unverified'

export interface FirebaseWebConfig {
  apiKey: string
  authDomain: string
  projectId: string
  appId: string
}

/** What GET /api/session says: the config to sign in with, or the dev user. */
type SessionConfig =
  | { firebase: FirebaseWebConfig }
  | { firebase: null; email: string; access: 'approved'; dev: true }

export type AuthState =
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; email: string; access: Access; admin?: boolean; dev?: boolean }

let auth: Auth | null = null

/**
 * A current ID token for the mint, or null in the development bypass.
 * Firebase refreshes it as it nears its one-hour expiry, so a long feed's
 * reconnects keep working.
 */
export async function idToken(): Promise<string | null> {
  return auth?.currentUser ? auth.currentUser.getIdToken() : null
}

async function sessionFetch(init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch('/api/session', init)
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) throw new Error(`sign-in is unavailable: ${String(body['error'] ?? `HTTP ${response.status}`)}`)
  return body
}

/** Where the signed-in user stands; the first call files their access request. */
export async function checkAccess(user: User, forceRefresh = false): Promise<AuthState> {
  const body = await sessionFetch({
    method: 'POST',
    headers: { authorization: `Bearer ${await user.getIdToken(forceRefresh)}` },
  })
  return {
    kind: 'signed-in',
    email: String(body['email'] ?? user.email ?? ''),
    access: body['access'] as Access,
    admin: body['admin'] === true,
  }
}

/**
 * Starts Firebase and reports every change of sign-in state, including the
 * restored session on page load.
 */
export async function watchAuth(onChange: (state: AuthState) => void, onError: (error: unknown) => void): Promise<void> {
  const config = (await sessionFetch()) as unknown as SessionConfig
  if (!config.firebase) {
    onChange({ kind: 'signed-in', email: config.email, access: 'approved', dev: true })
    return
  }
  auth = getAuth(initializeApp(config.firebase))
  onAuthStateChanged(auth, (user) => {
    if (!user) onChange({ kind: 'signed-out' })
    else checkAccess(user).then(onChange, onError)
  })
}

function ready(): Auth {
  if (!auth) throw new Error('sign-in is not ready')
  return auth
}

export async function signIn(): Promise<void> {
  const auth = ready()
  // A popup, not a redirect: redirects break when the auth domain differs from
  // the page's, as it does on Vercel, under third-party storage partitioning.
  await signInWithPopup(auth, new GoogleAuthProvider())
}

export async function signOut(): Promise<void> {
  if (auth) await firebaseSignOut(auth)
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(ready(), email, password)
}

/** Creates the account and sends the verification link; the request waits for the click. */
export async function signUpWithEmail(email: string, password: string): Promise<void> {
  const { user } = await createUserWithEmailAndPassword(ready(), email, password)
  await sendEmailVerification(user)
}

export async function resendVerification(): Promise<void> {
  const user = ready().currentUser
  if (user) await sendEmailVerification(user)
}

export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(ready(), email)
}

/**
 * Re-asks the server, for "check again" while a request is pending or a
 * verification link is outstanding. The reload and the forced token refresh
 * matter for the latter: the ID token only says `email_verified` once it is
 * reissued after the click.
 */
export async function recheck(): Promise<AuthState> {
  const user = auth?.currentUser
  if (!user) return { kind: 'signed-out' }
  await user.reload()
  return checkAccess(user, true)
}

/** Firebase's error codes, as something a person can act on. */
export function authErrorMessage(error: unknown): string | null {
  const code = (error as { code?: string }).code
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null // a change of mind, not a failure
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email hoặc mật khẩu không đúng · Wrong email or password.'
    case 'auth/email-already-in-use':
      return 'Email này đã có tài khoản · That email already has an account — sign in instead, or reset the password.'
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'Mật khẩu quá yếu · Password too weak — use at least 8 characters.'
    case 'auth/invalid-email':
      return 'Email không hợp lệ · That is not a valid email address.'
    case 'auth/too-many-requests':
      return 'Thử lại sau · Too many attempts — wait a few minutes and try again.'
    case 'auth/account-exists-with-different-credential':
      return 'Email này đăng nhập bằng cách khác · That email signs in another way — try Google or your password.'
    default:
      return error instanceof Error ? error.message : String(error)
  }
}

// --- Admins ------------------------------------------------------------------

export interface AccessRequest {
  uid: string
  email: string | null
  name: string | null
  /** A filed request is never `unverified`: verification comes before filing. */
  status: Exclude<Access, 'unverified'>
  requestedAt: string | null
  decidedBy: string | null
  decidedAt: string | null
}

async function requestsFetch(init: RequestInit = {}): Promise<Record<string, unknown>> {
  const token = await idToken()
  if (!token) throw new Error('sign in required')
  const response = await fetch('/api/requests', {
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) throw new Error(String(body['error'] ?? `HTTP ${response.status}`))
  return body
}

/** Every request, newest first. The server refuses anyone the rules do not list as an admin. */
export async function listRequests(): Promise<AccessRequest[]> {
  return (await requestsFetch()).requests as AccessRequest[]
}

export async function decide(uid: string, status: AccessRequest['status']): Promise<void> {
  await requestsFetch({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid, status }),
  })
}
