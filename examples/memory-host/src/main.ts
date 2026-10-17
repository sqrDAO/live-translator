import './style.css'

import {
  DEFAULT_DEVICE_STORAGE_KEY,
  LiveTranslateEngine,
  type CaptureDiagnostics,
  type LangTag,
  type LanguagePack,
  type LatencyReport,
  type LiveSessionContext,
  type MintToken,
  type TokenGrant,
} from '@sqrdao/live-translate'
import { enVi } from '@sqrdao/live-translate/lang/en-vi'
import { enZh } from '@sqrdao/live-translate/lang/en-zh'
import { viZh } from '@sqrdao/live-translate/lang/vi-zh'

import {
  arrivedWithSignInLink,
  authErrorMessage,
  decide,
  finishSignInLink,
  idToken,
  listRequests,
  recheck,
  rememberedLinkEmail,
  resendVerification,
  resetPassword,
  sendSignInLink,
  signIn,
  signInWithEmail,
  signOut,
  signUpWithEmail,
  watchAuth,
  type AccessRequest,
  type AuthState,
} from './auth'
import { MemorySink, type StoredUtterance } from './memory-sink'
import { detailsContext, detailsSummary, saveDetails, storedDetails } from './session-details'
import { bindThemeToggle } from './theme'
import { TranscriptHistory, TranscriptArchive, TRANSCRIPT_PREFIX, TRANSCRIPT_DELETE_PREFIX, transcriptText, type TranscriptRecorder, type TranscriptSession } from './transcript-history'

/** The pairs the token endpoint accepts, by the id sent as `pair`. */
const PACKS: Readonly<Record<string, LanguagePack>> = { 'en-vi': enVi, 'en-zh': enZh, 'vi-zh': viZh }
const PAIR_STORAGE_KEY = 'live-translate:pair'

/** Each language named in itself, for the caption tag and the direction buttons. */
const SHORT: Readonly<Record<LangTag, string>> = { en: 'EN', vi: 'VI', zh: '中文' }
const ENDONYM: Readonly<Record<LangTag, string>> = { en: 'ENGLISH', vi: 'TIẾNG VIỆT', zh: '中文' }

function rememberedPair(): string {
  try {
    const stored = window.localStorage.getItem(PAIR_STORAGE_KEY)
    return stored && Object.hasOwn(PACKS, stored) ? stored : 'en-vi'
  } catch {
    return 'en-vi'
  }
}

/**
 * The language pair this feed interprets between. Like the direction it is
 * pinned into every token, so it is read once per run and a change restarts.
 */
let pairId = rememberedPair()

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
 * The programme context this run's tokens carry, snapshotted at `start()`.
 *
 * A snapshot, not a live read of the fields: the engine re-mints on every
 * reconnect, and a feed whose reconnects picked up a half-typed edit would
 * have its two sessions pinned to different instructions. Edits wait for the
 * next start, and the help text says so.
 */
let runContext: LiveSessionContext | null = null

/**
 * The host's authorization hook. The engine calls it once per target at
 * start and again on every reconnect (tokens are single-use). It hits the
 * host's own endpoint; the API key never reaches this code.
 */
