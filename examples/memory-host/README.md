# memory-host — reference host for `@sqrdao/live-translate`

The smallest real host: an **in-memory `CaptionSink`** and a page that captures,
translates, renders, and saves text transcripts in browser storage, behind a
Firebase sign-in limited to approved accounts. No database or cloud storage — the
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

## Sign-in

Only approved people can use a deployment. Access is self-serve:

1. Someone opens the page and signs in with Google, or creates an account
   with an email and a password (8 characters or more; Firebase Auth).
   Email/password accounts must first open the verification link Firebase
   emails them: anyone can sign up claiming any address, and the admin
   approves by the address shown. **Forgot password?** sends a reset link.
   **Email me a sign-in link** is the passwordless option: opening the link
   signs the person in with the address already verified. Opened in another
   browser than the one that asked, it asks for the email again — Firebase
   will not complete a link without it, so a forwarded link alone does not
   sign anyone in.
2. Their first sign-in with a verified email files `users/{uid}` in Firestore
   with `status: "pending"`, their email and name. The page says it is
   waiting for approval.
3. An admin opens **Requests** (in the footer, beside Sign out — admins only;
   the label carries the pending count) and presses **Approve** or **Deny**.
   The person presses **Check again**, or reloads, and is in. Each decision
   records who made it and when; a decided request can be reversed from the
   same list.

**Admins** are the emails in the Firestore document `config/admins`
(`emails`, an array of lowercased addresses), currently
`longpham91@gmail.com` and `leo@sqrdao.com`. Add or remove one by editing that
document in the Firebase console — no deploy. Admins can always use the app,
with no request of their own to approve.

The token endpoint verifies the Firebase ID token and re-reads the record on
every mint, so approving or withdrawing access takes effect at the person's
next mint — no redeploy. Any status other than exactly `approved` withholds
access. A denied person cannot file again; deleting their record in the
console is the only way to let them.

The server reads Firestore *as the caller*, with their own ID token, so
[`firestore.rules`](../../firestore.rules) is what prevents self-approval: a
person may create their own record as `pending` and read it, never change it;
only an email on the admin list (with a verified address) may list or decide
requests, and the rules hold its `decidedBy` to the admin's own email and
`decidedAt` to the server's clock.
Deploy rule changes with `firebase deploy --only firestore:rules`. The server
holds no service-account key.

Settings, all required on a deployment (see `.env.example`):
`FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`,
`FIREBASE_APP_ID` — the web app's public config. In the Firebase console,
Google and Email/Password (with *Email link (passwordless sign-in)*) must be
enabled under Authentication → Sign-in method (the project also enforces an 8-character password minimum), and every
domain the page is served from listed under Authentication → Settings →
Authorized domains (`localhost` is there by default).

Locally, leave `FIREBASE_PROJECT_ID` unset with `APP_ENV=development` and you
are signed in as `dev@localhost` (loopback hosts only, the same gate as the
stub token). Set the four values to test the real flow.

The logic lives in [`api/_auth.ts`](../../api/_auth.ts), shared by the Vercel
functions and `server.ts`.

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
- [`server.ts`](./server.ts) — the token endpoint: key in, token out, never the key, and only for a signed-in, approved caller.
- [`src/main.ts`](./src/main.ts) — constructing the engine, the `mintToken` hook, rendering.

## Test it, with no key

```bash
npm test
```

The suite drives the engine through a stub socket and asserts against the
in-memory sink — no key, no network, no browser.
