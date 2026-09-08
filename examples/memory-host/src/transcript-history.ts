import type { StoredUtterance } from './memory-sink'

const PREFIX = 'live-translate:transcript:v1:'

export interface TranscriptSession {
  version: 1
  id: string
  startedAt: number
  endedAt: number | null
  speakerLang: string | null
  utterances: StoredUtterance[]
}

type HistoryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>

function isSession(value: unknown): value is TranscriptSession {
  if (!value || typeof value !== 'object') return false
  const s = value as TranscriptSession
  return s.version === 1 && typeof s.id === 'string' && Number.isFinite(s.startedAt)
    && (s.endedAt === null || Number.isFinite(s.endedAt))
    && (s.speakerLang === null || typeof s.speakerLang === 'string')
    && Array.isArray(s.utterances) && s.utterances.every((u) => u
      && ['utteranceId', 'sourceLang', 'original', 'translated'].every((key) =>
        typeof (u as unknown as Record<string, unknown>)[key] === 'string')
      && Number.isFinite(u.startedAt) && Number.isFinite(u.updatedAt) && typeof u.final === 'boolean')
}

/** One key per run: separate tabs never overwrite each other's history. */
export class TranscriptHistory {
  constructor(private readonly storage: () => HistoryStorage) {}

  save(session: TranscriptSession): void {
    this.storage().setItem(PREFIX + session.id, JSON.stringify(session))
  }

  list(): TranscriptSession[] {
    const storage = this.storage()
    const sessions: TranscriptSession[] = []
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      const raw = storage.getItem(key)
      try {
        const session: unknown = JSON.parse(raw ?? 'null')
        if (isSession(session) && key === PREFIX + session.id) sessions.push(session)
      } catch {
        // A damaged record must not hide other sessions or be overwritten.
      }
    }
    return sessions.sort((a, b) => b.startedAt - a.startedAt)
  }

  delete(id: string): void {
    this.storage().removeItem(PREFIX + id)
  }
}

/** Saves partials too, so closing a tab preserves the last visible text. */
export class TranscriptRecorder {
  readonly session: TranscriptSession

  constructor(
    private readonly history: TranscriptHistory,
    speakerLang: string | null,
    private readonly onError: (error: unknown) => void,
  ) {
    this.session = {
      version: 1, id: crypto.randomUUID(), startedAt: Date.now(), endedAt: null,
      speakerLang, utterances: [],
    }
    this.persist()
  }

  record(utterance: StoredUtterance): void {
    const index = this.session.utterances.findIndex((u) => u.utteranceId === utterance.utteranceId)
    if (index < 0) this.session.utterances.push({ ...utterance })
    else this.session.utterances[index] = { ...utterance }
    this.persist()
  }

  retract(id: string): void {
    this.session.utterances = this.session.utterances.filter((u) => u.utteranceId !== id)
    this.persist()
  }

  finish(): void {
    this.session.endedAt ??= Date.now()
    this.persist()
  }

  private persist(): void {
    try {
      this.history.save(this.session)
    } catch (error) {
      // Storage failure must not interrupt live translation; retain the in-memory copy.
      this.onError(error)
    }
  }
}

export function transcriptText(session: TranscriptSession): string {
  return [
    `Translation session — ${new Date(session.startedAt).toLocaleString()}`,
    `Direction: ${session.speakerLang ?? 'auto'}`,
    `Ended: ${session.endedAt === null ? 'not recorded (session may have been interrupted)' : new Date(session.endedAt).toLocaleString()}`,
    '',
    ...session.utterances.map((u) => [
      `[${new Date(u.startedAt).toLocaleTimeString()}] ${u.sourceLang.toUpperCase()}${u.final ? '' : ' (partial)'}`,
      u.original, u.translated, '',
    ].join('\n')),
  ].join('\n')
}
