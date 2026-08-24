import './style.css'

import {
  DEFAULT_DEVICE_STORAGE_KEY,
  LiveTranslateEngine,
  type CaptureDiagnostics,
  type LangTag,
  type MintToken,
  type TokenGrant,
} from '@sqrdao/live-translate'
import { enVi } from '@sqrdao/live-translate/lang/en-vi'

import { MemorySink, type StoredUtterance } from './memory-sink'

/**
 * The operator-declared speaker language, or `null` for Auto.
 *
 * Auto runs both sessions and lets the engine infer the source per utterance,
 * which is right for a two-way conversation and wrong for a talk: one
 * mislabelled utterance puts a caption on the wrong side of the pair. A
 * declared direction removes the inference — the engine labels every
 * utterance with it, and the token pins the model to a single unconditional
 * job (`speakerLang` in the session prompt) instead of deciding per turn
 * whether to translate or repeat.
 */
let speakerLang: LangTag | null = null

/**
 * The host's authorization hook. The engine calls it once per target at
 * start and again on every reconnect (tokens are single-use). It hits the
 * host's own endpoint; the API key never reaches this code.
 */
const mintToken: MintToken = async (target): Promise<TokenGrant> => {
  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The declared direction travels with every mint, including the ones the
    // engine makes on reconnect: the session prompt is pinned into the token,
    // so a reconnect that forgot it would silently return that half of the
    // feed to Auto mid-session.
    body: JSON.stringify({ target, ...(speakerLang ? { speakerLang } : {}) }),
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
const directionEl = $('#direction')

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
type Wire = { sockets: number; frames: number; closes: number; lastClose: string }
const freshWire = (): Wire => ({ sockets: 0, frames: 0, closes: 0, lastClose: '' })

/**
 * Counted per run, and each socket reports only to the run that opened it.
 *
 * Stopping an engine closes its sockets, and those close events land *after*
 * the next run has started — so a single shared counter charged the previous
 * session's teardown to the new one. Switching direction restarts the feed,
 * which made the panel greet every switch with "⚠ 2 closes" for a session
 * whose sockets were both healthy: the one line an operator consults to tell
 * a dead feed from a quiet one, reporting the wrong session's death.
 */
let wire = freshWire()

function createSocket(url: string): WebSocket {
  const socket = new WebSocket(url)
  const run = wire
  run.sockets += 1
  socket.addEventListener('message', () => {
    if (run !== wire) return
    run.frames += 1
    paint()
  })
  socket.addEventListener('close', (event) => {
    if (run !== wire) return
    run.closes += 1
    run.lastClose = `${event.code}${event.reason ? ` ${event.reason}` : ''}`
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

  // Two sessions either way. In Auto the engine decides the source per
  // utterance; with a declared direction it is told, and so is the model.
  wire = freshWire()
  engine = new LiveTranslateEngine({
    languages: enVi,
    sink,
    mintToken,
    createSocket,
    // Fixed for this engine's lifetime, which is why changing it restarts.
    ...(speakerLang ? { forcedSourceLang: speakerLang } : {}),
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

function renderDirection(): void {
  for (const button of directionEl.querySelectorAll<HTMLButtonElement>('button[data-dir]')) {
    const selected = (button.dataset.dir === 'auto' ? null : button.dataset.dir) === speakerLang
    button.setAttribute('aria-pressed', String(selected))
  }
}

directionEl.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-dir]')
  if (!button) return
  const chosen = button.dataset.dir === 'auto' ? null : (button.dataset.dir as LangTag)
  if (chosen === speakerLang) return
  speakerLang = chosen
  renderDirection()

  // The direction is pinned into every token this feed already minted, so a
  // running engine cannot adopt it: the sessions would keep the prompt they
  // opened with while the captions carried the new label. Tear down and
  // rebuild — the feed clears and both sessions re-mint.
  if (running) {
    void stop().then(() => {
      // A tap on the mic during the teardown owns the decision; only restart
      // if nothing else did.
      if (!running) start()
    })
  }
})

renderDirection()