const mintToken: MintToken = async (target): Promise<TokenGrant> => {
  // Fetched per mint: Firebase refreshes it near its one-hour expiry, so a
  // reconnect late in a long feed still presents a current one.
  const bearer = await idToken()
  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    // The declared direction travels with every mint, including the ones the
    // engine makes on reconnect: the session prompt is pinned into the token,
    // so a reconnect that forgot it would silently return that half of the
    // feed to Auto mid-session. The context rides along for the same reason:
    // a reconnect without it would quietly lose the glossary.
    body: JSON.stringify({
      pair: pairId,
      target,
      ...(speakerLang ? { speakerLang } : {}),
      ...(runContext ? { context: runContext } : {}),
    }),
  })
  if (!response.ok) {
    // Signed out elsewhere, or access withdrawn since sign-in: no reconnect
    // will succeed, so send the person back to the gate rather than leaving a
    // dead feed that reads "mất kết nối".
    if (response.status === 401 || response.status === 403) {
      void recheck().then(showAuth, showAuthError)
    }
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
const pairSel = $<HTMLSelectElement>('#pair')

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
  const target = PACKS[pairId]!.pair.find((lang) => lang !== u.sourceLang) ?? ''
  el.querySelector('.tag')!.textContent = `${SHORT[u.sourceLang] ?? u.sourceLang} → ${ENDONYM[target] ?? target}`
  el.querySelector('.original')!.textContent = u.original
  el.querySelector('.translated')!.textContent = u.translated || (u.final ? 'Chưa có bản dịch' : 'Đang dịch…')
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
let lastLatency: LatencyReport | null = null
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

/**
 * Measured latencies only, under one p50/p95 label. The session whose target
 * is the speaker's own language never outputs, so an "output —" for it is the
 * expected shape, not news, and printing it per language only buried the
 * numbers that were measured.
 */
function latencyParts(): string[] {
  const ms = (s: { p50: number; p95: number }) => `${s.p50}/${s.p95}ms`
  const parts = PACKS[pairId]!.pair.flatMap((lang) => {
    const recognition = lastLatency?.captureToFirstRecognition[lang]
    const translation = lastLatency?.captureToFirstTranslation[lang]
    return [
      ...(recognition ? [`${lang} heard ${ms(recognition)}`] : []),
      ...(translation ? [`${lang} out ${ms(translation)}`] : []),
    ]
  })
  return parts.length ? [`onset→ (p50/p95): ${parts.join(', ')}`] : []
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
    ...latencyParts(),
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
bindThemeToggle($<HTMLButtonElement>('#theme-toggle'), () => window.localStorage)

const transcripts = new TranscriptHistory(() => window.localStorage)
const archive = new TranscriptArchive(transcripts, renderStorageStatus)
let recorder: TranscriptRecorder | null = null
const dialog = $<HTMLDialogElement>('#history-dialog')
const sessionSel = $<HTMLSelectElement>('#history-session')
const downloadBtn = $<HTMLButtonElement>('#history-download')
const deleteBtn = $<HTMLButtonElement>('#history-delete')
let storedSessions: TranscriptSession[] = []
let historySessions: TranscriptSession[] = []
let storageOperationFailed = false
let showingStorageError = false

function renderStorageStatus(): void {
  const failed = archive.failed || storageOperationFailed
  if (failed === showingStorageError) return
  showingStorageError = failed
  $('#hint-text').textContent = failed
    ? 'History storage is unavailable. Download unsaved transcripts before leaving.'
    : 'Transcripts saved in this browser · no audio recording'
  $('#history-error').hidden = !failed
  $('#history-error').textContent = failed
    ? 'Browser storage is unavailable or full. Unsaved sessions remain available to download until you leave this page.'
    : ''
}

function selectedSession(): TranscriptSession | undefined {
  return historySessions.find((session) => session.id === sessionSel.value)
}

function renderHistory(): void {
  const selected = selectedSession()
  const text = selected ? transcriptText(selected) : 'No recorded sessions yet.'
  // Leave the DOM and scroll position alone when viewing an unchanged past session.
  if ($('#history-transcript').textContent !== text) $('#history-transcript').textContent = text
  downloadBtn.disabled = !selected
  deleteBtn.disabled = !selected || ((running || stoppingRun) && selected.id === recorder?.session.id)
}

function sessionLabel(session: TranscriptSession): string {
  const count = session.utterances.length
  return `${new Date(session.startedAt).toLocaleString()} · ${session.speakerLang ?? 'Auto'} · ${count} ${count === 1 ? 'utterance' : 'utterances'}`
}

function refreshHistory(): void {
  const previous = sessionSel.value
  try {
    storedSessions = transcripts.list()
    storageOperationFailed = false
  } catch {
    storageOperationFailed = true
  }
  renderStorageStatus()
  historySessions = archive.merge(storedSessions)
  sessionSel.replaceChildren(...historySessions.map((session) => new Option(sessionLabel(session), session.id)))
  if (historySessions.some((session) => session.id === previous)) sessionSel.value = previous
  renderHistory()
}

/** Live captions update their own option only, with no storage scan. */
function updateLiveHistory(run: TranscriptRecorder): void {
  if (!dialog.open || run.deleted) return
  historySessions = archive.merge(storedSessions)
  let option = Array.from(sessionSel.options).find((item) => item.value === run.session.id)
  if (!option && run.session.utterances.length) {
    option = new Option('', run.session.id)
    sessionSel.add(option, 0)
  }
  const label = sessionLabel(run.session)
  if (option && option.textContent !== label) option.textContent = label
  if (sessionSel.value === run.session.id) renderHistory()
}

$('#history-open').addEventListener('click', () => {
  archive.flush()
  refreshHistory()
  if (typeof dialog.showModal === 'function') dialog.showModal()
  else { dialog.setAttribute('open', ''); $('#history-close').focus() }
})
function closeHistory(): void {
  if (typeof dialog.close === 'function') dialog.close()
  else dialog.removeAttribute('open')
  $('#history-open').focus()
}
$('#history-close').addEventListener('click', closeHistory)
dialog.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && typeof dialog.close !== 'function') closeHistory()
})
sessionSel.addEventListener('change', renderHistory)
downloadBtn.addEventListener('click', () => {
  const session = selectedSession()
  if (!session) return
  const url = URL.createObjectURL(new Blob([transcriptText(session)], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `transcript-${new Date(session.startedAt).toISOString().replace(/[:.]/g, '-')}.txt`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
})
deleteBtn.addEventListener('click', () => {
  const session = selectedSession()
  if (!session || ((running || stoppingRun) && session.id === recorder?.session.id)) return
  if (!window.confirm('Delete this saved transcript? This cannot be undone.')) return
  try {
    transcripts.delete(session.id)
    archive.discard(session.id)
    archive.flush()
    refreshHistory()
  } catch {
    storageOperationFailed = true
    renderStorageStatus()
  }
})
let storageRefreshTimer: ReturnType<typeof setTimeout> | undefined
window.addEventListener('storage', (event) => {
  if (event.key !== null && !event.key.startsWith(TRANSCRIPT_PREFIX) && !event.key.startsWith(TRANSCRIPT_DELETE_PREFIX)) return
  if (event.key?.startsWith(TRANSCRIPT_DELETE_PREFIX) && event.newValue !== null) {
    archive.discard(event.key.slice(TRANSCRIPT_DELETE_PREFIX.length))
  }
  if (!dialog.open || storageRefreshTimer !== undefined) return
  storageRefreshTimer = setTimeout(() => {
    storageRefreshTimer = undefined
    refreshHistory()
  }, 1000)
})
window.addEventListener('pagehide', () => archive.flush())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') archive.flush()
})

