# @sqrdao/live-translate

A host-agnostic **live speech translation engine**: browser audio in, merged
bilingual utterances out.

It opens two Google Gemini Live sessions over WebSocket (one per target
language, both fed the same audio), reconciles their incremental transcripts
into utterances, and hands each utterance to whatever the host wants to do with
it. It asserts **nothing** about storage, identity, or the surface the text
appears on.

This is a port of a working, event-proven implementation — two live conference
days in two cities and roughly twenty defect-driven revisions. Almost every
constant and every counter-intuitive branch exists because a real room broke
without it; the comments that explain them are the incident history and are
load-bearing.

> **Status — licensed MIT; the name is still provisional.**
> Licensed under the [MIT License](LICENSE), copyright sqrDAO and
> contributors. The scaffold uses the *proposed* name
> `@sqrdao/live-translate`, semver from `0.1.0`, and is **published nowhere**
> (git or workspace resolution only). Confirm the final name/scope before
> publishing anywhere. See “Open decisions” below.

## The boundary

| The engine owns | The host owns |
| --- | --- |
| Microphone capture, resampling, PCM16, chunking | Where published utterances go |
| Voice activity detection and the privacy gate | Who is allowed to publish |
| Gemini Live session config and prompt construction | Authentication and authorization |
| WebSocket transport, reconnect, session resumption | Persistence, retention, deletion policy |
| Transcript merge, turn coordination, source-language decision | Rendering |
| Write throttling and coalescing | Restart policy after a dead feed |
| Latency measurement | Programme/event context to prime the model with |

The engine decides **when** to write — throttling, coalescing and ordering stay
in the engine. The host decides **where** and **whether**.

## The three ports

A host implements exactly these three, and nothing else. Name them as such.

### 1. `CaptionSink` — where utterances go

```ts
interface CaptionSink {
  prepare(): Promise<void>                                   // purge leftovers, seed counters
  publish(u: PublishableUtterance, final: boolean): Promise<boolean> // false = write did not land
  retract(utteranceId: string): Promise<void>               // take a stale partial back down
  publishStatus(status: FeedStatus): Promise<void>          // idle|connecting|live|degraded|unavailable|closed
  authorityValid(): boolean                                  // may this host still publish?
  adoptRenewal(grant): 'renewed' | 'moved'                  // after a re-mint: same authority, or gone?
}
```

Lease identity, write sequences, expiry, document paths, rolling trim and
retention are all the host's — none of them appear in the engine.
`adoptRenewal` exists because tokens are single-use: every reconnect re-mints,
and a re-mint is the moment a host discovers the room moved on to someone else.
`'moved'` **terminates** the feed; it is never retried, and a restart policy
must not answer it either.

### 2. `LanguageDetector` — how text is classified

```ts
type LanguageDetector = (text: string) => LangTag | null   // null = abstain
```

An abstention must leave behavior exactly as if no detector had been consulted.
The bundled EN/VI implementation ships as a **separate entry point**,
`@sqrdao/live-translate/lang/en-vi`, not as core: another language pair needs a
different one.

### 3. `mintToken` — how a session is authorized

```ts
type MintToken = (target: LangTag) => Promise<TokenGrant>  // { token, sessionConfig }
```

The host's own endpoint. **The engine never sees an API key.** Every reconnect
calls this again, because Gemini ephemeral tokens are `uses: 1`.

A fourth, optional seam — `createSocket?: (url) => WebSocket` — defaults to the
real constructor; the test suite replaces it.

## Quickstart

```ts
import { LiveTranslateEngine } from '@sqrdao/live-translate'
import { enVi } from '@sqrdao/live-translate/lang/en-vi'

const engine = new LiveTranslateEngine({
  languages: enVi,
  sink: myCaptionSink,                     // you implement this
  mintToken: (target) =>                   // your endpoint; returns { token, sessionConfig }
    fetch('/api/token', { method: 'POST', body: JSON.stringify({ target }) }).then((r) => r.json()),
  onError: console.error,
})

// Inside the user's tap handler, BEFORE any await (iOS keeps the gesture):
engine.unlockAudioSync()
await engine.start()                        // captures the mic and opens both sessions
// …
await engine.stop()
```

On the server (Node only, `@sqrdao/live-translate/server`):

```ts
import { mintSessionToken } from '@sqrdao/live-translate/server'
import { enVi } from '@sqrdao/live-translate/lang/en-vi'

// Key in, token out — the key never leaves the server.
const grant = await mintSessionToken({
  apiKey: process.env.GEMINI_API_KEY!,
  model: process.env.GEMINI_LIVE_MODEL,     // verified per deployment (see ADR-001)
  languages: enVi,
  target,                                   // 'en' | 'vi'
  // context: { eventName, sessionTitle, speakers, glossary }   // optional, host-assembled
})
```

A full, runnable host — an in-memory sink and a page that captures, translates
and renders, with **no cloud service of any kind** — is in
[`examples/memory-host`](./examples/memory-host). Its own test suite runs with
no key; point a real `GEMINI_API_KEY` at its `server.ts` to see it translate.

## ADR-001 — measure, don't assume

**The Live API message shape and the model name are verified per deployment,
never assumed from the pinned version.** The protocol has already moved twice in
this code's short life: `v1alpha/authTokens` was removed, and the token
constraint field was renamed from `liveConnectConstraints` to a flat
`bidiGenerateContentSetup`. If a fact in this README disagrees with what the API
does when you probe it, **the API wins** — correct it here rather than leaving
the fix in a commit message. Do not tune the empirically-derived constants while
porting; if one looks wrong, change it in its own commit with its own evidence.

Verify at least, per deployment:

- the model resolves as `models/<id>` (a bare id is refused on the constrained socket);
- the WebSocket method is `BidiGenerateContentConstrained` (the plain method rejects ephemeral tokens with 1008);
- the token constraint field is `bidiGenerateContentSetup`, flat;
- whether the API now emits `turnComplete` (it did not when this was written — idle retirement is the only turn boundary in practice).

## What the host must answer for itself

These are one event's answers to questions every host faces, and are
**deliberately not in the package**: the publication lease and its rules, the
operator console, any display renderer, an auto-restart policy after a dead
feed, the event/speaker/glossary context assembled at mint time, and the
retention/deletion policy. Implement them around the three ports.

## Attribution

The audio layer descends from
[`sqrdao-intern/live-translator`](https://github.com/sqrdao-intern/live-translator)
at commit `7273d39cf6c228f2445bbb0fbe3e17401f74412f` (14 July 2026). Everything
above the audio layer was written for, and hardened during, the Techcombank
Future Forum 2026 engagement, then extracted here with the event's own
identifiers, storage and console left behind.

## Open decisions

Not this code's to settle:

1. **Name, scope and home.** Proposed `@sqrdao/live-translate`, semver from
   `0.1.0`; in-repo/workspace first, split to its own repository when a second
   project actually needs it. Confirm before publishing anywhere.

Settled: **ownership and licence** — MIT, copyright sqrDAO and contributors.
See [`LICENSE`](LICENSE).

## Development

```bash
npm install
npm run verify        # lint + typecheck + test + build
npm test              # the whole suite: no network, no credentials, no emulator
```
