import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/lib/settings/defaults';

describe('mergeSettings', () => {
  it('fills missing fields and keeps custom providers', () => {
    const merged = mergeSettings({
      pipeline: { mode: 'audio' },
      providers: {
        translation: [
          {
            id: 'custom',
            kind: 'openai-chat',
            label: 'Custom',
            baseUrl: 'https://example.test/v1',
            model: 'x',
            enabled: true,
          },
        ],
      },
    });
    expect(merged.pipeline.mode).toBe('audio');
    expect(merged.pipeline.prefetchAheadSec).toBe(DEFAULT_SETTINGS.pipeline.prefetchAheadSec);
    expect(merged.providers.translation).toHaveLength(1);
    expect(merged.providers.translation[0]?.id).toBe('custom');
    expect(merged.providers.asr.length).toBeGreaterThan(0);
  });

  it('syncs local endpoints into provider configs', () => {
    const merged = mergeSettings({
      local: {
        ollamaBaseUrl: 'http://127.0.0.1:9999',
        whisperBaseUrl: 'http://127.0.0.1:7777',
      },
    });
    const ollama = merged.providers.translation.find((p) => p.kind === 'ollama-native');
    const whisper = merged.providers.asr.find((p) => p.kind === 'local-whisper');
    expect(ollama?.baseUrl).toBe('http://127.0.0.1:9999');
    expect(whisper?.baseUrl).toBe('http://127.0.0.1:7777/v1');
  });
});