let engine: LiveTranslateEngine | null = null
let running = false
let stoppingRun = false
let stopPromise: Promise<void> | null = null

function stop(): Promise<void> {
  if (stopPromise) return stopPromise
  stoppingRun = true
  micBtn.disabled = true
  running = false
  micBtn.classList.remove('on')
  const stopping = engine
  const stoppingRecorder = recorder
  stopPromise = (async () => {
    try {
      await stopping?.stop()
    } catch (error) {
      console.error(error)
      renderStatus('unavailable')
    } finally {
      if (stoppingRecorder) archive.finish(stoppingRecorder)
      if (engine === stopping) engine = null
      if (recorder === stoppingRecorder) recorder = null
      stoppingRun = false
      stopPromise = null
      micBtn.disabled = false
      micBtn.setAttribute('aria-label', 'Start translating')
    }
    if (dialog.open) refreshHistory()
  })()
  return stopPromise
}

function start(): void {
  if (running || stoppingRun) return
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
  lastLatency = null
  runContext = currentDetailsContext()
  const runRecorder = archive.begin(speakerLang)
  recorder = runRecorder
  const sink = new MemorySink({
    onUtterance: (u) => {
      runRecorder.record(u)
      renderUtterance(u)
      updateLiveHistory(runRecorder)
    },
    onRetract: (id) => {
      runRecorder.retract(id)
      removeUtterance(id)
      updateLiveHistory(runRecorder)
    },
    onStatus: renderStatus,
  })
  engine = new LiveTranslateEngine({
    languages: PACKS[pairId]!,
    allowSourceOnly: true,
    partialSegmentIntervalMs: 100,
    onLatency: (report) => { lastLatency = report; paint() },
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
  try {
    engine.unlockAudioSync()
  } catch (error) {
    console.error(error)
    renderStatus('unavailable')
    void stop()
    return
  }
  const startingEngine = engine
  running = true
  micBtn.setAttribute('aria-label', 'Stop translating')
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
      if (engine !== startingEngine) return
      console.error(error)
      renderStatus('unavailable')
      void stop()
    })
}

