import { buildProviders } from '../lib/providers/registry';
import { collectChat } from '../lib/providers/types';
import type { ProviderConfig, Settings } from '../lib/settings/schema';
import type { Secrets } from '../lib/settings/store';
import { buildTestMessages } from '../lib/translate/prompt';
import { encodeWav } from '../offscreen/wav';
import type { LocalTestResult, ProviderTestResult } from '../lib/messaging/protocol';

function find(settings: Settings, id: string): ProviderConfig | undefined {
  return [...settings.providers.translation, ...settings.providers.asr].find((p) => p.id === id);
}

export async function testProvider(
  settings: Settings,
  secrets: Secrets,
  id: string,
  direction: 'translation' | 'asr',
): Promise<ProviderTestResult> {
  const config = find(settings, id);
  if (!config) return { ok: false, message: '找不到该服务' };

  if (direction === 'asr') {
    if (config.kind === 'local-whisper') {
      const res = await testLocalWhisper(settings.local.whisperBaseUrl);
      return res;
    }
    if (config.apiKeyStorageKey && !secrets[config.apiKeyStorageKey]) {
      return { ok: false, message: '缺少 API Key' };
    }
    const built = buildProviders(settings, secrets).asr.find(
      (b) => b.config.id === id,
    );
    if (!built) return { ok: false, message: '该 ASR 服务不可用' };
    if (built.skippedReason) return { ok: false, message: built.skippedReason };
    const started = Date.now();
    try {
      // 1 second of a quiet tone is enough to validate auth, host permission,
      // endpoint and model without uploading user audio.
      const samples = new Float32Array(16000);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.05;
      }
      const result = await built.provider.transcribe({
        wav: encodeWav(samples),
        signal: AbortSignal.timeout(30000),
      });
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: `ASR 连通${result.text ? `：${result.text.slice(0, 60)}` : '（测试音频无语音）'}`,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: String(err instanceof Error ? err.message : err).slice(0, 240),
      };
    }
  }

  const built = buildProviders(settings, secrets).translation.find(
    (b) => b.config.id === id,
  );
  if (!built) return { ok: false, message: '该服务不可用' };
  if (built.skippedReason) return { ok: false, message: built.skippedReason };

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const { text } = await collectChat(built.provider, {
        messages: buildTestMessages(),
        maxTokens: 800,
        temperature: 0.1,
        sessionId: 'provider-test',
        signal: controller.signal,
      });
      return {
        ok: Boolean(text.trim()),
        latencyMs: Date.now() - started,
        message: text.trim().slice(0, 120) || '返回为空',
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: String(err instanceof Error ? err.message : err).slice(0, 240),
    };
  }
}

export async function testLocalServices(settings: Settings): Promise<LocalTestResult> {
  const [ollama, whisper] = await Promise.all([
    testOllama(settings.local.ollamaBaseUrl, settings.local.ollamaModel),
    testLocalWhisper(settings.local.whisperBaseUrl),
  ]);
  return { ollama, whisper };
}

async function testOllama(
  baseUrl: string,
  model: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, message: `Ollama 返回 ${res.status}` };
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (json.models ?? []).map((m) => m.name ?? '');
    if (names.length === 0) return { ok: false, message: 'Ollama 已启动，但没有模型' };
    if (model && !names.some((name) => name === model || name.startsWith(`${model}:`))) {
      return {
        ok: false,
        message: `已连接，但缺少 ${model}；可执行 ollama pull ${model}`,
      };
    }
    return { ok: true, message: `Ollama 正常（${model}）` };
  } catch (err) {
    return {
      ok: false,
      message: `无法连接 Ollama：${String(err instanceof Error ? err.message : err)}`,
    };
  }
}

async function testLocalWhisper(baseUrl: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, message: `本地 ASR 返回 ${res.status}` };
    const json = (await res.json()) as { ok?: boolean; model?: string; ready?: boolean };
    if (!json.ok) return { ok: false, message: '本地 ASR 未就绪' };
    return { ok: true, message: `本地 ASR 正常（${json.model ?? 'unknown'}）` };
  } catch (err) {
    return {
      ok: false,
      message: `无法连接本地 ASR：${String(err instanceof Error ? err.message : err)}。请运行 local-asr/server.mjs`,
    };
  }
}
