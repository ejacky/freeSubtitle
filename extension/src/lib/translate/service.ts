import type { Cue } from '../../types';
import { sleep } from '../retry';
import type { ProviderBuild } from '../providers/registry';
import { buildProviders } from '../providers/registry';
import type {
  AsrProvider,
  ChatMessage,
  ChatProvider,
  ChatUsage,
} from '../providers/types';
import { collectChat, isRetryable, ProviderError as PE } from '../providers/types';
import type { ProviderConfig, Settings } from '../settings/schema';
import type { Secrets } from '../settings/store';
import { stripThinkBlocks } from '../text';
import { log } from '../log';
import { getCached, makeCacheKey, putCached } from './cache';
import { ProviderHealthStore } from './health';
import { parseTranslations } from './parse';
import { buildMessages, buildSingleMessages, PROMPT_VERSION } from './prompt';
import { isRefusal, looksLikeRefusalText } from './refusal';
import { validateBatch } from './validate';

export interface TranslatedResult {
  zh: string;
  provider?: string;
  status: 'ok' | 'failed' | 'source';
}

export interface AsrTranscription {
  text: string;
  language?: string;
  provider: string;
}

export interface TranslationUsage {
  inputTokens: number;
  outputTokens: number;
  lastLatencyMs: number;
}

class BatchFailure extends Error {
  constructor(
    readonly policy: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'BatchFailure';
  }
}

export interface TranslationServiceOptions {
  onLocalFallback?: () => void;
}

/**
 * Per-video translation/ASR service. It owns the provider chain, circuit
 * breakers, cache, and the "switch to local after repeated refusals" policy.
 */
export class TranslationService {
  private built;
  private health = new ProviderHealthStore();
  private sessionAbort = new AbortController();
  private policyFailures = 0;
  private autoLocalFirst = false;
  private localFallbackNotified = false;
  private blocked = new Set<string>(); // `${cueId}|${providerId}`
  private usage: TranslationUsage = { inputTokens: 0, outputTokens: 0, lastLatencyMs: 0 };

  constructor(
    private settings: Settings,
    private secrets: Secrets,
    private readonly sessionId: string,
    private readonly options: TranslationServiceOptions = {},
  ) {
    this.built = buildProviders(settings, secrets);
  }

  updateSettings(settings: Settings, secrets: Secrets): void {
    this.settings = settings;
    this.secrets = secrets;
    this.built = buildProviders(settings, secrets);
  }

  stop(): void {
    this.sessionAbort.abort();
  }

  getUsage(): TranslationUsage {
    return { ...this.usage };
  }

  getPolicyFailures(): number {
    return this.policyFailures;
  }

  consumeLocalFallbackNotice(): boolean {
    if (!this.localFallbackNotified) return false;
    this.localFallbackNotified = false;
    return true;
  }

