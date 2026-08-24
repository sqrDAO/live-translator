import './style.css'

import {
  DEFAULT_DEVICE_STORAGE_KEY,
  LiveTranslateEngine,
  type CaptureDiagnostics,
  type MintToken,
  type TokenGrant,
} from '@sqrdao/live-translate'
import { enVi } from '@sqrdao/live-translate/lang/en-vi'

import { MemorySink, type StoredUtterance } from './memory-sink'

/**
 * The host's authorization hook. The engine calls it once per target at
 * start and again on every reconnect (tokens are single-use). It hits the
 * host's own endpoint; the API key never reaches this code.
 */
const mintToken: MintToken = async (target): Promise<TokenGrant> => {
  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`token endpoint HTTP ${response.status} ${detail}`.trim())
  }
  const { token, sessionConfig } = (await response.json()) as TokenGrant
  if (!token) throw new Error('token endpoint returned no token')
  return { token, sessionConfig: sessionConfig ?? {} }
}

// --- DOM ---------------------------------------------------------------------
const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`missing element: ${sel}`)
  return el
}
const feed = $('#feed')
const empty = $('#empty')
const statusEl = $('#status')
const statusText = $('#status-text')
const micBtn = $<HTMLButtonElement>('#mic')
const deviceSel = $<HTMLSelectElement>('#device')
const diagEl = $('#diag')

const STATUS_LABEL: Record<string, string> = {
  idle: 'sẵn sàng',
  connecting: 'đang kết nối…',
  live: 'đang dịch',
  degraded: 'một chiều bị gián đoạn',
  unavailable: 'mất kết nối',
  closed: 'đã dừng',
}

function renderStatus(status: string): void {
  statusEl.dataset.state = status === 'live' ? 'open' : status === 'closed' ? 'idle' : status
  statusText.textContent = STATUS_LABEL[status] ?? status
}

function renderUtterance(u: StoredUtterance): void {
  empty.classList.add('hidden')
  let el = document.getElementById(`utt-${u.utteranceId}`)
  if (!el) {
    el = document.createElement('article')
    el.id = `utt-${u.utteranceId}`
    el.className = 'utt'
    el.innerHTML = '<div class="tag"></div><p class="original"></p><p class="translated"></p>'
    feed.prepend(el)
  }
  el.dataset.lang = u.sourceLang
  el.classList.toggle('final', u.final)
  el.querySelector('.tag')!.textContent = u.sourceLang === 'en' ? 'EN → TIẾNG VIỆT' : 'VI → ENGLISH'
  el.querySelector('.original')!.textContent = u.original
  el.querySelector('.translated')!.textContent = u.translated
  feed.scrollTo({ top: 0, behavior: 'smooth' })
}

function removeUtterance(utteranceId: string): void {
  document.getElementById(`utt-${utteranceId}`)?.remove()
}

/**
 * The operator's answer to "which mic, and is audio reaching the model".
 *
 * `peakRms` near zero with chunks climbing is a silent or wrong input device;
 * a healthy `peakRms` with `gatedWhileAudible` climbing is the noise gate
 * eating real speech. The two look identical from the feed — both sit at
 * "đang dịch" and publish nothing — and cost hours apart without this line.
 */
let lastCapture: CaptureDiagnostics | null = null
let lastPaintedAt = 0

/**
 * What the sockets are doing, counted by wrapping `createSocket`.
 *
 * Audio leaving the microphone proves nothing on its own: a session that
 * opens and is closed by the server on its setup frame reconnects behind the
 * status line, so the feed reads "đang dịch" while every chunk is dropped
 * into a socket that is not there. `frames` separates that from a session
 * that is connected and simply has nothing to say.
 */
const wire = { sockets: 0, frames: 0, closes: 0, lastClose: '' }

function createSocket(url: string): WebSocket {
  const socket = new WebSocket(url)
  wire.sockets += 1
  socket.addEventListener('message', () => {
    wire.frames += 1
    paint()
  })
  socket.addEventListener('close', (event) => {
    wire.closes += 1
    wire.lastClose = `${event.code}${event.reason ? ` ${event.reason}` : ''}`
    paint(true)
  })
  return socket
}

function renderDiagnostics(d: CaptureDiagnostics): void {
  lastCapture = d
  paint(true)
}

