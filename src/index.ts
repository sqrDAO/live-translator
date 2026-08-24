/**
 * `@sqrdao/live-translate` — the browser engine.
 *
 * Construct a `LiveTranslateEngine` with a `LanguagePack`, a `CaptionSink`
 * and a `mintToken`; call `unlockAudioSync()` inside the user's tap and then
 * `start()`. See README.md for the host contract.
 */

export {
  LiveTranslateEngine,
  HEARTBEAT_INTERVAL_MS,
  IDLE_FINALIZE_MS,
  IDLE_POLL_INTERVAL_MS,
  MAX_UTTERANCE_MS,
  MAX_UTTERANCE_SENTENCES,
  PARTIAL_SEGMENT_INTERVAL_MS,
  SPEECH_RUN_GAP_MS,
  STATE_WRITE_INTERVAL_MS,
  type EngineOptions,
  type EngineStartOptions,
  type LatencyReport,
  type MicrophoneOptions,
} from './engine'

export {
  PublicationMovedError,
  isPublicationMoved,
  type CaptionSink,
  type FeedDeathReason,
  type FeedStatus,
  type MintToken,
  type PublishableUtterance,
  type TokenGrant,
} from './sink'

export {
  assertLanguagePair,
  otherOf,
  type LangTag,
  type LanguageDetector,
  type LanguageNames,
  type LanguagePack,
  type LanguagePair,
} from './lang/types'

export {
  AudioCapture,
  DEFAULT_DEVICE_STORAGE_KEY,
  stopSupersededCapture,
  type CaptureDiagnostics,
  type CaptureOptions,
} from './audio/capture'
export {
  CHUNK_MS,
  ChunkAccumulator,
  SAMPLES_PER_CHUNK,
  StreamingResampler,
  TARGET_SAMPLE_RATE,
  VAD_DEFAULTS,
  VoiceActivityDetector,
  floatToPcm16,
  pcm16ToBase64,
} from './audio/pcm'
export { WORKLET_NAME, WORKLET_SOURCE } from './audio/worklet'

export {
  TURN_SILENCE_MS,
  assertModelConfigured,
  buildLiveSessionConfig,
  buildTokenConstraints,
  type LiveSessionConfigInput,
  type LiveSessionContext,
} from './gemini/config'
export { parseLiveMessage, type ParsedLiveMessage } from './gemini/frames'

export {
  LIVE_ENDPOINT,
  LiveSessionManager,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  type LiveSessionManagerOptions,
  type SocketCloseInfo,
} from './session/live-session'

export {
  TargetTurnCoordinator,
  type TargetTurnCoordinatorOptions,
  type TurnMessage,
  type TurnPublication,
} from './transcript/coordinator'
export { LatencyTracker, type LatencySnapshot } from './transcript/latency'
export {
  UtteranceMerger,
  countSentences,
  inferSourceLanguage,
  type IncomingFragment,
  type MergedUtterance,
  type UtteranceMergerOptions,
} from './transcript/merge'
export { PublicationOutbox, type PublicationOutboxOptions } from './transcript/outbox'
export { WriteThrottle, type ThrottleOptions } from './transcript/throttle'
