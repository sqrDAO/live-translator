/**
 * An in-memory `CaptionSink`. No cloud service of any kind — the proof the
 * engine carries no store with it.
 *
 * A real host implements the same interface against wherever its utterances
 * belong (a database, a socket to a display wall, a file), and adds its own
 * answers to authority: `authorityValid()` and `adoptRenewal()` are where a
 * lease, a token lifetime or a permission would be consulted. This example
 * has no authority to lose, so it always answers yes.
 */

import type {
  CaptionSink,
  FeedStatus,
  PublishableUtterance,
} from '@sqrdao/live-translate'

export interface StoredUtterance extends PublishableUtterance {
  final: boolean
}

export interface MemorySinkObserver {
  onUtterance?: (utterance: StoredUtterance) => void
  onRetract?: (utteranceId: string) => void
  onStatus?: (status: FeedStatus) => void
}

export class MemorySink implements CaptionSink {
  /** The current rolling set, newest last, keyed by utterance id. */
  readonly utterances = new Map<string, StoredUtterance>()
  status: FeedStatus = 'idle'

  constructor(private readonly observer: MemorySinkObserver = {}) {}

  async prepare(): Promise<void> {
    // A fresh publication starts from an empty surface.
    this.utterances.clear()
  }

  async publish(utterance: PublishableUtterance, final: boolean): Promise<boolean> {
    const stored: StoredUtterance = { ...utterance, final }
    this.utterances.set(utterance.utteranceId, stored)
    this.observer.onUtterance?.(stored)
    // No store to refuse us: the write always lands.
    return true
  }

  async retract(utteranceId: string): Promise<void> {
    this.utterances.delete(utteranceId)
    this.observer.onRetract?.(utteranceId)
  }

  async publishStatus(status: FeedStatus): Promise<void> {
    this.status = status
    this.observer.onStatus?.(status)
  }

  authorityValid(): boolean {
    return true
  }

  adoptRenewal(): 'renewed' | 'moved' {
    // This host has no notion of another publisher taking the room, so every
    // renewal is the same authority. A host with a lease compares ids here.
    return 'renewed'
  }
}
