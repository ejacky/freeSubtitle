export type Mode = 'auto' | 'captions' | 'audio';
export type Layout = 'bilingual' | 'zh' | 'source';
export type SessionState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'stopping'
  | 'error';

export interface Cue {
  /** Stable within one caption track: start-end-hash(text). */
  id: string;
  start: number;
  end: number;
  text: string;
  lang?: string;
}

export interface TranslatedCue {
  id: string;
  zh: string;
  status: 'ok' | 'failed' | 'source';
  provider?: string;
}

export interface VideoInfo {
  area: number;
  width: number;
  height: number;
  paused: boolean;
  currentTime: number;
  duration: number;
  title?: string;
  src?: string;
  drm: boolean;
}

export interface CaptionInfo {
  source: 'youtube' | 'track' | 'dom' | 'none';
  language?: string;
  ready: boolean;
}

export interface LiveLine {
  id: string;
  source: string;
  zh: string;
  t0: number;
  t1: number;
  status: 'ok' | 'pending' | 'failed' | 'source';
}

export interface SessionStats {
  startedAt: number;
  translatedCues: number;
  asrSegments: number;
  policyFallbacks: number;
  inputTokens: number;
  outputTokens: number;
  lastLatencyMs: number;
}

export interface ProviderRuntimeStatus {
  id: string;
  label: string;
  kind: string;
  ok: boolean | null;
  cooldownUntil?: number;
  lastError?: string;
  skippedReason?: string;
}

export interface SessionView {
  active: boolean;
  tabId?: number;
  state: SessionState;
  mode?: Mode;
  captionSource?: CaptionInfo['source'];
  detail?: string;
  stats?: SessionStats;
  providers: ProviderRuntimeStatus[];
  audioLevel?: number;
  startedAt?: number;
}

export interface Notice {
  level: 'info' | 'warn' | 'error';
  code: string;
  message: string;
}

export interface SettingsView {
  settings: import('./lib/settings/schema').Settings;
  secrets: Record<string, boolean>;
  session: SessionView;
  version: string;
}
