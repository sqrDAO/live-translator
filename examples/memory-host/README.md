# memory-host — reference host for `@sqrdao/live-translate`

The smallest real host: an **in-memory `CaptionSink`** and a page that captures,
translates and renders. No database, no auth, no cloud service of any kind — the
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
text. With no key configured the token endpoint returns a **localhost-only stub**
(gated on a development flag *and* a loopback host) so the UI runs without Gemini
credentials — the socket will not actually translate, but nothing leaks a key.

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