/** Throttled: frames arrive ~10/s per session and each one would repaint. */
function paint(force = false): void {
  const now = Date.now()
  if (!force && now - lastPaintedAt < 250) return
  lastPaintedAt = now
  diagEl.hidden = false
  const rms = (value: number) => value.toFixed(3)
  const d = lastCapture
  diagEl.textContent = [
    ...(d
      ? [
          d.microphoneLabel,
          `${(d.contextSampleRate / 1000).toFixed(0)}kHz`,
          `${d.chunksSent} chunks`,
          `rms ${rms(d.lastChunkRms)} (peak ${rms(d.peakRms)})`,
          `gate ${rms(d.threshold)} over floor ${rms(d.noiseFloor)}`,
          `${d.droppedSilentChunks} silent`,
          ...(d.gatedWhileAudible > 0 ? [`⚠ ${d.gatedWhileAudible} gated while audible`] : []),
        ]
      : []),
    `${wire.sockets} sockets`,
    `${wire.frames} frames in`,
    ...(wire.closes > 0 ? [`⚠ ${wire.closes} closes (last ${wire.lastClose})`] : []),
  ].join(' · ')
}

/** What the engine will actually open when the picker is left on default. */
function rememberedDevice(): string {
  try {
    return window.localStorage.getItem(DEFAULT_DEVICE_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Device labels are blank until the microphone permission is granted, so this
 * runs again after the first successful start.
 *
 * The remembered device is preselected rather than left implicit. The picker
 * used to read "default microphone" whenever the operator had not touched it
 * *this page load*, while the engine went on opening a device remembered from
 * some earlier session — so the one control that says which microphone is in
 * use disagreed with the microphone in use, in the exact situation where an
 * operator is staring at it wondering why no captions arrive.
 */
async function refreshDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const mics = devices.filter((d) => d.kind === 'audioinput')
  if (mics.length === 0) return
  // A remembered id that no longer matches any device leaves the select on
  // '', which is the truth: the engine's own fallback will take the default.
  const chosen = deviceSel.value || rememberedDevice()
  deviceSel.replaceChildren(new Option('default microphone', ''))
  for (const mic of mics) {
    deviceSel.add(new Option(mic.label || `microphone ${mic.deviceId.slice(0, 6)}`, mic.deviceId))
  }
  if (chosen) deviceSel.value = chosen
}

void refreshDevices()

// --- engine ------------------------------------------------------------------
const sink = new MemorySink({
  onUtterance: renderUtterance,
  onRetract: removeUtterance,
  onStatus: renderStatus,
})

let engine: LiveTranslateEngine | null = null
let running = false

async function stop(): Promise<void> {
  running = false
  micBtn.classList.remove('on')
  // Captured, because the await below spans an AudioContext close and an
  // outbox flush, and `running` is already false: a tap inside that window
  // starts a new engine, and nulling the field unconditionally afterwards
  // dropped that engine's only reference — it kept the microphone and both
  // sockets open with nothing left able to stop it.
  const stopping = engine
  await stopping?.stop()
  if (engine === stopping) engine = null
}

function start(): void {
  // Each run builds a fresh engine, so utterance ids restart at `u0` and
  // `renderUtterance` would find the previous run's elements by id and
  // overwrite them where they sit — new captions scattered among stale ones at
  // old scroll positions instead of prepended. `MemorySink.prepare()` clears
  // the sink; the DOM is the host's to clear. Keep `empty`: it is a child of
  // the feed, not a sibling.
  feed.replaceChildren(empty)
  empty.classList.remove('hidden')

  // Auto direction: two sessions, the engine decides the source per utterance.
  wire.sockets = 0
  wire.frames = 0
  wire.closes = 0
  wire.lastClose = ''
  engine = new LiveTranslateEngine({
    languages: enVi,
    sink,
    mintToken,
    createSocket,
    onSocketClose: (info) => console.warn('[socket closed]', info),
    onError: (error) => {
      console.error(error)
      renderStatus('unavailable')
    },
    onDead: () => void stop(),
  })
  // Unlock the AudioContext synchronously inside the tap, before any await —
  // iOS Safari loses the gesture otherwise.
  engine.unlockAudioSync()
  running = true
  micBtn.classList.add('on')
  void engine
    .start({
      microphone: {
        onDiagnostics: renderDiagnostics,
        // Empty value = let the engine use its remembered device, then the
        // browser default. Chrome's default is not always the mic in the room.
        ...(deviceSel.value ? { deviceId: deviceSel.value } : {}),
      },
    })
    .then(refreshDevices)
    .catch((error) => {
      console.error(error)
      renderStatus('unavailable')
      void stop()
    })
}

micBtn.addEventListener('click', () => {
  if (running) void stop()
  else start()
})
