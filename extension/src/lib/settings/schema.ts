import type { Layout, Mode } from '../../types';

export type ProviderKind = 'openai-chat' | 'ollama-native' | 'openai-asr' | 'local-whisper' | 'mock';

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  /** Name of the secret in chrome.storage.local `secrets`. */
  apiKeyStorageKey?: string;
  /** Static headers; `{{sessionId}}` is replaced per video session. */
  headers?: Record<string, string>;
  supportsTemperature?: boolean;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  extraBody?: Record<string, unknown>;
  enabled: boolean;
}

export interface Settings {
  version: 1;
  pipeline: {
    mode: Mode;
    targetLang: 'zh-CN';
    sourceLang: 'auto' | string;
    prefetchAheadSec: number;
    maxConcurrent: number;
    glossary: string;
  };
  output: {
    layout: Layout;
    fontScale: number;
    position: 'bottom' | 'top';
    opacity: number;
    hideNative: boolean;
  };
  providers: {
    translation: ProviderConfig[];
    asr: ProviderConfig[];
    timeoutMs: number;
    maxTokensPerHour: number;
  };
  contentPolicy: {
    mode: 'faithful' | 'soften';
    localFirst: boolean;
    switchToLocalAfter: number;
    showOriginalOnFail: boolean;
  };
  local: {
    ollamaBaseUrl: string;
    ollamaModel: string;
    whisperBaseUrl: string;
    whisperModel: string;
    threads: number;
  };
  privacy: {
    consentAccepted: boolean;
    sendAudioToCloud: boolean;
    debugText: boolean;
  };
  cache: {
    enabled: boolean;
    ttlDays: number;
    maxEntries: number;
  };
  ui: {
    showStatus: boolean;
  };
}
