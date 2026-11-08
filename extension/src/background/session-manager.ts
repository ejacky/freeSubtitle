import type {
  CaptionInfo,
  Cue,
  LiveLine,
  Mode,
  SessionStats,
  SessionState,
  SessionView,
  TranslatedCue,
  VideoInfo,
} from '../types';
import type { BackgroundToContent, OffscreenEvent } from '../lib/messaging/protocol';
import { DEFAULT_VAD, sendToTab } from '../lib/messaging/protocol';
import type { Settings } from '../lib/settings/schema';
import type { Secrets } from '../lib/settings/store';
import { buildProviders } from '../lib/providers/registry';
import { TranslationService } from '../lib/translate/service';
import {
  dedupeOverlap,
  isChineseLanguage,
  isNoSpeech,
  looksChinese,
  normalizeWhitespace,
  truncateToApproxTokens,
} from '../lib/text';
import { log } from '../lib/log';
import { base64ToArrayBuffer } from '../lib/base64';
import { injectContent } from './inject';
import type { OffscreenManager } from './offscreen-manager';

interface CueState {
  cue: Cue;
  status: 'pending' | 'inflight' | 'ok' | 'failed';
  attempts: number;
  lastAttempt?: number;
}

interface AsrItem {
  seq: number;
  wav: ArrayBuffer;
  t0: number;
  t1: number;
  generation: number;
}

interface Session {
  tabId: number;
  sessionId: string;
  mode: Mode;
  state: SessionState;
  startedAt: number;
  settings: Settings;
  service: TranslationService;
  frames: Map<number, VideoInfo>;
  activeFrameId?: number;
  lastVideoKey?: string;
  captionSource: CaptionInfo['source'];
  captionLanguage?: string;
  cues: Map<string, CueState>;
  currentTime: number;
  lastTime: number;
  paused: boolean;
  generation: number;
  audioActive: boolean;
  audioLevel: number;
  audioTimer?: ReturnType<typeof setTimeout>;
  noAudioTimer?: ReturnType<typeof setTimeout>;
  lastAudibleAt: number;
  noAudioNotified: boolean;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  asrQueue: AsrItem[];
  asrInFlight: number;
  asrSeq: number;
  asrProcessing: boolean;
  liveLines: LiveLine[];
  lastAsrText: string;
  lastContext: string[];
  detail: string;
  stats: SessionStats;
  activeBatches: number;
  scheduling: boolean;
  lastScheduleAt: number;
}

const MAX_ASR_QUEUE = 8;
const MAX_BATCH_CUES = 10;
const MAX_BATCH_CHARS = 1400;

/** Stable identity for "same video" checks. Title changes constantly on X/YouTube
 * and must not invalidate the cue table. */
function videoKey(video: VideoInfo): string {
  const src = (video.src ?? '').split('?')[0];
  return `${src}|${Math.round(video.duration)}`;
}

