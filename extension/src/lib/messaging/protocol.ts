import type { Settings } from '../settings/schema';
import type {
  CaptionInfo,
  Cue,
  LiveLine,
  Mode,
  Notice,
  SessionView,
  SettingsView,
  TranslatedCue,
  VideoInfo,
} from '../../types';

export type { SettingsView } from '../../types';

export interface YtCaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  message: string;
}

export interface LocalTestResult {
  ollama?: { ok: boolean; message: string };
  whisper?: { ok: boolean; message: string };
}

export interface StartResult {
  ok: boolean;
  error?: string;
}

/** Content script -> service worker. */
export type ContentToBackground =
  | { type: 'content.ready'; video: VideoInfo; captions: CaptionInfo }
  | { type: 'content.video'; video: VideoInfo }
  | { type: 'content.captionSource'; captions: CaptionInfo }
  | { type: 'content.cues'; cues: Cue[]; source: CaptionInfo['source'] }
  | {
      type: 'content.time';
      currentTime: number;
      paused: boolean;
      rate: number;
      generation: number;
    }
  | { type: 'content.seek'; generation: number }
  | { type: 'content.notice'; notice: Notice }
  | { type: 'yt.tracks.request' };

/** Popup / options -> service worker. */
export type UiToBackground =
  | { type: 'session.start'; tabId: number; streamId: string; mode: Mode }
  | { type: 'session.prepare' }
  | { type: 'session.stop'; tabId?: number }
  | { type: 'session.status' }
  | { type: 'settings.get' }
  | { type: 'settings.update'; settings: Settings; secrets?: Record<string, string> }
  | { type: 'settings.reset' }
  | { type: 'provider.test'; providerId: string; direction: 'translation' | 'asr' }
  | { type: 'local.test' }
  | { type: 'cache.clear' }
  | { type: 'logs.get' };

export type RuntimeMessage = ContentToBackground | UiToBackground;

/** Service worker -> content script. */
export type BackgroundToContent =
  | { type: 'session.started'; sessionId: string; settings: Settings; mode: Mode }
  | { type: 'session.stopped' }
  | { type: 'overlay.activate'; settings: Settings }
  | { type: 'overlay.deactivate' }
  | { type: 'subtitles.upsert'; cues: TranslatedCue[] }
  | { type: 'subtitles.live'; lines: LiveLine[] }
  | { type: 'subtitles.clear' }
  | { type: 'notice'; notice: Notice }
  | { type: 'settings.updated'; settings: Settings };

export type MessageResponse = StartResult | SettingsView | SessionView | unknown;

export function sendRuntime<T = unknown>(message: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

export function sendToTab<T = unknown>(
  tabId: number,
  message: BackgroundToContent,
  frameId?: number,
): Promise<T> {
  if (frameId === undefined) {
    return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
  }
  return chrome.tabs.sendMessage(tabId, message, { frameId }) as Promise<T>;
}

/* ------------------------------------------------------------------ */
/* Offscreen <-> service worker port                                   */
/* ------------------------------------------------------------------ */

export interface VadConfig {
  frameMs: number;
  startFrames: number;
  silenceMs: number;
  minSpeechMs: number;
  maxSegmentMs: number;
  preRollMs: number;
  postRollMs: number;
}

export const DEFAULT_VAD: VadConfig = {
  frameMs: 20,
  startFrames: 3,
  silenceMs: 600,
  minSpeechMs: 400,
  maxSegmentMs: 8000,
  preRollMs: 200,
  postRollMs: 300,
};

export type OffscreenCommand =
  | {
      type: 'capture.start';
      tabId: number;
      streamId: string;
      generation: number;
      vad: VadConfig;
    }
  | { type: 'capture.stop' }
  | { type: 'capture.generation'; generation: number }
  | { type: 'ping' };

export type OffscreenEvent =
  | { type: 'ready' }
  | { type: 'capture.started'; tabId: number }
  | { type: 'capture.error'; tabId: number; code: string; message: string }
  | { type: 'capture.ended'; tabId: number }
  | {
      type: 'audio.segment';
      tabId: number;
      seq: number;
      wavBase64: string;
      t0: number;
      t1: number;
      rms: number;
      generation: number;
    }
  | { type: 'audio.level'; tabId: number; rms: number }
  | { type: 'ping' }
  | { type: 'pong' };
