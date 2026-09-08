import type { StoredUtterance } from './memory-sink'

export const TRANSCRIPT_PREFIX = 'live-translate:transcript:v1:'
export const TRANSCRIPT_DELETE_PREFIX = 'live-translate:deleted:v1:'
export const PARTIAL_SAVE_MS = 1000

export interface TranscriptSession {
  version: 1
  id: string
  startedAt: number
  endedAt: number | null
  speakerLang: string | null
  utterances: StoredUtterance[]
}

type HistoryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
const validTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15

function isSession(value: unknown): value is TranscriptSession {
  if (!value || typeof value !== 'object') return false
  const s = value as TranscriptSession
  return s.version === 1 && typeof s.id === 'string' && validTime(s.startedAt)
    && (s.endedAt === null || validTime(s.endedAt))
    && (s.speakerLang === null || typeof s.speakerLang === 'string')
    && Array.isArray(s.utterances) && s.utterances.every((u) => u
      && ['utteranceId', 'sourceLang', 'original', 'translated'].every((key) =>
        typeof (u as unknown as Record<string, unknown>)[key] === 'string')
      && validTime(u.startedAt) && validTime(u.updatedAt) && typeof u.final === 'boolean')
}

export function newestFirst(a: TranscriptSession, b: TranscriptSession): number {
  return b.startedAt - a.startedAt || a.id.localeCompare(b.id)
}

/** One key per run. A small deletion marker prevents other tabs from reviving it. */
export class TranscriptHistory {
  constructor(private readonly storage: () => HistoryStorage) {}

  save(session: TranscriptSession): boolean {
    const storage = this.storage()
    if (storage.getItem(TRANSCRIPT_DELETE_PREFIX + session.id) !== null || storage.getItem(TRANSCRIPT_PREFIX + session.id) === 'null') return false
    storage.setItem(TRANSCRIPT_PREFIX + session.id, JSON.stringify(session))
    // Another tab may delete between our read and write. Its marker is a separate key.
    if (storage.getItem(TRANSCRIPT_DELETE_PREFIX + session.id) !== null) {
      storage.removeItem(TRANSCRIPT_PREFIX + session.id)
      return false
    }
    return true
  }

  list(): TranscriptSession[] {
    const storage = this.storage()
    const sessions: TranscriptSession[] = []
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (!key?.startsWith(TRANSCRIPT_PREFIX)) continue
      const raw = storage.getItem(key)
      try {
        const session: unknown = JSON.parse(raw ?? 'null')
        if (isSession(session) && key === TRANSCRIPT_PREFIX + session.id
          && storage.getItem(TRANSCRIPT_DELETE_PREFIX + session.id) === null) sessions.push(session)
      } catch {
        // A damaged record must not hide other sessions or be overwritten.
      }
    }
    return sessions.sort(newestFirst)
  }

  delete(id: string): void {
    const storage = this.storage()
    // Shrink the record first so a full quota still permits a deletion marker.
    storage.setItem(TRANSCRIPT_PREFIX + id, 'null')
    storage.setItem(TRANSCRIPT_DELETE_PREFIX + id, '1')
    storage.removeItem(TRANSCRIPT_PREFIX + id)
  }
}

function sessionId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  // getRandomValues predates randomUUID and is available on older secure browsers.
  if (globalThis.crypto?.getRandomValues) {
    return Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16).padStart(8, '0')).join('')
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

/** Coalesce partials; finals and lifecycle flushes persist immediately. */
export class TranscriptRecorder {
  readonly session: TranscriptSession
  dirty = false
  failed = false
  deleted = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private saved = false

  constructor(
    private readonly history: TranscriptHistory,
    speakerLang: string | null,
    private readonly onChange: () => void = () => {},
  ) {
    this.session = {
      version: 1, id: sessionId(), startedAt: Date.now(), endedAt: null,
      speakerLang, utterances: [],
    }
    // Failed microphone starts should not leave permanent empty sessions.
  }

  record(utterance: StoredUtterance): void {
    if (this.deleted || this.session.endedAt !== null) return
    const index = this.session.utterances.findIndex((u) => u.utteranceId === utterance.utteranceId)
    if (index < 0) this.session.utterances.push({ ...utterance })
    else this.session.utterances[index] = { ...utterance }
    this.dirty = true
    if (utterance.final) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), PARTIAL_SAVE_MS)
  }

  retract(id: string): void {
    if (this.deleted) return
    this.session.utterances = this.session.utterances.filter((u) => u.utteranceId !== id)
    this.dirty = true
    this.flush()
  }

  finish(): void {
    if (this.session.endedAt === null) {
      this.session.endedAt = Date.now()
      this.dirty = this.dirty || this.saved || this.session.utterances.length > 0
    }
    this.flush()
  }

  /** A deletion observed in another tab wins over queued partial writes. */
  discard(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.deleted = true
    this.dirty = false
    this.failed = false
    this.onChange()
  }

  flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty || this.deleted) return
    try {
      if (!this.history.save(this.session)) {
        this.discard()
        return
      }
      this.saved = true
      this.dirty = false
      this.failed = false
    } catch {
      // Keep all content for another run's History panel and a later retry.
      this.failed = true
    }
    this.onChange()
  }
}

/** Retain unsaved runs across starts; release successful finished runs to storage. */
export class TranscriptArchive {
  private readonly pending = new Map<string, TranscriptRecorder>()

  constructor(readonly history: TranscriptHistory, private readonly onChange: () => void = () => {}) {}

  begin(speakerLang: string | null): TranscriptRecorder {
    this.flush()
    const recorder = new TranscriptRecorder(this.history, speakerLang, () => {
      if (recorder.deleted || (recorder.session.endedAt !== null && !recorder.dirty)) {
        this.pending.delete(recorder.session.id)
      }
      this.onChange()
    })
    this.pending.set(recorder.session.id, recorder)
    return recorder
  }

  finish(recorder: TranscriptRecorder): void {
    recorder.finish()
    if (!recorder.dirty) this.pending.delete(recorder.session.id)
    this.onChange()
  }

  get failed(): boolean {
    return [...this.pending.values()].some((recorder) => recorder.failed)
  }

  /** Merge memory copies only while active or unsaved, preserving date order. */
  merge(stored: TranscriptSession[]): TranscriptSession[] {
    const sessions = new Map(stored.map((session) => [session.id, session]))
    for (const recorder of this.pending.values()) {
      if (!recorder.deleted && recorder.session.utterances.length > 0) sessions.set(recorder.session.id, recorder.session)
    }
    return [...sessions.values()].sort(newestFirst)
  }

  flush(): void {
    for (const recorder of this.pending.values()) recorder.flush()
  }

  discard(id: string): void {
    this.pending.get(id)?.discard()
  }
}

export function transcriptText(session: TranscriptSession): string {
  return [
    `Translation session — ${new Date(session.startedAt).toLocaleString()}`,
    `Direction: ${session.speakerLang ?? 'Auto'}`,
    `Ended: ${session.endedAt === null ? 'not recorded (session may have been interrupted)' : new Date(session.endedAt).toLocaleString()}`,
    '',
    ...session.utterances.slice().sort((a, b) => a.startedAt - b.startedAt || a.utteranceId.localeCompare(b.utteranceId)).map((u) => [
      `[${new Date(u.startedAt).toLocaleTimeString()}] ${u.sourceLang.toUpperCase()}${u.final ? '' : ' (partial)'}`,
      u.original, u.translated, '',
    ].join('\n')),
  ].join('\n')
}
