# Live-frame fixtures

Each `*.jsonl` file is one scenario: a sequence of records replayed through a
real engine behind stub sockets on a fake clock (`test/support/replay.ts`).

A record is one JSON object per line:

- `{ "atMs": <n>, "target": "<lang>", "frame": { … } }` — deliver a Live API
  frame to that target's open socket at `atMs` on the fake clock. `frame` is the
  raw shape `parseLiveMessage` reads: `serverContent.inputTranscription`,
  `serverContent.outputTranscription`, `serverContent.turnComplete`,
  `sessionResumptionUpdate`, `goAway`.
- `{ "atMs": <n>, "close": { "target": "<lang>", "code": <n> } }` — a
  server-initiated close of that target's socket.
- `{ "atMs": <n>, "reopen": { "target": "<lang>" } }` — open the socket a
  backed-off reconnect created for that target (the reconnect *landing*).

Lines starting with `#` are comments; blank lines are ignored.

## The DEC-09 rule: no fixture is recorded from a real session

Raw Live frames are spoken content. These fixtures are **authored** from the
protocol facts written into `engine.ts`, `session/live-session.ts`,
`transcript/merge.ts` and `transcript/coordinator.ts` — never captured from a
room. Authored fixtures are weaker evidence than recorded ones, and that gap is
accepted deliberately (ADR-001): the rehearsal, not the suite, is where the
model's real frames are confirmed. A recorder that wrote down what people said
in a room would be a different artifact under a different policy.

## The scenarios

| File | What it pins |
| --- | --- |
| `delta-accumulation.jsonl` | Incremental deltas accumulate into one sentence, not three. |
| `direction-flip.jsonl` | A flipped session is labelled by its transcript (`sourceLang: vi`), not by echo inference. |
| `idle-retirement.jsonl` | With no `turnComplete`, each idle gap publishes one utterance and opens the next. |
| `sentence-cap.jsonl` | A gapless run is capped at three sentences. |
| `resumption-goaway.jsonl` | `goAway` rotates the connection; the reopened setup frame carries the newest resumable handle. |
| `setup-frame-close.jsonl` | A socket that opens and closes on the setup frame stays bounded at the attempt ceiling. |
