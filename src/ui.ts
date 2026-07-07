import type { Utterance } from './translator'
import type { SessionStatus } from './gemini/session'

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`missing element: ${sel}`)
  return el
}

const feed = $('#feed')
const empty = $('#empty')
const statusEl = $('#status')
const statusText = $('#status-text')
const micBtn = $('#mic')

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'sẵn sàng',
  connecting: 'đang kết nối…',
  open: 'đang dịch',
  closed: 'mất kết nối',
  error: 'lỗi',
}

export function renderStatus(status: SessionStatus, detail?: string): void {
  statusEl.dataset.state = status
  statusText.textContent = detail ? `${STATUS_LABEL[status]} — ${detail}` : STATUS_LABEL[status]
}

export function renderUtterance(u: Utterance, emptyTranslationNote?: string): void {
  empty.classList.add('hidden')
  let el = document.getElementById(`utt-${u.id}`)
  if (!el) {
    el = document.createElement('article')
    el.id = `utt-${u.id}`
    el.className = 'utt'
    el.dataset.lang = u.sourceLang
    el.innerHTML = `
      <div class="tag"></div>
      <p class="original"></p>
      <p class="translated"></p>`
    // Newest utterance on top, pushing older ones down.
    feed.prepend(el)
  }
  el.classList.toggle('final', u.final)
  el.querySelector('.tag')!.textContent =
    u.sourceLang === 'en' ? 'EN → TIẾNG VIỆT' : 'VI → ENGLISH'
  el.querySelector('.original')!.textContent = u.original
  const translatedEl = el.querySelector('.translated')!
  translatedEl.textContent = u.translated
  // Speech spoken in the target language yields no translation — say so
  // instead of leaving a dangling empty bubble.
  const showNote = Boolean(u.final && u.original && !u.translated && emptyTranslationNote)
  el.classList.toggle('note', showNote)
  if (showNote) translatedEl.textContent = emptyTranslationNote!

  // Drop bubbles that ended with nothing in them (e.g. noise-only turns).
  if (u.final && !u.original && !u.translated) el.remove()

  feed.scrollTo({ top: 0, behavior: 'smooth' })
}

export function clearFeed(): void {
  feed.querySelectorAll('.utt').forEach((el) => el.remove())
  empty.classList.remove('hidden')
}

export function setMicOn(on: boolean): void {
  micBtn.classList.toggle('on', on)
  micBtn.setAttribute('aria-label', on ? 'Stop translating' : 'Start translating')
}

export function setLevel(level: number): void {
  micBtn.style.setProperty('--level', level.toFixed(3))
}