micBtn.addEventListener('click', () => {
  if (running) void stop()
  else start()
})

/** Rebuilds the declared-direction buttons for the current pair; Auto stays. */
function buildDirectionButtons(): void {
  for (const button of directionEl.querySelectorAll('button[data-dir]:not([data-dir="auto"])')) button.remove()
  const [first, second] = PACKS[pairId]!.pair
  for (const [from, to] of [[first, second], [second, first]] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.dir = from
    button.textContent = `${SHORT[from] ?? from}→${SHORT[to] ?? to}`
    directionEl.append(button)
  }
}

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
  restartIfRunning()
})

pairSel.addEventListener('change', () => {
  if (!Object.hasOwn(PACKS, pairSel.value) || pairSel.value === pairId) return
  pairId = pairSel.value
  try {
    window.localStorage.setItem(PAIR_STORAGE_KEY, pairId)
  } catch {
    // A per-viewer convenience; the pair still applies to this page.
  }
  // A declared speaker language may not be in the new pair, and Auto is the
  // only direction every pair shares.
  speakerLang = null
  buildDirectionButtons()
  renderDirection()
  restartIfRunning()
})

function restartIfRunning(): void {
  // The pair and the direction are pinned into every token this feed already
  // minted, so a running engine cannot adopt either: the sessions would keep
  // the prompt they opened with while the captions carried the new label.
  // Tear down and rebuild — the feed clears and both sessions re-mint.
  if (running) {
    void stop().then(() => {
      // Restart with the latest pair and direction after teardown finishes.
      if (!running) start()
    })
  }
}

pairSel.value = pairId
buildDirectionButtons()
renderDirection()

// --- Session details ---------------------------------------------------------
// Saved on every keystroke, read at start (see `runContext`).
const detailsTitle = $<HTMLInputElement>('#details-title')
const detailsSpeakers = $<HTMLTextAreaElement>('#details-speakers')
const detailsGlossary = $<HTMLTextAreaElement>('#details-glossary')
const detailsState = $('#details-state')

function currentDetailsContext(): LiveSessionContext | null {
  return detailsContext({ title: detailsTitle.value, speakers: detailsSpeakers.value, glossary: detailsGlossary.value })
}

const remembered = storedDetails(() => window.localStorage)
detailsTitle.value = remembered.title
detailsSpeakers.value = remembered.speakers
detailsGlossary.value = remembered.glossary
detailsState.textContent = detailsSummary(currentDetailsContext())

$('#session-details').addEventListener('input', () => {
  saveDetails(() => window.localStorage, {
    title: detailsTitle.value,
    speakers: detailsSpeakers.value,
    glossary: detailsGlossary.value,
  })
  detailsState.textContent = detailsSummary(currentDetailsContext())
})

