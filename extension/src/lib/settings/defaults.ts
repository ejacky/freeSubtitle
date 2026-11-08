import type { ProviderConfig, Settings } from './schema';

const opencodeHeaders = { 'x-opencode-session': '{{sessionId}}' };

export const DEFAULT_TRANSLATION_PROVIDERS: ProviderConfig[] = [
  {
    id: 'opencode-deepseek',
    kind: 'openai-chat',
    label: 'OpenCode Go · DeepSeek V4.1 Flash',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'deepseek-v4.1-flash',
    apiKeyStorageKey: 'opencode-go',
    headers: opencodeHeaders,
    supportsTemperature: true,
    reasoningEffort: 'low',
    enabled: true,
  },
  {
    id: 'opencode-gpt6',
    kind: 'openai-chat',
    label: 'OpenCode Go · GPT-6 Luna',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'gpt-6-luna',
    apiKeyStorageKey: 'opencode-go',
    headers: opencodeHeaders,
    supportsTemperature: false,
    reasoningEffort: 'none',
    enabled: true,
  },
  {
    id: 'opencode-glm',
    kind: 'openai-chat',
    label: 'OpenCode Go · GLM-5.3 Flash',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'glm-5.3-flash',
    apiKeyStorageKey: 'opencode-go',
    headers: opencodeHeaders,
    supportsTemperature: true,
    reasoningEffort: 'low',
    enabled: true,
  },
  {
    id: 'ollama-qwen',
    kind: 'ollama-native',
    label: '本地 Ollama · Qwen2.5 3B',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:3b-instruct',
    supportsTemperature: true,
    enabled: true,
  },
];

export const DEFAULT_ASR_PROVIDERS: ProviderConfig[] = [
  {
    id: 'groq-whisper',
    kind: 'openai-asr',
    label: 'Groq · Whisper Large v3 Turbo',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    apiKeyStorageKey: 'groq',
    enabled: true,
  },
  {
    id: 'openai-whisper',
    kind: 'openai-asr',
    label: 'OpenAI · Whisper',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    apiKeyStorageKey: 'openai',
    enabled: true,
  },
  {
    id: 'local-whisper',
    kind: 'local-whisper',
    label: '本地 whisper.cpp',
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'base',
    enabled: true,
  },
];

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  pipeline: {
    mode: 'auto',
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    prefetchAheadSec: 120,
    maxConcurrent: 2,
    glossary: '',
  },
  output: {
    layout: 'bilingual',
    fontScale: 1,
    position: 'bottom',
    opacity: 0.56,
    hideNative: true,
  },
  providers: {
    translation: DEFAULT_TRANSLATION_PROVIDERS,
    asr: DEFAULT_ASR_PROVIDERS,
    timeoutMs: 30000,
    maxTokensPerHour: 50000,
  },
  contentPolicy: {
    mode: 'faithful',
    localFirst: false,
    switchToLocalAfter: 3,
    showOriginalOnFail: true,
  },
  local: {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen2.5:3b-instruct',
    whisperBaseUrl: 'http://127.0.0.1:8787',
    whisperModel: 'base',
    threads: 4,
  },
  privacy: {
    consentAccepted: false,
    sendAudioToCloud: true,
    debugText: false,
  },
  cache: {
    enabled: true,
    ttlDays: 30,
    maxEntries: 20000,
  },
  ui: {
    showStatus: true,
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deep-merge a stored object over defaults, preserving array order from storage. */
export function mergeSettings(stored: unknown): Settings {
  const base = clone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== 'object') return base;
  const s = stored as Partial<Settings>;

  const merged: Settings = {
    ...base,
    ...s,
    pipeline: { ...base.pipeline, ...(s.pipeline ?? {}) },
    output: { ...base.output, ...(s.output ?? {}) },
    providers: {
      translation:
        Array.isArray(s.providers?.translation) && s.providers.translation.length > 0
          ? s.providers.translation
          : base.providers.translation,
      asr:
        Array.isArray(s.providers?.asr) && s.providers.asr.length > 0
          ? s.providers.asr
          : base.providers.asr,
      timeoutMs: s.providers?.timeoutMs ?? base.providers.timeoutMs,
      maxTokensPerHour: s.providers?.maxTokensPerHour ?? base.providers.maxTokensPerHour,
    },
    contentPolicy: { ...base.contentPolicy, ...(s.contentPolicy ?? {}) },
    local: { ...base.local, ...(s.local ?? {}) },
    privacy: { ...base.privacy, ...(s.privacy ?? {}) },
    cache: { ...base.cache, ...(s.cache ?? {}) },
    ui: { ...base.ui, ...(s.ui ?? {}) },
    version: 1,
  };

  // Keep local endpoints in sync with the dedicated local settings block.
  merged.providers.translation = merged.providers.translation.map((p) =>
    p.kind === 'ollama-native'
      ? {
          ...p,
          baseUrl: merged.local.ollamaBaseUrl,
          model: merged.local.ollamaModel,
        }
      : p,
  );
  merged.providers.asr = merged.providers.asr.map((p) =>
    p.kind === 'local-whisper'
      ? {
          ...p,
          baseUrl: `${merged.local.whisperBaseUrl.replace(/\/+$/, '')}/v1`,
          model: merged.local.whisperModel,
        }
      : p,
  );

  return merged;
}
