# Phiên Dịch Live — EN ⇄ VI

Real-time speech translation between English and Vietnamese, powered by Google's
`gemini-3.5-live-translate-preview` streaming speech-to-speech model over the Gemini Live API.
Installable PWA; works in desktop Chrome/Edge and on mobile.

## Modes

- **Hội thoại (Conversation)** — two-way. Two Live sessions run in parallel (target `en` + target `vi`,
  both with `echoTargetLanguage: false`); whichever session hears non-target speech emits the
  translation, so two people can just talk.
- **Diễn thuyết (Speech)** — one-way with a swap button, for translating a talk or lecture.

Output is **text-only**: translations stream into the transcript feed live. The model's translated
audio is discarded (used only as an activity signal), so there is no playback and no echo risk.

## Setup

```bash
npm install
cp .env.example .env   # then paste your Gemini API key into .env
npm run dev            # token server :3001 + Vite :5173
```

Open http://localhost:5173, tap the mic, speak — translations appear as live text.

## Production

```bash
npm run build   # typecheck + vite build → dist/
npm start       # Express serves dist/ + /api/token on :3001
```

## Architecture

- Mic → AudioWorklet → resample to 16kHz PCM16 → 100ms base64 chunks → Live API WebSocket
- Live API → live input/output transcripts rendered as utterance bubbles (translated audio discarded)
- Browser auth uses single-use **ephemeral tokens** minted by `server.ts` so the API key never
  ships to the client. Important: the token's `liveConnectConstraints` must pin the FULL session
  config including `translationConfig` — pinning only the model silently disables translation.
