import './style.css'

import { LiveTranslateEngine, type MintToken, type TokenGrant } from '@sqrdao/live-translate'
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
  engine = new LiveTranslateEngine({
    languages: enVi,
    sink,
    mintToken,
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
  void engine.start().catch((error) => {
    console.error(error)
    renderStatus('unavailable')
    void stop()
  })
}

micBtn.addEventListener('click', () => {
  if (running) void stop()
  else start()
})
