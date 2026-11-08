import type { ProviderConfig, Settings } from '../settings/schema';
import type { Secrets } from '../settings/store';
import { secretFor } from '../settings/store';
import { LocalWhisperProvider } from './local-whisper';
import { MockAsrProvider, MockChatProvider } from './mock';
import { OllamaNativeProvider } from './ollama-native';
import { OpenAIChatProvider } from './openai-chat';
import { OpenAIAsrProvider } from './openai-asr';
import type { AsrProvider, ChatProvider } from './types';

export interface ProviderBuild<T> {
  provider: T;
  config: ProviderConfig;
  skippedReason?: string;
}

export interface BuiltProviders {
  translation: ProviderBuild<ChatProvider>[];
  asr: ProviderBuild<AsrProvider>[];
}

function cloneConfig(p: ProviderConfig): ProviderConfig {
  return { ...p, headers: p.headers ? { ...p.headers } : undefined };
}

export function buildProviders(settings: Settings, secrets: Secrets): BuiltProviders {
  const translation: ProviderBuild<ChatProvider>[] = [];
  for (const raw of settings.providers.translation) {
    const cfg = cloneConfig(raw);
    const key = secretFor(cfg, secrets);
    let skippedReason: string | undefined;
    if (!cfg.enabled) skippedReason = '已禁用';
    else if (cfg.apiKeyStorageKey && !key) skippedReason = '缺少 API Key';

    let provider: ChatProvider | null = null;
    if (cfg.kind === 'openai-chat') {
      provider = new OpenAIChatProvider(cfg, key);
    } else if (cfg.kind === 'ollama-native') {
      const localCfg: ProviderConfig = {
        ...cfg,
        baseUrl: settings.local.ollamaBaseUrl,
        model: settings.local.ollamaModel,
        extraBody: {
          num_thread: settings.local.threads,
          ...(cfg.extraBody ?? {}),
        },
      };
      provider = new OllamaNativeProvider(localCfg);
    } else if (cfg.kind === 'mock') {
      provider = new MockChatProvider(cfg);
    }

    if (provider) translation.push({ provider, config: cfg, skippedReason });
  }

  const asr: ProviderBuild<AsrProvider>[] = [];
  for (const raw of settings.providers.asr) {
    const cfg = cloneConfig(raw);
    const key = secretFor(cfg, secrets);
    let skippedReason: string | undefined;
    if (!cfg.enabled) skippedReason = '已禁用';
    else if (cfg.apiKeyStorageKey && !key) skippedReason = '缺少 API Key';

    let provider: AsrProvider | null = null;
    if (cfg.kind === 'openai-asr') {
      provider = new OpenAIAsrProvider(cfg, key);
    } else if (cfg.kind === 'local-whisper') {
      const localCfg: ProviderConfig = {
        ...cfg,
        baseUrl: `${settings.local.whisperBaseUrl.replace(/\/+$/, '')}/v1`,
        model: settings.local.whisperModel,
      };
      provider = new LocalWhisperProvider(localCfg);
    } else if (cfg.kind === 'mock') {
      provider = new MockAsrProvider(cfg);
    }

    if (provider) asr.push({ provider, config: cfg, skippedReason });
  }

  return { translation, asr };
}

export function findProvider(settings: Settings, id: string): ProviderConfig | undefined {
  return [...settings.providers.translation, ...settings.providers.asr].find((p) => p.id === id);
}
