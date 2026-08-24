import { afterEach, describe, expect, it, vi } from 'vitest'

import { enVi } from '../src/lang/en-vi'
import { LiveSessionManager, type LiveSessionManagerOptions } from '../src/session/live-session'
import { StubSocket } from './support/harness'
import type { TokenGrant } from '../src/sink'

afterEach(() => {
  StubSocket.reset()
  vi.useRealTimers()
})

interface Wired {
  manager: LiveSessionManager
  sockets: StubSocket[]
  reconnected: string[]
  dead: string[]
  closes: Array<{ target: string; code?: number; reason?: string }>
  failures: string[]
  mint: ReturnType<typeof vi.fn>
}

function wire(
  mintImpl: (target: string) => Promise<TokenGrant>,
  overrides: Partial<LiveSessionManagerOptions> = {},
): Wired {
  const sockets: StubSocket[] = []
  const reconnected: string[] = []
  const dead: string[] = []
  const closes: Array<{ target: string; code?: number; reason?: string }> = []
  const failures: string[] = []
  const mint = vi.fn(mintImpl)
  const manager = new LiveSessionManager({
    pair: enVi.pair,
    mintToken: mint,
    createSocket: (url) => {
      const socket = new StubSocket(url)
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    authorityValid: () => true,
    adoptRenewal: () => 'renewed',
    onMessage: () => {},
    onReconnected: (target) => reconnected.push(target),
    onSocketError: () => {},
    onSocketClose: (info) => closes.push(info),
    onDead: (reason) => dead.push(reason),
    onFailure: (error) => failures.push(error.message),
    ...overrides,
  })
  return { manager, sockets, reconnected, dead, closes, failures, mint }
}

const grant = (token: string, sessionConfig: Record<string, unknown> = {}): TokenGrant => ({ token, sessionConfig })

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

async function startOpen(w: Wired): Promise<void> {
  // Start with grants for both targets so `mintToken` is exercised only by the
  // reconnect path — a host that already minted to take its authority passes
  // the grants it holds, exactly as the console does.
  const grants = Object.fromEntries(enVi.pair.map((t) => [t, grant(`start-${t}`)]))
  const starting = w.manager.start(grants)
  await flush()
  for (const socket of w.sockets) socket.open()
  await starting
}

describe('the constrained endpoint and the setup frame', () => {
  it('opens BidiGenerateContentConstrained with the token in access_token', async () => {
    const w = wire(async (t) => grant(`token-${t}`))
    await startOpen(w)
    for (const socket of w.sockets) {
      expect(socket.url).toContain('.GenerativeService.BidiGenerateContentConstrained?access_token=')
      expect(socket.url).not.toContain('BidiGenerateContent?')
    }
    // First connect: the setup is exactly the pinned config, no handle.
    expect(w.sockets[0]!.sent[0]).toBe(JSON.stringify({ setup: {} }))
  })
})

describe('reconnect budget', () => {
  it('reopens a closed direction with a freshly minted token', async () => {
    vi.useFakeTimers()
    const w = wire(async (t) => grant(`fresh-${t}`))
    await startOpen(w)
    w.mint.mockClear()

    w.sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.mint).toHaveBeenCalledExactlyOnceWith(enVi.pair[0])
    const reopened = w.sockets.at(-1)!
    expect(reopened.url).toContain('fresh-')
    reopened.open()
    await flush()
    expect(w.reconnected).toHaveLength(1)
  })

  it('backs off and gives up after five attempts, firing onDead once', async () => {
    vi.useFakeTimers()
    const w = wire(async () => {
      throw new Error('endpoint down')
    })
    await startOpen(w)
    for (const socket of w.sockets) socket.close()
    await vi.advanceTimersByTimeAsync(120_000)
    const [a, b] = enVi.pair
    expect(w.mint.mock.calls.filter(([t]) => t === a)).toHaveLength(5)
    expect(w.mint.mock.calls.filter(([t]) => t === b)).toHaveLength(5)
    expect(w.dead).toEqual(['exhausted'])
  })

  it('keeps a surviving direction while the other fails to return', async () => {
    vi.useFakeTimers()
    const w = wire(async () => {
      throw new Error('down')
    })
    await startOpen(w)
    w.sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(w.dead).toEqual([]) // one dead direction is degraded, not dead
    expect(w.manager.openCount).toBe(1)
  })

  it('stays bounded when the endpoint accepts the handshake and closes on the setup frame', async () => {
    // The PROTOCOL CAVEAT case: onopen then onclose, no message. Resetting the
    // attempt counter at onopen would turn the 5-attempt bound into a loop.
    vi.useFakeTimers()
    const w = wire(async (t) => grant(`f-${t}`))
    await startOpen(w)
    w.sockets[0]!.close()
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      const latest = w.sockets.at(-1)!
      if (!latest.closed && latest !== w.sockets[1]) {
        latest.open()
        latest.close()
      }
    }
    const [a] = enVi.pair
    expect(w.mint.mock.calls.filter(([t]) => t === a).length).toBeLessThanOrEqual(5)
  })

  it('resets the attempt budget on the first server MESSAGE, not on open', async () => {
    vi.useFakeTimers()
    const w = wire(async (t) => grant(`f-${t}`))
    await startOpen(w)
    w.sockets[0]!.close()
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      const latest = w.sockets.at(-1)!
      if (!latest.closed && latest !== w.sockets[1]) {
        latest.open()
        latest.receive({ sessionResumptionUpdate: { newHandle: `H${cycle}`, resumable: true } })
        await flush()
        latest.close()
      }
    }
    // Lifecycle frames must not count as recovery, or the loop is unbounded.
    const [a] = enVi.pair
    expect(w.mint.mock.calls.filter(([t]) => t === a).length).toBeLessThanOrEqual(5)
  })
})

