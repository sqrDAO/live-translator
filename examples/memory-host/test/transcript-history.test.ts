import { describe, expect, it, vi } from 'vitest'
import { TranscriptHistory, TranscriptRecorder, transcriptText } from '../src/transcript-history'

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

describe('persistent transcript history', () => {
  it('recovers partials after reload, updates in place, and keeps repeated IDs in separate sessions', () => {
    const disk = storage()
    const history = new TranscriptHistory(() => disk)
    const onError = vi.fn()
    const first = new TranscriptRecorder(history, 'en', onError)
    first.record(utterance)
    expect(new TranscriptHistory(() => disk).list()[0].utterances).toEqual([utterance])
    first.record({ ...utterance, translated: 'Xin chào!', final: true })
    first.finish()
    const second = new TranscriptRecorder(history, null, onError)
    second.record({ ...utterance, original: 'Another session' })
    const sessions = new TranscriptHistory(() => disk).list()
    expect(sessions).toHaveLength(2)
    expect(sessions.find((s) => s.id === first.session.id)).toMatchObject({
      endedAt: expect.any(Number),
      utterances: [{ ...utterance, translated: 'Xin chào!', final: true }],
    })
    expect(onError).not.toHaveBeenCalled()
  })

  it('persists retractions and deletes only the selected session', () => {
    const disk = storage()
    const history = new TranscriptHistory(() => disk)
    const first = new TranscriptRecorder(history, null, vi.fn())
    const second = new TranscriptRecorder(history, null, vi.fn())
    first.record(utterance)
    first.retract('u0')
    expect(history.list().find((s) => s.id === first.session.id)?.utterances).toEqual([])
    history.delete(first.session.id)
    expect(history.list().map((s) => s.id)).toEqual([second.session.id])
  })

  it('isolates corrupt records and unrelated browser data', () => {
    const disk = storage()
    disk.setItem('microphone', 'device-id')
    disk.setItem('live-translate:transcript:v1:broken', '{')
    disk.setItem('live-translate:transcript:v1:invalid', JSON.stringify({ version: 1, utterances: [null] }))
    const history = new TranscriptHistory(() => disk)
    const recorder = new TranscriptRecorder(history, null, vi.fn())
    expect(history.list()).toEqual([recorder.session])
    expect(disk.getItem('microphone')).toBe('device-id')
  })

  it('retains a downloadable in-memory transcript when storage is denied or full', () => {
    const onError = vi.fn()
    const history = new TranscriptHistory(() => { throw new Error('Quota exceeded') })
    const recorder = new TranscriptRecorder(history, null, onError)
    recorder.record(utterance)
    recorder.finish()
    expect(onError).toHaveBeenCalled()
    const text = transcriptText(recorder.session)
    expect(text).toContain('Hello\nXin chào')
    expect(text).toContain('(partial)')
  })
})