// --- Sign-in -----------------------------------------------------------------
// The server is the gate (`/api/token` mints for approved callers only); this
// decides which screen to show. First sign-in files an access request, which
// an admin approves in the Firebase console.
const gateVi = $('#gate-vi')
const gateEn = $('#gate-en')
const gateError = $('#gate-error')
const signInBtn = $<HTMLButtonElement>('#gate-signin')
const recheckBtn = $<HTMLButtonElement>('#gate-recheck')
const switchBtn = $<HTMLButtonElement>('#gate-switch')
const resendBtn = $<HTMLButtonElement>('#gate-resend')
const gateForm = $<HTMLFormElement>('#gate-form')
const emailInput = $<HTMLInputElement>('#gate-email')
const passwordInput = $<HTMLInputElement>('#gate-password')
const submitBtn = $<HTMLButtonElement>('#gate-submit')
const toggleBtn = $<HTMLButtonElement>('#gate-toggle')
const gateHint = $('#gate-hint')
const passwordTab = $<HTMLButtonElement>('#gate-tab-password')
const linkTab = $<HTMLButtonElement>('#gate-tab-link')
/** Set on the return trip from an emailed link whose address must be re-entered. */
let finishingLink = false
const accountEl = $('#account')
const accountEmail = $('#account-email')
const signOutBtn = $<HTMLButtonElement>('#signout')

function showGateError(message: string | null): void {
  gateError.textContent = message ?? ''
  gateError.hidden = !message
}

function showAuthError(error: unknown): void {
  showGateError(authErrorMessage(error))
}

/** The gate's wording per state: Vietnamese first, English beneath, as elsewhere. */
const GATE_TEXT = {
  out: ['Đăng nhập để sử dụng', 'approved accounts only'],
  unverified: ['Xác nhận email', 'open the link we emailed you, then check again'],
  waiting: ['Đang chờ duyệt', 'access requested · an admin will approve it'],
  denied: ['Không có quyền truy cập', 'access was not approved'],
} as const

function showAuth(state: AuthState): void {
  // Firebase reports "signed out" as it starts, which would otherwise wipe
  // the prompt to re-enter the email a link was sent to.
  if (!finishingLink) showGateError(null)
  if (state.kind === 'signed-in' && state.access === 'approved') {
    document.body.dataset.auth = 'in'
    accountEmail.textContent = state.dev ? `${state.email} · development, no sign-in` : state.email
    // The development user has no session to end.
    signOutBtn.hidden = Boolean(state.dev)
    requestsOpenBtn.hidden = !state.admin
    accountEl.hidden = false
    if (state.admin) void refreshRequests()
    return
  }
  if (requestsDialog.open) requestsDialog.close()
  if (running) void stop()
  accountEl.hidden = true
  const gate =
    state.kind === 'signed-out'
      ? 'out'
      : state.access === 'denied'
        ? 'denied'
        : state.access === 'unverified'
          ? 'unverified'
          : 'waiting'
  document.body.dataset.auth = gate
  gateVi.textContent = GATE_TEXT[gate][0]
  gateEn.textContent = state.kind === 'signed-in' ? `${state.email} · ${GATE_TEXT[gate][1]}` : GATE_TEXT[gate][1]
  signInBtn.hidden = gate !== 'out'
  recheckBtn.hidden = gate !== 'waiting' && gate !== 'unverified'
  resendBtn.hidden = gate !== 'unverified'
  switchBtn.hidden = gate === 'out'
}

// Each sign-in path's resulting state arrives through `watchAuth`.
signInBtn.addEventListener('click', () => {
  showGateError(null)
  signIn().catch(showAuthError)
})

type FormMode = 'signin' | 'signup' | 'link'

/**
 * Shows one way in at a time. The fields, the hint and the submit button's
 * label all follow the mode, so the button always says what it will do.
 */
