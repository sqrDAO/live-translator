/**
 * Frame-replay harness.
 *
 * A fixture is a JSONL file of `{ atMs, target, frame }` records plus optional
 * directives (`{ atMs, close: {...} }`, `{ atMs, reopen: true }`). `atMs` drives
 * a fake clock, so replay is deterministic and never sleeps. The harness plays
 * the fixture through a real engine behind stub sockets and returns what the
 * sink recorded — assertions are on the published stream, never on engine
 * internals.
 *
 * NO fixture is recorded from a real session. Raw Live frames are spoken
 * content; fixtures are authored from the protocol facts written into the
 * engine, the session manager and the merge. The rehearsal, not the suite, is
 * where the model's real frames are confirmed (ADR-001).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

import { enVi } from '../../src/lang/en-vi'
import { LiveTranslateEngine, type EngineOptions } from '../../src/engine'
import { flush, RecordingSink, StubSocket } from './harness'
import type { LangTag } from '../../src/lang/types'

export interface ReplayRecord {
  atMs: number
  target?: LangTag
  frame?: Record<string, unknown>
  /** Close the given target's socket (a server-initiated drop). */
  close?: { target: LangTag; code?: number; reason?: string }
  /** Open the newest not-yet-open socket for the target (a reconnect landing). */
  reopen?: { target: LangTag }
}

export interface ReplayResult {
  sink: RecordingSink
  errors: Error[]
  /** The setup frame each socket sent, in creation order, parsed. */
  setups: Array<Record<string, unknown>>
  socketCount: number
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/live-frames/${name}`, import.meta.url))
}

export function loadFixture(name: string): ReplayRecord[] {
  return readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => JSON.parse(line) as ReplayRecord)
}

/** Runs a fixture and returns what the sink saw. Uses fake timers internally. */
export async function replay(
  name: string,
  overrides: Partial<EngineOptions> = {},
): Promise<ReplayResult> {
  const records = loadFixture(name)
  const sink = new RecordingSink()
  const errors: Error[] = []
  const mint = async (target: LangTag) => ({ token: `token-${target}`, sessionConfig: {} })

  StubSocket.reset()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-13T03:00:00.000Z'))
  const base = Date.now()

  const socketFor = (target: LangTag, requireClosedPredecessor = false): StubSocket | undefined => {
    const forTarget = StubSocket.instances.filter((s) => s.url.includes(`token-${target}`))
    if (requireClosedPredecessor) return forTarget.find((s) => !s.closed && s.readyState !== StubSocket.OPEN)
    return forTarget.find((s) => s.readyState === StubSocket.OPEN)
  }

  try {
    const engine = new LiveTranslateEngine({
      languages: enVi,
      sink,
      mintToken: mint,
      createSocket: (url) => new StubSocket(url) as unknown as WebSocket,
      onError: (error) => errors.push(error),
      ...overrides,
    })

    const starting = engine.start({ microphone: false })
    await flush()
    for (const socket of StubSocket.instances) socket.open()
    await starting

    for (const record of records) {
      const target = Date.now() - base
      if (record.atMs > target) await vi.advanceTimersByTimeAsync(record.atMs - target)
      await flush()

      if (record.frame && record.target) {
        socketFor(record.target)?.receive(record.frame)
      } else if (record.close) {
        socketFor(record.close.target)?.close(record.close)
      } else if (record.reopen) {
        // A backed-off reconnect creates a fresh socket; open the newest one.
        socketFor(record.reopen.target, true)?.open()
      }
      await flush()
    }
    // Let any trailing idle-retirement poll and queued state write settle.
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    const setups = StubSocket.instances
      .map((s) => s.sent[0])
      .filter((f): f is string => Boolean(f))
      .map((f) => (JSON.parse(f) as { setup: Record<string, unknown> }).setup)

    await engine.stop()
    return { sink, errors, setups, socketCount: StubSocket.instances.length }
  } finally {
    vi.useRealTimers()
    StubSocket.reset()
  }
}