  getProviderStatuses(): Array<{
    id: string;
    label: string;
    kind: string;
    ok: boolean | null;
    cooldownUntil?: number;
    lastError?: string;
    skippedReason?: string;
  }> {
    const all: ProviderBuild<ChatProvider | AsrProvider>[] = [
      ...this.built.translation,
      ...this.built.asr,
    ];
    return all.map((b) => {
      const snap = this.health.snapshot(b.config.id);
      return {
        id: b.config.id,
        label: b.config.label,
        kind: b.config.kind,
        ok: b.skippedReason ? false : snap.ok,
        cooldownUntil: snap.cooldownUntil,
        lastError: b.skippedReason ?? snap.lastError,
        skippedReason: b.skippedReason,
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Translation                                                        */
  /* ------------------------------------------------------------------ */

  async translateCues(
    cues: Cue[],
    context: string[],
  ): Promise<Map<string, TranslatedResult>> {
    const result = new Map<string, TranslatedResult>();
    if (cues.length === 0) return result;

    const missing: Cue[] = [];
    for (const cue of cues) {
      const cached = await this.cached(cue.text, context);
      if (cached) {
        result.set(cue.id, { zh: cached.zh, provider: cached.provider, status: 'ok' });
      } else {
        missing.push(cue);
      }
    }
    if (missing.length === 0) return result;

    const batch = await this.tryBatch(missing, context);
    if (batch) {
      for (const cue of missing) {
        const hit = batch.get(cue.id);
        if (hit) result.set(cue.id, hit);
      }
    }

    const stillMissing = missing.filter((cue) => !result.has(cue.id));
    if (stillMissing.length > 0) {
      for (const cue of stillMissing) {
        const single = await this.translateOne(cue, context);
        result.set(
          cue.id,
          single ?? {
            zh: '',
            status: 'failed',
          },
        );
      }
    }

    return result;
  }

  async translateText(text: string, context: string[]): Promise<TranslatedResult> {
    const cached = await this.cached(text, context);
    if (cached) return { zh: cached.zh, provider: cached.provider, status: 'ok' };

    // Live segments must have unique ids; otherwise one policy refusal would
    // put the provider in the per-cue blocked set for every future live line.
    const id = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const one = await this.translateOne({ id, start: 0, end: 0, text }, context);
    return one ?? { zh: '', status: 'failed' };
  }

  private async tryBatch(
    cues: Cue[],
    context: string[],
  ): Promise<Map<string, TranslatedResult> | null> {
    const chain = this.orderedChat();
    if (chain.length === 0) return null;

    for (const build of chain) {
      try {
        const map = await this.attemptBatch(build, cues, context);
        if (map) return map;
      } catch (err) {
        this.noteFailure(build.config, err, cues);
        if (err instanceof PE && err.kind === 'aborted') return null;
      }
    }
    return null;
  }

  private async attemptBatch(
    build: ProviderBuild<ChatProvider>,
    cues: Cue[],
    context: string[],
  ): Promise<Map<string, TranslatedResult>> {
    const { messages } = buildMessages({
      lines: cues.map((cue) => ({ id: cue.id, text: cue.text })),
      context,
      glossary: this.settings.pipeline.glossary,
    });
    const startedAt = Date.now();
    const { text, usage } = await this.callChat(
      build,
      messages,
      Math.min(6000, 512 + cues.length * 200),
    );
    this.addUsage(usage, Date.now() - startedAt);

    const parsed = parseTranslations(stripThinkBlocks(text));
    const sources = cues.map((cue) => cue.text);
    const validation = validateBatch(sources, parsed, this.settings.pipeline.targetLang);
    const refused = isRefusal(text, parsed, cues.length, sources.join('\n'));

    if (refused) {
      throw new BatchFailure(true, '模型拒绝翻译');
    }
    if (!validation.ok) {
      throw new BatchFailure(false, validation.reasons.join('；') || '译文校验失败');
    }

    const map = new Map<string, TranslatedResult>();
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i]!;
      const zh = validation.translations[i]!;
      map.set(cue.id, { zh, provider: build.config.id, status: 'ok' });
      await this.store(cue.text, context, zh, build.config.id);
    }
    this.health.recordSuccess(build.config.id);
    return map;
  }

  private async translateOne(cue: Cue, context: string[]): Promise<TranslatedResult | null> {
    const cached = await this.cached(cue.text, context);
    if (cached) return { zh: cached.zh, provider: cached.provider, status: 'ok' };

    for (const build of this.orderedChat()) {
      const blockKey = `${cue.id}|${build.config.id}`;
      if (this.blocked.has(blockKey)) continue;

      try {
        const { messages } = buildSingleMessages(cue.text, context);
        const startedAt = Date.now();
        const { text, usage } = await this.callChat(build, messages, 1200);
        this.addUsage(usage, Date.now() - startedAt);
        const parsed = parseTranslations(stripThinkBlocks(text));
        const validation = validateBatch(
          [cue.text],
          parsed,
          this.settings.pipeline.targetLang,
        );
        if (isRefusal(text, parsed, 1, cue.text)) {
          throw new BatchFailure(true, '模型拒绝翻译');
        }
        if (!validation.ok || !validation.translations[0]) {
          throw new BatchFailure(false, validation.reasons.join('；') || '译文校验失败');
        }
        const zh = validation.translations[0]!;
        await this.store(cue.text, context, zh, build.config.id);
        this.health.recordSuccess(build.config.id);
        return { zh, provider: build.config.id, status: 'ok' };
      } catch (err) {
        this.noteFailure(build.config, err, [cue]);
        if (err instanceof PE && err.kind === 'aborted') return null;
      }
    }
    return null;
  }

  private orderedChat(): ProviderBuild<ChatProvider>[] {
    const available = this.built.translation.filter(
      (b) => !b.skippedReason && this.health.isAvailable(b.config.id),
    );
    if (!this.localFirst()) return available;
    return [...available].sort(
      (a, b) => Number(isLocal(b.config)) - Number(isLocal(a.config)),
    );
  }

  private localFirst(): boolean {
    return this.autoLocalFirst || this.settings.contentPolicy.localFirst;
  }

  private noteFailure(config: ProviderConfig, err: unknown, cues: Cue[]): void {
    log('warn', 'provider.failure', {
      id: config.id,
      kind: err instanceof PE ? err.kind : err instanceof BatchFailure ? 'batch' : 'unknown',
      message: String(err instanceof Error ? err.message : err).slice(0, 240),
    });
    if (err instanceof PE) {
      this.health.recordFailure(config.id, err.kind, err.message, err.retryAfterMs);
      if (err.kind === 'aborted') return;
      return;
    }
    if (err instanceof BatchFailure) {
      if (err.policy) {
        this.health.recordFailure(config.id, 'policy', err.message);
        this.policyFailures++;
        for (const cue of cues) this.blocked.add(`${cue.id}|${config.id}`);
        const threshold = Math.max(1, this.settings.contentPolicy.switchToLocalAfter);
        if (
          !this.autoLocalFirst &&
          this.policyFailures >= threshold &&
          this.built.translation.some((b) => isLocal(b.config) && !b.skippedReason)
        ) {
          this.autoLocalFirst = true;
          if (!this.localFallbackNotified) {
            this.localFallbackNotified = true;
            this.options.onLocalFallback?.();
          }
        }
      } else {
        this.health.recordFailure(config.id, 'invalid', err.message);
      }
      return;
    }
    this.health.recordFailure(config.id, 'transient', String(err));
  }

  private async callChat(
    build: ProviderBuild<ChatProvider>,
    messages: ChatMessage[],
    maxTokens: number,
  ): Promise<{ text: string; usage?: ChatUsage }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.settings.providers.timeoutMs,
      );
      const onSessionAbort = () => controller.abort();
      this.sessionAbort.signal.addEventListener('abort', onSessionAbort, { once: true });
      try {
        const result = await collectChat(build.provider, {
          messages,
          maxTokens,
          sessionId: this.sessionId,
          signal: controller.signal,
        });
        this.health.recordSuccess(build.config.id);
        return result;
      } catch (err) {
        lastError = err;
        if (err instanceof PE && (err.kind === 'aborted' || !isRetryable(err))) throw err;
        if (attempt === 0) {
          await sleep(400 + Math.floor(Math.random() * 200), this.sessionAbort.signal).catch(
            () => undefined,
          );
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timeout);
        this.sessionAbort.signal.removeEventListener('abort', onSessionAbort);
      }
    }
    throw lastError;
  }

  /* ------------------------------------------------------------------ */
  /* ASR                                                                */
  /* ------------------------------------------------------------------ */

  async transcribe(
    wav: ArrayBuffer,
    opts: { language?: string; prompt?: string },
  ): Promise<AsrTranscription | null> {
    const chain = this.built.asr.filter((b) => !b.skippedReason && this.health.isAvailable(b.config.id));
    for (const build of chain) {
      if (!this.settings.privacy.sendAudioToCloud && isCloudAsr(build.config)) continue;
      try {
        const startedAt = Date.now();
        const result = await this.callAsr(build, wav, opts);
        this.health.recordSuccess(build.config.id);
        this.usage.lastLatencyMs = Date.now() - startedAt;
        if (result.text.trim()) {
          return { text: result.text.trim(), language: result.language, provider: build.config.id };
        }
      } catch (err) {
        log('warn', 'asr.failure', {
          id: build.config.id,
          message: String(err instanceof Error ? err.message : err).slice(0, 240),
        });
        if (err instanceof PE) {
          this.health.recordFailure(build.config.id, err.kind, err.message, err.retryAfterMs);
          if (err.kind === 'aborted') return null;
        } else {
          this.health.recordFailure(build.config.id, 'transient', String(err));
        }
      }
    }
    return null;
  }

  private async callAsr(
    build: ProviderBuild<AsrProvider>,
    wav: ArrayBuffer,
    opts: { language?: string; prompt?: string },
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(60_000, this.settings.providers.timeoutMs));
      const onSessionAbort = () => controller.abort();
      this.sessionAbort.signal.addEventListener('abort', onSessionAbort, { once: true });
      try {
        return await build.provider.transcribe({
          wav,
          language: opts.language,
          prompt: opts.prompt,
          signal: controller.signal,
        });
      } catch (err) {
        lastError = err;
        if (err instanceof PE && (err.kind === 'aborted' || !isRetryable(err))) throw err;
        if (attempt === 0) {
          await sleep(500, this.sessionAbort.signal).catch(() => undefined);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timeout);
        this.sessionAbort.signal.removeEventListener('abort', onSessionAbort);
      }
    }
    throw lastError;
  }

  /* ------------------------------------------------------------------ */
  /* Cache / usage                                                      */
  /* ------------------------------------------------------------------ */

  private async cached(
    text: string,
    context: string[],
  ): Promise<{ zh: string; provider?: string } | null> {
    if (!this.settings.cache.enabled) return null;
    const key = await makeCacheKey({
      version: PROMPT_VERSION,
      targetLang: this.settings.pipeline.targetLang,
      source: text,
      context,
      glossary: this.settings.pipeline.glossary,
    });
    return getCached(key, this.settings.cache.ttlDays);
  }

  private async store(
    text: string,
    context: string[],
    zh: string,
    provider: string,
  ): Promise<void> {
    if (!this.settings.cache.enabled) return;
    const key = await makeCacheKey({
      version: PROMPT_VERSION,
      targetLang: this.settings.pipeline.targetLang,
      source: text,
      context,
      glossary: this.settings.pipeline.glossary,
    });
    await putCached(key, zh, provider, this.settings.cache.maxEntries);
  }

  private addUsage(usage: ChatUsage | undefined, latencyMs: number): void {
    this.usage.lastLatencyMs = latencyMs;
    if (!usage) return;
    this.usage.inputTokens += usage.inputTokens ?? 0;
    this.usage.outputTokens += usage.outputTokens ?? 0;
  }

  static isRefusalText(text: string): boolean {
    return looksLikeRefusalText(text);
  }
}

function isLocal(config: ProviderConfig): boolean {
  return config.kind === 'ollama-native' || config.kind === 'mock';
}

function isCloudAsr(config: ProviderConfig): boolean {
  return config.kind === 'openai-asr';
}
