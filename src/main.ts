import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { Translator, type Mode } from './translator'
import type { Lang } from './gemini/session'
import { renderStatus, renderUtterance, clearFeed, setMicOn, setLevel } from './ui'

registerSW({ immediate: true })

const APP_VERSION = '0.2.0'

let mode: Mode = 'conversation'
let speechTarget: Lang = 'vi' // speech mode: EN speech → VI text by default

const WRONG_DIRECTION_NOTE = 'câu này đã ở ngôn ngữ đích — bấm ⇄ để dịch chiều ngược lại'

const translator = new Translator({
  onUtterance: (u) => renderUtterance(u, mode === 'speech' ? WRONG_DIRECTION_NOTE : undefined),
  onStatus: renderStatus,
  onLevel: setLevel,
})

const micBtn = document.getElementById('mic') as HTMLButtonElement
const modeBtns = [...document.querySelectorAll<HTMLButtonElement>('.mode')]
const directionEl = document.getElementById('direction') as HTMLDivElement
const dirFrom = document.getElementById('dir-from') as HTMLSpanElement
const dirTo = document.getElementById('dir-to') as HTMLSpanElement
const swapBtn = document.getElementById('swap') as HTMLButtonElement
const micSelect = document.getElementById('mic-select') as HTMLSelectElement

const MIC_STORAGE_KEY = 'live-translator.micDeviceId'
let micDeviceId = localStorage.getItem(MIC_STORAGE_KEY) ?? ''

// Device labels are only exposed once mic permission has been granted, so this
// runs at load and again after each successful start.
async function refreshMicList(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId)
    micSelect.innerHTML = '<option value="">Mic mặc định</option>'
    for (const m of mics) {
      const opt = document.createElement('option')
      opt.value = m.deviceId
      opt.textContent = m.label || `Mic ${micSelect.options.length}`
      micSelect.appendChild(opt)
    }
    if ([...micSelect.options].some((o) => o.value === micDeviceId)) {
      micSelect.value = micDeviceId
    } else {
      micDeviceId = ''
      micSelect.value = ''
    }
  } catch {
    // enumeration unavailable — keep the default option
  }
}

micSelect.addEventListener('change', async () => {
  micDeviceId = micSelect.value
  localStorage.setItem(MIC_STORAGE_KEY, micDeviceId)
  if (translator.isRunning) {
    await stopTranslator()
    await startTranslator()
  }
})

function renderDirection(): void {
  const from: Lang = speechTarget === 'vi' ? 'en' : 'vi'
  dirFrom.dataset.lang = from
  dirFrom.textContent = from === 'en' ? 'English' : 'Tiếng Việt'
  dirTo.dataset.lang = speechTarget
  dirTo.textContent = speechTarget === 'en' ? 'English' : 'Tiếng Việt'
}

async function startTranslator(): Promise<void> {
  setMicOn(true)
  try {
    await translator.start(mode, speechTarget, micDeviceId || undefined)
    void refreshMicList()
  } catch (err) {
    console.error(err)
    setMicOn(false)
    renderStatus('error', err instanceof Error ? err.message : String(err))
  }
}

async function stopTranslator(): Promise<void> {
  await translator.stop()
  setMicOn(false)
}

micBtn.addEventListener('click', () => {
  if (translator.isRunning) {
    void stopTranslator()
    return
  }
  // Synchronously, while the tap is still active: everything inside
  // startTranslator() runs after an await, which is too late for iOS Safari to
  // let the AudioContext start.
  translator.unlockAudio()
  void startTranslator()
})

modeBtns.forEach((btn) =>
  btn.addEventListener('click', async () => {
    const next = btn.dataset.mode as Mode
    if (next === mode) return
    const wasRunning = translator.isRunning
    await stopTranslator()
    mode = next
    modeBtns.forEach((b) => b.classList.toggle('active', b === btn))
    directionEl.classList.toggle('hidden', mode !== 'speech')
    clearFeed()
    if (wasRunning) await startTranslator()
  }),
)

swapBtn.addEventListener('click', async () => {
  speechTarget = speechTarget === 'vi' ? 'en' : 'vi'
  swapBtn.classList.toggle('spun')
  renderDirection()
  if (translator.isRunning) {
    await stopTranslator()
    await startTranslator()
  }
})

// Live diagnostics: proves at a glance which build is running, which mic is
// captured, and whether audio/model events are flowing.
const diagEl = document.getElementById('diag') as HTMLParagraphElement
setInterval(() => {
  if (!translator.isRunning) {
    diagEl.classList.add('hidden')
    return
  }
  const s = translator.getStats()
  const events = Object.entries(s.trackEvents)
    .map(([target, n]) => `${target}:${n}`)
    .join(' ')
  diagEl.textContent = `v${APP_VERSION} · ${s.micDevice || 'mic…'} @${s.contextRate}Hz · sent ${s.chunksSent} · model events ${events || '—'} · dropped ${s.droppedFragments}`
  diagEl.classList.remove('hidden')
}, 1000)

renderDirection()
void refreshMicList()