function setFormMode(mode: FormMode): void {
  gateForm.dataset.mode = mode
  passwordTab.setAttribute('aria-selected', String(mode !== 'link'))
  linkTab.setAttribute('aria-selected', String(mode === 'link'))
  // Lets password managers offer to save a new password, or fill a saved one.
  passwordInput.autocomplete = mode === 'signup' ? 'new-password' : 'current-password'
  submitBtn.textContent = {
    signin: 'Đăng nhập · Sign in',
    signup: 'Tạo tài khoản · Create account',
    link: finishingLink ? 'Hoàn tất · Finish sign-in' : 'Gửi liên kết · Email me a sign-in link',
  }[mode]
  toggleBtn.textContent = mode === 'signup' ? 'Đã có tài khoản? · Sign in instead' : 'Chưa có tài khoản? · Create an account'
  gateHint.textContent = {
    signin: '',
    signup: 'At least 8 characters. We will email you a link to confirm the address.',
    link: 'No password: we email you a one-time link that signs you in.',
  }[mode]
  showGateError(null)
}

function formMode(): FormMode {
  const mode = gateForm.dataset.mode
  return mode === 'signup' || mode === 'link' ? mode : 'signin'
}

passwordTab.addEventListener('click', () => setFormMode('signin'))
linkTab.addEventListener('click', () => setFormMode('link'))
toggleBtn.addEventListener('click', () => setFormMode(formMode() === 'signup' ? 'signin' : 'signup'))

/** Disables the form while `work` runs; logs and shows any failure. */
function busy(work: Promise<unknown>): void {
  const buttons = gateForm.querySelectorAll<HTMLButtonElement>('button')
  for (const button of buttons) button.disabled = true
  work
    .catch((error: unknown) => {
      // The code (e.g. auth/email-already-in-use) is what to look for when a
      // sign-in "does nothing".
      console.error('[sign-in]', error)
      showAuthError(error)
    })
    .finally(() => {
      for (const button of buttons) button.disabled = false
    })
}

gateForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const mode = formMode()
  const email = emailInput.value.trim()
  const password = passwordInput.value
  if (!email) {
    showGateError('Nhập email · Enter your email address.')
    emailInput.focus()
    return
  }
  if (mode === 'link') {
    showGateError(null)
    busy(
      finishingLink
        ? finishSignInLink(email).then(() => {
            finishingLink = false
            setFormMode('link')
          })
        : sendSignInLink(email).then(() =>
            showGateError(`Đã gửi liên kết đến ${email} · A sign-in link is on its way to ${email}. Open it in this browser.`),
          ),
    )
    return
  }
  if (!password) {
    showGateError('Nhập mật khẩu · Enter your password.')
    passwordInput.focus()
    return
  }
  if (mode === 'signup' && password.length < 8) {
    showGateError('Mật khẩu quá yếu · Password too weak — use at least 8 characters.')
    passwordInput.focus()
    return
  }
  showGateError(null)
  busy((mode === 'signup' ? signUpWithEmail(email, password) : signInWithEmail(email, password)).then(() => (passwordInput.value = '')))
})

/**
 * The return trip from an emailed link: finish at once when this browser sent
 * it, otherwise ask for the address — the link is only good with it.
 */
function resumeSignInLink(): void {
  if (!arrivedWithSignInLink()) return
  const email = rememberedLinkEmail()
  if (email) {
    busy(finishSignInLink(email))
    return
  }
  finishingLink = true
  setFormMode('link')
  showGateError('Nhập lại email để hoàn tất · Enter the email the link was sent to, then press Finish sign-in.')
}

$('#gate-forgot').addEventListener('click', () => {
  const email = emailInput.value.trim()
  if (!email) {
    showGateError('Nhập email trước · Enter your email first, then press this again.')
    emailInput.focus()
    return
  }
  busy(
    resetPassword(email)
      // Worded the same whether or not the account exists: with enumeration
      // protection on, Firebase does not say, and neither should this.
      .then(() => showGateError(`Nếu ${email} có tài khoản, liên kết đặt lại đã được gửi · If ${email} has an account, a reset link is on its way.`)),
  )
})

resendBtn.addEventListener('click', () => {
  resendBtn.disabled = true
  resendVerification()
    .then(() => showGateError('Đã gửi lại · Sent — check your inbox and spam folder.'))
    .catch(showAuthError)
    .finally(() => (resendBtn.disabled = false))
})

