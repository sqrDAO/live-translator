# memory-host — reference host for `@sqrdao/live-translate`

The smallest real host: an **in-memory `CaptionSink`** and a page that captures,
translates, renders, and saves text transcripts in browser storage. No database,
auth, or cloud storage — the
proof that the engine's boundary is real, and the thing a new project starts
from.

## Run it

```bash
# from the repo root, once, so the package resolves:
npm install

cd examples/memory-host
npm install
cp ../../.env.example .env     # paste a GEMINI_API_KEY, or leave it blank for the localhost stub
npm run dev                    # token server :3001 + Vite :5173
```

Open <http://localhost:5173>, tap the mic, speak. Translations stream in as live
text.

**Direction.** `AUTO` runs both sessions and infers the speaker's language per
utterance — right for a two-way conversation, wrong for a talk, where one
mislabelled utterance puts a caption on the wrong side of the pair. `EN→VI` and
`VI→EN` declare it instead: the engine labels every utterance with it, and the
minted token pins the model to a single unconditional job rather than a
per-turn "translate, or repeat if already in the target". The direction is
pinned into the tokens, so switching re-mints and restarts the feed.

With no key configured the token endpoint returns a **localhost-only stub**
(gated on a development flag *and* a loopback host) so the UI runs without Gemini
credentials — the socket will not actually translate, but nothing leaks a key.

## Transcript history

Each microphone run automatically records the original text and translation,
with timestamps and the selected direction. Open **History** to choose a session,
read it chronologically, download a UTF-8 text file, or delete it. Switching
direction starts a separate recording. The current active session cannot be
deleted from this tab. Deleting a recording from another tab stops further saves
for that recording, without stopping live translation. Small deletion markers
prevent delayed writes from bringing deleted transcripts back.

Records use localStorage in this browser and origin, so they survive reloads but
are not synced across devices. Clearing browser data removes them. No audio is
recorded. Partial captions are updated in place and saved at most once per second;
completed utterances, retractions, stopping, and page-hide events flush immediately.
A browser crash may lose partial updates since the last save (normally at most
one second). An interrupted session retains its latest saved text, with unfinished
utterances labelled “partial”. A session without an end time may have been
interrupted or still be running in another tab.

If storage is blocked or full, the app displays an error and keeps translating.
Unsaved transcripts stay available in History across new runs and direction
changes. The app retries them when starting a run, opening History, or freeing
space by deleting another session. The error clears when saving recovers. Download
unsaved transcripts before leaving the page. Empty failed starts are not saved,
and no saved sessions are automatically evicted.

## What to read

- [`src/memory-sink.ts`](./src/memory-sink.ts) — the whole host contract, implemented in ~50 lines. `authorityValid()` / `adoptRenewal()` are where a real host consults a lease.
- [`server.ts`](./server.ts) — the token endpoint: key in, token out, never the key.
- [`src/main.ts`](./src/main.ts) — constructing the engine, the `mintToken` hook, rendering.

## Test it, with no key

```bash
npm test
```

The suite drives the engine through a stub socket and asserts against the
in-memory sink — no key, no network, no browser.
