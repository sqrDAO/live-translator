/**
 * The host contract.
 *
 * Three ports, and nothing else, are what a host implements:
 *
 *   * `CaptionSink`       — where utterances go, and whether this host may
 *                            still publish them
 *   * `LanguageDetector`  — how text is classified (see `lang/types.ts`)
 *   * `MintToken`         — how a session is authorized
 *
 * plus one optional seam, `createSocket`, which the test suite depends on.
 *
 * The engine asserts nothing about storage, identity, retention or the surface
 * the text appears on. It decides *when* to write — throttling, coalescing and
 * ordering stay in the engine — and the sink decides *where* and *whether*.
 */

import type { LangTag } from './lang/types'

/** Feed lifecycle as the engine reports it, in the order a feed passes through it. */
export type FeedStatus = 'idle' | 'connecting' | 'live' | 'degraded' | 'unavailable' | 'closed'

/**
 * What one call to `mintToken` returns: a single-use Gemini ephemeral token
 * and the session config that token pins. Hosts extend it with whatever
 * their own authority carries (a lease id, a projection id…); the engine
 * hands the very object back to `adoptRenewal` untouched.
 */
export interface TokenGrant {
  token: string
  /** The exact `bidiGenerateContentSetup` the token was minted against. */
  sessionConfig: Record<string, unknown>
}

/**
 * Mints one token for one target language.
 *
 * The host's own endpoint. The engine never sees an API key. Every reconnect
 * calls this again, because Gemini ephemeral tokens are `uses: 1` and the
 * token a dead socket was opened with cannot be presented twice.
 */
export type MintToken<G extends TokenGrant = TokenGrant> = (target: LangTag) => Promise<G>

export interface PublishableUtterance {
  utteranceId: string
  sourceLang: LangTag
  original: string
  translated: string
  /** Epoch ms of the utterance's first fragment. */
  startedAt: number
  /** Epoch ms of the newest fragment in this merge. */
  updatedAt: number
}

export interface CaptionSink<G extends TokenGrant = TokenGrant> {
  /** Called once before the first session opens. Purge leftovers, seed counters. */
  prepare(): Promise<void>
  /**
   * A partial or final utterance. Return `false` if the write did not land
   * (refused by the store, lost authority): the engine reports the feed
   * degraded rather than retrying. Throwing reports it degraded *and* surfaces
   * the error.
   */
  publish(utterance: PublishableUtterance, final: boolean): Promise<boolean>
  /**
   * Take a published partial back down; it will never be corrected by a
   * final. Also called for a partial whose retraction landed while its write
   * was in flight — the sink is the one that can unwind a write it has
   * already made.
   */
  retract(utteranceId: string): Promise<void>
  /**
   * Feed lifecycle. Written on every change, on a 4 s heartbeat while live,
   * and immediately — bypassing the state interval — when the feed dies or
   * stops. A surface that reads this is expected to mark the feed stale when
   * the heartbeat stops.
   */
  publishStatus(status: FeedStatus): Promise<void>
  /**
   * May this host still publish? A lapsed lease, token or permission answers
   * `false`, and reconnection ends with `onDead('authority-lapsed')`.
   */
  authorityValid(): boolean
  /**
   * After a token re-mint: is this still the same publication authority?
   *
   * Tokens are single-use, so every reconnect re-mints, and a re-mint is the
   * moment a host discovers that the room moved on to someone else.
   * `'moved'` terminates the feed — it is never retried, and the host's
   * restart policy must not answer it either.
   */
  adoptRenewal(renewal: G): 'renewed' | 'moved'
}

/**
 * Thrown by a host's `mintToken` when the authority is known to be gone —
 * another publisher legitimately holds the room. Known-terminal: the engine
 * ends the feed at once instead of retrying to the ceiling with an error per
 * attempt. A plain error with `code: 'PUBLICATION_MOVED'` is honoured the
 * same way, for hosts whose errors cross a serialization boundary.
 */
export class PublicationMovedError extends Error {
  readonly code = 'PUBLICATION_MOVED'
  constructor(message = 'the publication authority has moved to another publisher') {
    super(message)
    this.name = 'PublicationMovedError'
  }
}

export function isPublicationMoved(cause: unknown): boolean {
  if (cause instanceof PublicationMovedError) return true
  return (cause as { code?: unknown } | null)?.code === 'PUBLICATION_MOVED'
}

/**
 * Why the engine will not try again on its own (caption-feed-survives-network-
 * outage): both targets spent their reconnect budget ('exhausted'), the host's
 * authority lapsed mid-outage ('authority-lapsed'), or the room moved on — a
 * force-release, a changed projection, another publisher's lease ('moved').
 *
 * The host decides whether recovery is a human's or an automatic restart's
 * job, and 'moved' must never restart: the room is legitimately someone
 * else's.
 */
export type FeedDeathReason = 'exhausted' | 'authority-lapsed' | 'moved'
