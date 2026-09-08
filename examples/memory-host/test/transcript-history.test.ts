import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PARTIAL_SAVE_MS, TRANSCRIPT_DELETE_PREFIX, TRANSCRIPT_PREFIX,
  TranscriptArchive, TranscriptHistory, TranscriptRecorder, transcriptText,
} from '../src/transcript-history'

function storage() {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  }
}
const utterance = {
  utteranceId: 'u0', sourceLang: 'en', original: 'Hello', translated: 'Xin chào',
  startedAt: 1000, updatedAt: 2000, final: false,
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('persistent transcript history', () => {
  it('coalesces partial writes, persists finals immediately, and cancels stale timers', () => {
    const disk = storage()
    const writes = vi.spyOn(disk, 'setItem')
    const history = new TranscriptHistory(() => disk)
    const recorder = new TranscriptRecorder(history, 'en')
    expect(writes).not.toHaveBeenCalled()
    for (let i = 0; i < 50; i += 1) recorder.record({ ...utterance, translated: String(i) })
    expect(writes).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PARTIAL_SAVE_MS)
    expect(writes).toHaveBeenCalledTimes(1)
    expect(history.list()[0].utterances[0].translated).toBe('49')
    recorder.record({ ...utterance, translated: 'final', final: true })
    expect(writes).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(PARTIAL_SAVE_MS)
    expect(writes).toHaveBeenCalledTimes(2)
    expect(history.list()[0].utterances).toHaveLength(1)
  })

  it('flushes the newest partial on lifecycle boundaries and keeps run IDs separate', () => {
    const disk = storage()
    const history = new TranscriptHistory(() => disk)
    const archive = new TranscriptArchive(history)
    const first = archive.begin('en')
    first.record(utterance)
    archive.flush() // pagehide / visibilitychange
    expect(new TranscriptHistory(() => disk).list()[0].utterances).toEqual([utterance])
    archive.finish(first)
    const second = archive.begin('vi')
    second.record({ ...utterance, original: 'Another session' })
    archive.finish(second)
    const sessions = history.list()
    expect(sessions).toHaveLength(2)
    expect(sessions.find((s) => s.id === first.session.id)).toMatchObject({ endedAt: expect.any(Number), speakerLang: 'en' })
    expect(sessions.find((s) => s.id === second.session.id)?.speakerLang).toBe('vi')
  })

  it('does not persist failed or cancelled starts with no captions', () => {
    const disk = storage()
    const history = new TranscriptHistory(() => disk)
    const archive = new TranscriptArchive(history)
    const recorder = archive.begin(null)
    archive.finish(recorder)
    expect(history.list()).toEqual([])
    expect(archive.merge([])).toEqual([])
  })

  it('persists retractions and prevents a queued write from resurrecting a cross-tab deletion', () => {
    const disk = storage()
    const history = new TranscriptHistory(() => disk)
    const recorder = new TranscriptRecorder(history, null)
    recorder.record(utterance)
    recorder.flush()
    recorder.retract('u0')
    expect(history.list()[0].utterances).toEqual([])
    recorder.record(utterance)
    new TranscriptHistory(() => disk).delete(recorder.session.id)
    vi.advanceTimersByTime(PARTIAL_SAVE_MS)
    recorder.finish()
    expect(recorder.deleted).toBe(true)
    expect(history.list()).toEqual([])
  })

  it('honors deletion even when it interleaves with a save', () => {
    const disk = storage()
    const history = new TranscriptHistory(() => disk)
    const recorder = new TranscriptRecorder(history, null)
    const setItem = disk.setItem
    vi.spyOn(disk, 'setItem').mockImplementation((key, value) => {
      if (key === TRANSCRIPT_PREFIX + recorder.session.id) {
        setItem(TRANSCRIPT_DELETE_PREFIX + recorder.session.id, '1')
      }
      setItem(key, value)
    })
    recorder.record({ ...utterance, final: true })
    expect(history.list()).toEqual([])
    expect(recorder.deleted).toBe(true)
    expect(disk.getItem(TRANSCRIPT_PREFIX + recorder.session.id)).toBeNull()
  })

  it('does not overlay a finished saved run after it is deleted in another tab', () => {
    const disk = storage()
    const history = new TranscriptHistory(() => disk)
    const archive = new TranscriptArchive(history)
    const recorder = archive.begin(null)
    recorder.record(utterance)
    archive.finish(recorder)
    new TranscriptHistory(() => disk).delete(recorder.session.id)
    expect(archive.merge(history.list())).toEqual([])
  })

  it('keeps unsaved runs across direction changes and clears failures after recovery', () => {
    const disk = storage()
    const history = new TranscriptHistory(() => disk)
    const archive = new TranscriptArchive(history)
    const first = archive.begin('en')
    first.record({ ...utterance, final: true })
    const writes = vi.spyOn(disk, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    first.record({ ...utterance, translated: 'latest unsaved translation', final: true })
    archive.finish(first)
    const second = archive.begin('vi')
    second.record(utterance)
    archive.finish(second)
    expect(archive.failed).toBe(true)
    const recoverable = archive.merge(history.list())
    expect(recoverable).toHaveLength(2)
    expect(transcriptText(recoverable.find((s) => s.id === first.session.id)!)).toContain('latest unsaved translation')
    expect(history.list()[0].utterances[0].translated).toBe('Xin chào')
    writes.mockRestore()
    archive.flush()
    expect(archive.failed).toBe(false)
    expect(history.list()).toHaveLength(2)
    expect(history.list().find((s) => s.id === first.session.id)?.utterances[0].translated).toBe('latest unsaved translation')
    history.delete(first.session.id)
    expect(archive.merge(history.list())).toHaveLength(1)
  })

  it('retains a downloadable transcript when even accessing storage is denied', () => {
    const history = new TranscriptHistory(() => { throw new Error('Access denied') })
    const archive = new TranscriptArchive(history)
    const recorder = archive.begin(null)
    recorder.record(utterance)
    archive.finish(recorder)
    expect(archive.failed).toBe(true)
    expect(transcriptText(archive.merge([])[0])).toContain('Hello\nXin chào')
  })

  it('rejects damaged utterances, invalid dates, and mismatched IDs without hiding valid records', () => {
    const disk = storage()
    const history = new TranscriptHistory(() => disk)
    const recorder = new TranscriptRecorder(history, null)
    recorder.record({ ...utterance, final: true })
    const valid = recorder.session
    const invalid = [
      { ...valid, utterances: [null] },
      { ...valid, utterances: [{ ...utterance, translated: undefined }] },
      { ...valid, utterances: [{ ...utterance, final: 'true' }] },
      { ...valid, utterances: [{ ...utterance, updatedAt: 1e300 }] },
      { ...valid, startedAt: 1e300 },
    ]
    invalid.forEach((record, index) => disk.setItem(TRANSCRIPT_PREFIX + index, JSON.stringify({ ...record, id: String(index) })))
    disk.setItem(TRANSCRIPT_PREFIX + 'mismatch', JSON.stringify(valid))
    disk.setItem(TRANSCRIPT_PREFIX + 'broken', '{')
    disk.setItem('microphone', 'device-id')
    expect(history.list()).toEqual([valid])
    expect(disk.getItem('microphone')).toBe('device-id')
  })

  it('exports chronological text even when older utterances first arrive late', () => {
    const recorder = new TranscriptRecorder(new TranscriptHistory(() => storage()), null)
    recorder.record({ ...utterance, utteranceId: 'u1', original: 'later', startedAt: 3000 })
    recorder.record({ ...utterance, original: 'earlier' })
    const text = transcriptText(recorder.session)
    expect(text.indexOf('earlier')).toBeLessThan(text.indexOf('later'))
    expect(recorder.session.utterances[0].original).toBe('later')
  })

  it('creates distinct sessions without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    const history = new TranscriptHistory(() => storage())
    const first = new TranscriptRecorder(history, null)
    const second = new TranscriptRecorder(history, null)
    expect(first.session.id).not.toBe(second.session.id)
  })
})