export class SessionManager {
  private session: Session | null = null;
  private closeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly offscreen: OffscreenManager) {
    this.offscreen.onEvent((event) => this.handleOffscreenEvent(event));
  }

  get activeTabId(): number | undefined {
    return this.session?.tabId;
  }

  /** Warm up the offscreen document before the popup requests a stream id. */
  async prepare(): Promise<void> {
    await this.offscreen.ensure();
  }

  async start(
    tabId: number,
    streamId: string,
    mode: Mode,
    settings: Settings,
    secrets: Secrets,
  ): Promise<{ ok: boolean; error?: string }> {
    await this.stop(undefined, true);
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }

    const sessionId = crypto.randomUUID();
    const session = {} as Session;
    session.tabId = tabId;
    session.sessionId = sessionId;
    session.mode = mode;
    session.state = 'starting';
    session.startedAt = Date.now();
    session.settings = settings;
    session.frames = new Map();
    session.captionSource = 'none';
    session.cues = new Map();
    session.currentTime = 0;
    session.lastTime = 0;
    session.paused = false;
    session.generation = 0;
    session.audioActive = mode === 'audio';
    session.audioLevel = 0;
    session.lastAudibleAt = Date.now();
    session.noAudioNotified = false;
    session.asrQueue = [];
    session.asrInFlight = 0;
    session.asrSeq = 0;
    session.asrProcessing = false;
    session.liveLines = [];
    session.lastAsrText = '';
    session.lastContext = [];
    session.detail = '正在连接当前标签页…';
    session.activeBatches = 0;
    session.scheduling = false;
    session.lastScheduleAt = 0;
    session.stats = {
      startedAt: session.startedAt,
      translatedCues: 0,
      asrSegments: 0,
      policyFallbacks: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastLatencyMs: 0,
    };
    session.service = new TranslationService(settings, secrets, sessionId, {
      onLocalFallback: () => {
        if (this.session === session) {
          this.notice(session, 'warn', 'policy.local_fallback', '云端多次拒绝，已切换到本地模型（较慢）');
        }
      },
    });

    this.session = session;
    const needsAudio = mode !== 'captions';
    if (needsAudio && !streamId) {
      this.session = null;
      return { ok: false, error: '没有可用的标签页音频流' };
    }
    this.setDetail(session, needsAudio ? '正在启动音频捕获…' : '正在启动字幕模式…');

    try {
      if (needsAudio) {
        await this.offscreen.ensure();
        this.offscreen.post({
          type: 'capture.start',
          tabId,
          streamId,
          generation: 0,
          vad: DEFAULT_VAD,
        });
      }

      await injectContent(tabId);
      await this.send(session, {
        type: 'session.started',
        sessionId,
        settings,
        mode,
      });

      if (!needsAudio) {
        session.state = 'running';
        this.setBadge('ON');
      }
      this.setDetail(session, '正在查找视频…');
      if (mode !== 'captions') {
        session.fallbackTimer = setTimeout(() => {
          if (this.session !== session || session.activeFrameId !== undefined) return;
          session.activeFrameId = 0;
          session.detail = '未检测到视频元素，字幕显示在页面底部';
          void sendToTab(
            tabId,
            { type: 'overlay.activate', settings: session.settings },
            0,
          ).catch(() => undefined);
        }, 2500);
      }

      if (mode === 'captions') {
        setTimeout(() => {
          if (this.session !== session) return;
          if (session.captionSource === 'none') {
            this.notice(
              session,
              'warn',
              'captions.none',
              '未发现字幕轨；X 等无字幕视频请把模式改为“自动”或“只用音频识别”',
            );
          }
        }, 3500);
      }

      if (mode !== 'captions') {
        session.noAudioTimer = setTimeout(() => {
          if (this.session !== session) return;
          if (!session.audioActive || session.noAudioNotified) return;
          if (Date.now() - session.lastAudibleAt > 8000 && session.audioLevel < 0.002) {
            session.noAudioNotified = true;
            session.detail = '未检测到音频：视频可能静音或没有音轨';
            this.notice(
              session,
              'warn',
              'audio.silent',
              '未检测到音频，请确认视频已取消静音，且该视频有音轨',
            );
          }
        }, 10_000);
      }

      if (mode === 'auto') {
        session.audioTimer = setTimeout(() => {
          if (this.session === session && session.captionSource === 'none') {
            session.audioActive = true;
            this.setDetail(session, '未发现字幕，已切换到音频识别');
            this.notice(session, 'info', 'audio.fallback', '未发现字幕轨，已启用音频识别（有延迟）');
          }
        }, 3000);
      } else if (mode === 'captions') {
        session.audioActive = false;
      }
      return { ok: true };
    } catch (err) {
      log('error', 'session.start_failed', { tabId, error: String(err) });
      await this.stop(tabId, true);
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  }

  async stop(tabId?: number, silent = false): Promise<void> {
    const session = this.session;
    if (!session) {
      // An orphaned offscreen capture can survive a service-worker restart;
      // make an explicit stop idempotently release it.
      this.offscreen.post({ type: 'capture.stop' });
      return;
    }
    if (tabId !== undefined && session.tabId !== tabId) return;

    this.session = null;
    if (session.audioTimer) clearTimeout(session.audioTimer);
    if (session.fallbackTimer) clearTimeout(session.fallbackTimer);
    if (session.noAudioTimer) clearTimeout(session.noAudioTimer);
    session.service.stop();
    this.offscreen.post({ type: 'capture.stop' });

    // Even a "silent" stop must tear down the old tab's overlay; otherwise
    // switching videos/tabs leaves a frozen subtitle layer and hidden native captions.
    await this.send(session, { type: 'session.stopped' }).catch(() => undefined);
    this.setBadge('');
    log('info', 'session.stopped', { tabId: session.tabId });

    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      if (!this.session) void this.offscreen.close();
    }, 4000);
  }

  applySettings(settings: Settings, secrets: Secrets): void {
    const session = this.session;
    if (!session) return;
    session.settings = settings;
    session.service.updateSettings(settings, secrets);
    session.mode = settings.pipeline.mode;
    if (session.mode === 'audio') session.audioActive = true;
    if (session.mode === 'captions') session.audioActive = false;
    if (session.mode === 'auto' && session.captionSource !== 'none') session.audioActive = false;
    void this.send(session, { type: 'settings.updated', settings }).catch(() => undefined);
    if (session.mode !== 'audio') this.schedule(session);
  }

  view(settings?: Settings, secrets?: Secrets): SessionView {
    const session = this.session;
    if (!session) {
      const built = settings && secrets ? buildProviders(settings, secrets) : null;
      const providers = built
        ? [...built.translation, ...built.asr].map((b) => ({
            id: b.config.id,
            label: b.config.label,
            kind: b.config.kind,
            ok: b.skippedReason ? false : null,
            skippedReason: b.skippedReason,
          }))
        : [];
      return { active: false, state: 'idle', providers };
    }

    const usage = session.service.getUsage();
    session.stats.inputTokens = usage.inputTokens;
    session.stats.outputTokens = usage.outputTokens;
    session.stats.lastLatencyMs = usage.lastLatencyMs;
    session.stats.policyFallbacks = session.service.getPolicyFailures();

    return {
      active: true,
      tabId: session.tabId,
      state: session.state,
      mode: session.mode,
      captionSource: session.captionSource,
      detail: session.detail,
      stats: { ...session.stats },
      providers: session.service.getProviderStatuses(),
      audioLevel: session.audioLevel,
      startedAt: session.startedAt,
    };
  }

  handleContentMessage(message: unknown, sender: chrome.runtime.MessageSender): void {
    const session = this.session;
    const tabId = sender.tab?.id;
    if (!session || tabId === undefined || session.tabId !== tabId) return;
    const frameId = sender.frameId ?? 0;

    if (!message || typeof message !== 'object') return;
    const msg = message as {
      type: string;
      video?: VideoInfo;
      captions?: CaptionInfo;
      cues?: Cue[];
      currentTime?: number;
      paused?: boolean;
      rate?: number;
      generation?: number;
      notice?: { level: 'info' | 'warn' | 'error'; code: string; message: string };
    };

    switch (msg.type) {
      case 'content.ready': {
        if (msg.video) this.updateFrame(session, frameId, msg.video);
        this.chooseFrame(session);
        if (msg.captions && frameId === session.activeFrameId) {
          this.updateCaptionSource(session, msg.captions);
        }
        this.setDetail(session, this.describe(session));
        break;
      }
      case 'content.video': {
        if (msg.video) this.updateFrame(session, frameId, msg.video);
        this.chooseFrame(session);
        break;
      }
      case 'content.captionSource': {
        if (msg.captions && frameId === session.activeFrameId) {
          this.updateCaptionSource(session, msg.captions);
          this.setDetail(session, this.describe(session));
        }
        break;
      }
      case 'content.cues': {
        if (frameId !== session.activeFrameId) break;
        if (session.mode === 'audio') break;
        this.handleCues(session, msg.cues ?? []);
        break;
      }
      case 'content.time': {
        if (frameId !== session.activeFrameId) break;
        this.handleTime(session, msg.currentTime ?? 0, Boolean(msg.paused), msg.rate ?? 1);
        break;
      }
      case 'content.seek': {
        if (frameId !== session.activeFrameId) break;
        this.handleSeek(session);
        break;
      }
      case 'content.notice': {
        if (msg.notice) {
          log('warn', 'content.notice', msg.notice);
        }
        break;
      }
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Offscreen events                                                   */
  /* ------------------------------------------------------------------ */

  private handleOffscreenEvent(event: OffscreenEvent): void {
    const session = this.session;
    if (!session) return;

    switch (event.type) {
      case 'capture.started':
        session.state = 'running';
        this.setBadge('ON');
        this.setDetail(session, '正在查找视频…');
        break;
      case 'capture.error':
        session.state = 'error';
        this.setDetail(session, event.message);
        this.notice(session, 'error', event.code, event.message);
        break;
      case 'capture.ended':
        void this.stop(session.tabId);
        break;
      case 'audio.level':
        session.audioLevel = event.rms;
        if (event.rms > 0.001) session.lastAudibleAt = Date.now();
        break;
      case 'audio.segment':
        if (event.tabId !== session.tabId) break;
        this.handleAudioSegment(session, event);
        break;
      default:
        break;
    }
  }

  private handleAudioSegment(
    session: Session,
    event: Extract<OffscreenEvent, { type: 'audio.segment' }>,
  ): void {
    if (!session.audioActive || session.mode === 'captions') return;
    if (event.generation !== session.generation) return;
    session.lastAudibleAt = Date.now();

    const wav = base64ToArrayBuffer(event.wavBase64);
    log('debug', 'audio.segment.received', {
      wavBytes: wav.byteLength,
      generation: event.generation,
    });
    session.asrQueue.push({
      seq: event.seq,
      wav,
      t0: event.t0,
      t1: event.t1,
      generation: event.generation,
    });
    if (session.asrQueue.length > MAX_ASR_QUEUE) {
      session.asrQueue.shift();
      session.state = 'degraded';
      this.setDetail(session, '识别速度跟不上，已丢弃最早的一段音频');
    }
    void this.processAsr(session);
  }

  private async processAsr(session: Session): Promise<void> {
    if (session.asrProcessing) return;
    session.asrProcessing = true;
    try {
      while (
        this.session === session &&
        session.asrQueue.length > 0 &&
        session.asrInFlight < 1
      ) {
        const item = session.asrQueue.shift()!;
        session.asrInFlight++;
        void this.transcribeOne(session, item).finally(() => {
          session.asrInFlight--;
          if (this.session === session) void this.processAsr(session);
        });
      }
    } finally {
      session.asrProcessing = false;
    }
  }

  private async transcribeOne(session: Session, item: AsrItem): Promise<void> {
    // Groq/OpenAI Whisper prompt is capped around 224 tokens. Do not send the
    // translation glossary here; only the previous same-language line.
    const prompt = truncateToApproxTokens(session.lastContext.at(-1) ?? '', 160);
    const result = await session.service.transcribe(item.wav, {
      language:
        session.settings.pipeline.sourceLang === 'auto'
          ? undefined
          : session.settings.pipeline.sourceLang,
      prompt,
    });
    if (this.session !== session || item.generation !== session.generation) return;
    if (!result) {
      session.state = 'degraded';
      this.setDetail(session, '语音识别不可用，请检查本地 ASR 或云端 key');
      this.notice(session, 'warn', 'asr.unavailable', '语音识别不可用：本地 ASR 未启动或云端 key 无效');
      return;
    }

    const text = normalizeWhitespace(result.text);
    if (!text || isNoSpeech(text)) return;

    const deduped = dedupeOverlap(session.lastAsrText, text);
    if (!deduped) return;
    session.lastAsrText = text;

    // Trust the ASR language tag first. Japanese can contain many kanji and
    // would otherwise be mistaken for Chinese by a pure CJK-ratio check.
    const sourceIsChinese = result.language
      ? isChineseLanguage(result.language)
      : looksChinese(deduped);
    let translated: TranslatedCue;
    if (sourceIsChinese) {
      translated = { id: `live-${item.seq}`, zh: deduped, status: 'source', provider: 'source' };
    } else {
      const startedAt = Date.now();
      const hit = await session.service.translateText(deduped, session.lastContext);
      if (this.session !== session || item.generation !== session.generation) return;
      translated = {
        id: `live-${item.seq}`,
        zh: hit.zh,
        status: hit.status,
        provider: hit.provider,
      };
      session.stats.lastLatencyMs = Date.now() - startedAt;
    }

    const line: LiveLine = {
      id: translated.id,
      source: deduped,
      zh: translated.zh || (session.settings.contentPolicy.showOriginalOnFail ? '' : deduped),
      t0: item.t0,
      t1: item.t1,
      status: translated.status,
    };
    session.liveLines.push(line);
    if (session.liveLines.length > 2) session.liveLines.shift();
    session.lastContext = [deduped];
    session.stats.asrSegments++;
    session.stats.translatedCues++;
    session.state = translated.status === 'failed' ? 'degraded' : 'running';
    this.sendLive(session);
  }

  /* ------------------------------------------------------------------ */
  /* Captions / translation                                             */
  /* ------------------------------------------------------------------ */

  private handleCues(session: Session, cues: Cue[]): void {
    if (cues.length === 0) return;
    let added = false;
    const direct: TranslatedCue[] = [];

    for (const cue of cues) {
      if (!cue.text.trim()) continue;
      const existing = session.cues.get(cue.id);
      if (existing) continue;

      const cueIsChinese =
        cue.lang && cue.lang !== 'auto'
          ? isChineseLanguage(cue.lang)
          : looksChinese(cue.text);
      if (cueIsChinese && session.settings.pipeline.targetLang.startsWith('zh')) {
        session.cues.set(cue.id, { cue, status: 'ok', attempts: 0 });
        direct.push({ id: cue.id, zh: cue.text, status: 'source' });
      } else {
        session.cues.set(cue.id, { cue, status: 'pending', attempts: 0 });
        added = true;
      }
    }

    if (direct.length > 0) {
      void this.send(session, { type: 'subtitles.upsert', cues: direct }).catch(() => undefined);
    }
    if (added) {
      session.state = 'running';
      this.schedule(session);
    }
  }

  private handleTime(session: Session, currentTime: number, paused: boolean, rate: number): void {
    if (Number.isFinite(currentTime)) {
      if (session.lastTime > 0 && Math.abs(currentTime - session.lastTime) > 3) {
        this.handleSeek(session);
      }
      session.currentTime = currentTime;
      session.lastTime = currentTime;
    }
    session.paused = paused;
    if (rate > 1.6 && session.audioActive) {
      this.setDetail(session, `当前 ${rate.toFixed(1)}x 倍速，语音识别质量可能下降`);
    }
    this.schedule(session);
  }

  private handleSeek(session: Session): void {
    session.generation++;
    session.lastAsrText = '';
    session.liveLines = [];
    session.asrQueue = [];
    this.offscreen.post({ type: 'capture.generation', generation: session.generation });
    void this.send(session, { type: 'subtitles.clear' }).catch(() => undefined);
    this.schedule(session);
  }

  private schedule(session: Session): void {
    if (this.session !== session) return;
    if (session.mode === 'audio') return;
    if (session.captionSource === 'none' || session.activeFrameId === undefined) return;
    if (session.scheduling) return;
    session.lastScheduleAt = Date.now();
    session.scheduling = true;
    try {
      const max = Math.max(1, session.settings.pipeline.maxConcurrent);
      while (session.activeBatches < max) {
        const batch = this.pickBatch(session);
        if (batch.length === 0) break;
        session.activeBatches++;
        for (const state of batch) state.status = 'inflight';
        void this.runBatch(session, batch);
      }
    } finally {
      session.scheduling = false;
    }
  }

  private pickBatch(session: Session): CueState[] {
    const now = session.lastTime || 0;
    const end = now + Math.max(15, session.settings.pipeline.prefetchAheadSec);
    const start = now > 8 ? now - 8 : 0;
    const candidates = [...session.cues.values()]
      .filter((state) => {
        if (state.status === 'ok' || state.status === 'inflight') return false;
        if (state.cue.start < start || state.cue.start > end) return false;
        if (state.status === 'failed') {
          return state.attempts < 2 && Date.now() - (state.lastAttempt ?? 0) > 15_000;
        }
        return true;
      })
      .sort((a, b) => a.cue.start - b.cue.start);

    const batch: CueState[] = [];
    let chars = 0;
    for (const state of candidates) {
      if (batch.length >= MAX_BATCH_CUES) break;
      if (chars + state.cue.text.length > MAX_BATCH_CHARS && batch.length > 0) break;
      batch.push(state);
      chars += state.cue.text.length;
    }
    return batch;
  }

  private async runBatch(session: Session, batch: CueState[]): Promise<void> {
    const context = this.contextBefore(session, batch[0]?.cue);
    try {
      const result = await session.service.translateCues(
        batch.map((state) => state.cue),
        context,
      );
      if (this.session !== session) return;

      const updates: TranslatedCue[] = [];
      for (const state of batch) {
        const hit = result.get(state.cue.id);
        if (hit && hit.status === 'ok' && hit.zh) {
          state.status = 'ok';
          state.attempts++;
          session.stats.translatedCues++;
          updates.push({
            id: state.cue.id,
            zh: hit.zh,
            status: 'ok',
            provider: hit.provider,
          });
        } else {
          state.status = 'failed';
          state.attempts++;
          state.lastAttempt = Date.now();
          updates.push({
            id: state.cue.id,
            zh: session.settings.contentPolicy.showOriginalOnFail ? '' : state.cue.text,
            status: 'failed',
          });
        }
      }

      if (updates.length > 0) {
        await this.send(session, { type: 'subtitles.upsert', cues: updates }).catch(() => undefined);
      }
      if (session.service.consumeLocalFallbackNotice()) {
        this.notice(session, 'warn', 'policy.local_fallback', '云端多次拒绝，已切换到本地模型（较慢）');
      }
    } catch (err) {
      log('warn', 'translate.batch_failed', { error: String(err) });
      for (const state of batch) {
        state.status = 'failed';
        state.attempts++;
        state.lastAttempt = Date.now();
      }
    } finally {
      session.activeBatches = Math.max(0, session.activeBatches - 1);
      if (this.session === session) this.schedule(session);
    }
  }

  private contextBefore(session: Session, cue?: Cue): string[] {
    if (!cue) return [];
    const all = [...session.cues.values()].sort((a, b) => a.cue.start - b.cue.start);
    const index = all.findIndex((state) => state.cue.id === cue.id);
    if (index <= 0) return [];
    return all
      .slice(Math.max(0, index - 2), index)
      .map((state) => state.cue.text);
  }

  /* ------------------------------------------------------------------ */
  /* Frame election / helpers                                           */
  /* ------------------------------------------------------------------ */

  private updateFrame(session: Session, frameId: number, video: VideoInfo): void {
    session.frames.set(frameId, video);
    const key = videoKey(video);
    if (session.activeFrameId === frameId && session.lastVideoKey && session.lastVideoKey !== key) {
      session.cues.clear();
      session.liveLines = [];
      session.generation++;
      this.offscreen.post({ type: 'capture.generation', generation: session.generation });
      void this.send(session, { type: 'subtitles.clear' }).catch(() => undefined);
    }
    if (session.activeFrameId === frameId || session.activeFrameId === undefined) {
      session.lastVideoKey = key;
    }
  }

  private chooseFrame(session: Session): void {
    let bestId: number | undefined;
    let bestArea = 0;
    for (const [frameId, video] of session.frames) {
      const area = Math.max(0, video.area || video.width * video.height);
      if (area > bestArea) {
        bestArea = area;
        bestId = frameId;
      }
    }
    if (bestId === undefined) return;

    if (session.activeFrameId === bestId) {
      const video = session.frames.get(bestId);
      if (video) session.lastVideoKey = videoKey(video);
      return;
    }

    if (session.fallbackTimer) {
      clearTimeout(session.fallbackTimer);
      session.fallbackTimer = undefined;
    }
    const old = session.activeFrameId;
    session.activeFrameId = bestId;
    session.cues.clear();
    session.liveLines = [];
    session.generation++;
    this.offscreen.post({ type: 'capture.generation', generation: session.generation });

    if (old !== undefined) {
      void sendToTab(session.tabId, { type: 'overlay.deactivate' }, old).catch(() => undefined);
    }
    void sendToTab(
      session.tabId,
      { type: 'overlay.activate', settings: session.settings },
      bestId,
    ).catch(() => undefined);
  }

  private updateCaptionSource(session: Session, captions: CaptionInfo): void {
    session.captionSource = captions.source;
    session.captionLanguage = captions.language;
    if (captions.source !== 'none') {
      if (session.mode !== 'audio') {
        session.audioActive = false;
        session.liveLines = [];
        this.setDetail(session, this.describe(session));
        this.schedule(session);
      }
    } else if (session.mode !== 'captions') {
      session.audioActive = true;
    }
  }

  private describe(session: Session): string {
    if (session.captionSource === 'youtube') {
      return `字幕轨：YouTube${session.captionLanguage ? ` (${session.captionLanguage})` : ''}`;
    }
    if (session.captionSource === 'track') {
      return `字幕轨：页面 TextTrack${session.captionLanguage ? ` (${session.captionLanguage})` : ''}`;
    }
    if (session.captionSource === 'dom') return '字幕轨：页面 DOM 字幕';
    if (session.mode === 'captions') return '未发现字幕轨';
    return session.audioActive ? '音频识别中…' : '正在查找字幕…';
  }

  private setDetail(session: Session, detail: string): void {
    session.detail = detail;
  }

  private sendLive(session: Session): void {
    void this.send(session, {
      type: 'subtitles.live',
      lines: session.liveLines,
    }).catch(() => undefined);
  }

  private async send(session: Session, message: BackgroundToContent): Promise<void> {
    if (
      session.activeFrameId === undefined &&
      message.type !== 'session.started' &&
      message.type !== 'session.stopped'
    ) {
      return;
    }
    const frameId = message.type === 'session.started' || message.type === 'session.stopped'
      ? undefined
      : session.activeFrameId;
    try {
      await sendToTab(session.tabId, message, frameId);
    } catch (err) {
      log('debug', 'tab.send_failed', { type: message.type, error: String(err) });
    }
  }

  private notice(
    session: Session,
    level: 'info' | 'warn' | 'error',
    code: string,
    message: string,
  ): void {
    log(level, code, { message });
    void this.send(session, { type: 'notice', notice: { level, code, message } }).catch(
      () => undefined,
    );
  }

  private setBadge(text: string): void {
    void chrome.action.setBadgeText({ text }).catch(() => undefined);
    if (text) {
      void chrome.action.setBadgeBackgroundColor({ color: text === 'ON' ? '#16a34a' : '#dc2626' }).catch(
        () => undefined,
      );
    }
  }
}