recheckBtn.addEventListener('click', () => {
  recheckBtn.disabled = true
  recheck()
    .then(showAuth, showAuthError)
    .finally(() => (recheckBtn.disabled = false))
})

for (const button of [switchBtn, signOutBtn]) {
  button.addEventListener('click', () => {
    void stop()
      .then(signOut)
      .catch(showAuthError)
  })
}

// --- Access requests (admins) -------------------------------------------------
// Shown only to admins, but not trusted to them: `/api/requests` and the
// Firestore rules refuse everyone else whatever this page does.
const requestsOpenBtn = $<HTMLButtonElement>('#requests-open')
const requestsDialog = $<HTMLDialogElement>('#requests-dialog')
const requestsList = $('#requests-list')
const requestsError = $('#requests-error')
let requests: AccessRequest[] = []

function showRequestsError(message: string | null): void {
  requestsError.textContent = message ?? ''
  requestsError.hidden = !message
}

const STATUS_TEXT: Record<AccessRequest['status'], string> = {
  pending: 'chờ duyệt · pending',
  approved: 'đã duyệt · approved',
  denied: 'từ chối · denied',
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : ''
}

function renderRequests(): void {
  const pending = requests.filter((r) => r.status === 'pending').length
  requestsOpenBtn.textContent = pending ? `Requests (${pending})` : 'Requests'
  // Pending first, newest first within each group (the server sends newest first).
  const ordered = [...requests].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'))
  if (!ordered.length) {
    const li = document.createElement('li')
    li.innerHTML = '<p class="requests-empty">No requests yet.</p>'
    requestsList.replaceChildren(li)
    return
  }
  requestsList.replaceChildren(
    ...ordered.map((r) => {
      const li = document.createElement('li')
      li.className = 'request'
      li.dataset.status = r.status
      li.dataset.uid = r.uid
      li.innerHTML =
        '<div class="request-who"><strong></strong><p class="request-meta"></p></div>' +
        '<div class="request-actions">' +
        '<button type="button" class="history-button approve" data-decide="approved">Approve</button>' +
        '<button type="button" class="history-button" data-decide="denied">Deny</button></div>'
      li.querySelector('strong')!.textContent = r.name ? `${r.name} · ${r.email ?? r.uid}` : (r.email ?? r.uid)
      const decided = r.decidedBy ? ` · ${r.decidedBy}, ${when(r.decidedAt)}` : ''
      li.querySelector('.request-meta')!.textContent = `${STATUS_TEXT[r.status]} · asked ${when(r.requestedAt)}${decided}`
      // A decided row keeps only the action that would reverse it.
      for (const button of li.querySelectorAll<HTMLButtonElement>('button[data-decide]')) {
        button.hidden = button.dataset.decide === r.status
      }
      return li
    }),
  )
}

async function refreshRequests(): Promise<void> {
  try {
    requests = await listRequests()
    showRequestsError(null)
    renderRequests()
  } catch (error) {
    showRequestsError(`Could not load requests: ${error instanceof Error ? error.message : String(error)}`)
  }
}

requestsOpenBtn.addEventListener('click', () => {
  requestsDialog.showModal()
  void refreshRequests()
})
$('#requests-close').addEventListener('click', () => requestsDialog.close())

requestsList.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-decide]')
  const uid = button?.closest<HTMLElement>('.request')?.dataset.uid
  if (!button || !uid) return
  const status = button.dataset.decide as AccessRequest['status']
  for (const b of requestsList.querySelectorAll<HTMLButtonElement>(`[data-uid="${CSS.escape(uid)}"] button`)) b.disabled = true
  decide(uid, status)
    .then(refreshRequests)
    .catch((error: unknown) => {
      showRequestsError(`Could not save that decision: ${error instanceof Error ? error.message : String(error)}`)
      renderRequests()
    })
})

watchAuth(showAuth, showAuthError).then(resumeSignInLink, (error: unknown) => {
  document.body.dataset.auth = 'out'
  signInBtn.hidden = true
  showAuthError(error)
})