describe('resumption and goAway', () => {
  it('presents the newest resumable handle when it reopens a dropped direction', async () => {
    vi.useFakeTimers()
    const w = wire(async (t) => grant(`fresh-${t}`))
    await startOpen(w)
    w.sockets[0]!.receive({ sessionResumptionUpdate: { newHandle: 'H1', resumable: true } })
    w.sockets[0]!.receive({ sessionResumptionUpdate: { newHandle: 'H2', resumable: false } })
    await flush()

    w.sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(1_000)
    const reopened = w.sockets.at(-1)!
    reopened.open()
    expect(JSON.parse(reopened.sent[0]!)).toEqual({ setup: { sessionResumption: { handle: 'H1' } } })
  })

  it('rotates the connection on goAway instead of waiting for the close', async () => {
    vi.useFakeTimers()
    const w = wire(async (t) => grant(`fresh-${t}`))
    await startOpen(w)
    w.sockets[0]!.receive({ sessionResumptionUpdate: { newHandle: 'H1', resumable: true } })
    w.sockets[0]!.receive({ goAway: { timeLeft: '10s' } })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.mint).toHaveBeenCalledExactlyOnceWith(enVi.pair[0])
    const reopened = w.sockets.at(-1)!
    reopened.open()
    expect(JSON.parse(reopened.sent[0]!)).toEqual({ setup: { sessionResumption: { handle: 'H1' } } })
    // The predecessor is detached by the replacement, not left half-open.
    expect(w.sockets[0]!.closed).toBe(true)
  })

  it('rotates immediately, without the failure ladder\'s backoff', async () => {
    vi.useFakeTimers()
    const w = wire(async (t) => grant(`fresh-${t}`))
    await startOpen(w)
    const before = w.sockets.length
    w.sockets[0]!.receive({ goAway: { timeLeft: '10s' } })
    await flush()
    // No timer advance: "on our own clock" means now, not one backoff step.
    expect(w.sockets.length).toBe(before + 1)
  })

  it('stops counting the rotating socket as open once it actually closes', async () => {
    // Silencing the announced close hid it from the derivation entirely:
    // `openCount` reported both directions up for the whole mint round trip,
    // so the engine published `live` for a feed with one dead session.
    vi.useFakeTimers()
    const w = wire(
      async (t) =>
        new Promise((resolve) => setTimeout(() => resolve(grant(`fresh-${t}`)), 5_000)),
    )
    await startOpen(w)
    expect(w.manager.openCount).toBe(2)

    const rotating = w.sockets[0]!
    rotating.receive({ goAway: { timeLeft: '10s' } })
    await flush()
    // Still open: the server has announced the close, not performed it.
    expect(w.manager.openCount).toBe(2)

    rotating.close({ code: 1001 })
    expect(w.manager.openCount).toBe(1)
    expect(w.closes.at(-1)).toMatchObject({ target: enVi.pair[0], code: 1001 })

    // ...and the rotation still completes without spending the budget.
    await vi.advanceTimersByTimeAsync(5_000)
    w.sockets.at(-1)!.open()
    await flush()
    expect(w.manager.openCount).toBe(2)
    expect(w.dead).toEqual([])
  })

  it('does not spend the reconnect budget on routine rotations', async () => {
    // caption-session-survives-90-minutes. `goAway` is routine — roughly every
    // ten minutes per connection — so nine of them is a ~90-minute session.
    // Routed through `scheduleReconnect` each one incremented `attempts`,
    // which resets only on a delivered transcript *message*; a feed carrying
    // none (a break, or the model correctly emitting nothing against the
    // silence stream) therefore walked the ladder to the ceiling and fired
    // onDead('exhausted') on the sixth rotation with both sockets healthy.
    vi.useFakeTimers()
    const w = wire(async (t) => grant(`fresh-${t}`))
    await startOpen(w)
    const latestFor = (target: string): StubSocket =>
      w.sockets.filter((socket) => socket.url.endsWith(`-${target}`)).at(-1)!

    for (let cycle = 0; cycle < 9; cycle += 1) {
      for (const target of enVi.pair) {
        const rotating = latestFor(target)
        rotating.receive({ goAway: { timeLeft: '10s' } })
        await flush()
        // The server follows through on the announced close; the replacement
        // is already up, so this must not read as a failure.
        rotating.close({ code: 1001 })
        const replacement = latestFor(target)
        expect(replacement).not.toBe(rotating)
        replacement.open()
        await flush()
      }
      // Deliberately no transcript frame all session: that is the case the
      // attempts counter cannot see.
      await vi.advanceTimersByTimeAsync(600_000)
    }

    expect(w.dead).toEqual([])
    expect(w.manager.openCount).toBe(2)
    for (const target of enVi.pair) {
      expect(w.mint.mock.calls.filter(([t]) => t === target)).toHaveLength(9)
    }
  })

  it('lets a real failure still exhaust the budget after rotations', async () => {
    // The rotation path must not become an escape hatch from the bound: a
    // genuinely dead endpoint still gives up after five attempts.
    vi.useFakeTimers()
    let down = false
    const w = wire(async (t) => {
      if (down) throw new Error('endpoint down')
      return grant(`fresh-${t}`)
    })
    await startOpen(w)
    for (const target of enVi.pair) {
      const socket = w.sockets.filter((s) => s.url.endsWith(`-${target}`)).at(-1)!
      socket.receive({ goAway: { timeLeft: '10s' } })
      await flush()
      w.sockets.filter((s) => s.url.endsWith(`-${target}`)).at(-1)!.open()
      await flush()
    }
    down = true
    for (const socket of w.sockets) if (!socket.closed) socket.close()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(w.dead).toEqual(['exhausted'])
  })
})

