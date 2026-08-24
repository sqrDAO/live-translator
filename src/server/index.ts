/**
 * `@sqrdao/live-translate/server` — Node only. Never reaches browser code.
 *
 * Takes an API key and returns an ephemeral token; it never returns the key.
 */

export {
  AUTH_TOKENS_ENDPOINT,
  TOKEN_MINUTES,
  createDevStubToken,
  devStubTokenAllowed,
  isLoopbackHost,
  isoMinutesFromNow,
  mintEphemeralToken,
  mintSessionToken,
  type FetchLike,
  type MintEphemeralTokenInput,
  type MintSessionTokenInput,
  type MintedToken,
  type SessionTokenGrant,
} from './token.js'

export {
  TURN_SILENCE_MS,
  assertModelConfigured,
  buildLiveSessionConfig,
  buildTokenConstraints,
  type LiveSessionConfigInput,
  type LiveSessionContext,
} from '../gemini/config.js'

export {
  assertLanguagePair,
  otherOf,
  type LangTag,
  type LanguageDetector,
  type LanguageNames,
  type LanguagePack,
  type LanguagePair,
} from '../lang/types.js'

export type { TokenGrant } from '../sink.js'