describe('why the feed died is reported, not inferred', () => {
  it('surfaces each server-initiated close with its wire code and reason', async () => {
    const w = wire(async (t) => grant(`t-${t}`))
    await startOpen(w)
    w.sockets[0]!.close({ code: 1006, reason: '' })
    w.sockets[1]!.close({ code: 1011, reason: 'internal error' })
    expect(w.closes).toEqual([
      { target: enVi.pair[0], code: 1006 },
      { target: enVi.pair[1], code: 1011, reason: 'internal error' },
    ])
  })

  it('reports nothing for a deliberate stop', async () => {
    const w = wire(async (t) => grant(`t-${t}`))
    await startOpen(w)
    w.manager.stop()
    expect(w.closes).toEqual([])
    expect(w.dead).toEqual([])
  })

  it('terminates with onDead("moved") when the authority lapses on renewal', async () => {
    vi.useFakeTimers()
    const w = wire(async (t) => grant(`fresh-${t}`), { adoptRenewal: () => 'moved' })
    await startOpen(w)
    w.sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.dead).toEqual(['moved'])
    expect(w.sockets[1]!.closed).toBe(true) // the surviving direction is torn down too
    await vi.advanceTimersByTimeAsync(120_000)
    expect(w.mint).toHaveBeenCalledTimes(1)
  })

  it('terminates at once with onDead("moved") on a PublicationMoved error', async () => {
    vi.useFakeTimers()
    const w = wire(async () => {
      throw Object.assign(new Error('held'), { code: 'PUBLICATION_MOVED' })
    })
    await startOpen(w)
    w.sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(w.mint).toHaveBeenCalledTimes(1)
    expect(w.dead).toEqual(['moved'])
    expect(w.failures).toEqual([]) // a takeover is not our error to banner
  })

  it('ends with onDead("authority-lapsed") when authorityValid() is false', async () => {
    const w = wire(async (t) => grant(`t-${t}`), { authorityValid: () => false })
    await startOpen(w)
    for (const socket of w.sockets) socket.close()
    expect(w.dead).toEqual(['authority-lapsed'])
    expect(w.mint).not.toHaveBeenCalled()
  })

  it('stop() cancels a pending reconnect', async () => {
    vi.useFakeTimers()
    const w = wire(async (t) => grant(`t-${t}`))
    await startOpen(w)
    w.sockets[0]!.close()
    w.manager.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(w.mint).not.toHaveBeenCalled()
  })
})
