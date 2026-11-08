import type { CaptionInfo, Cue } from '../../types';
import { cueId } from '../../lib/hash';
import type { YtCaptionTrack } from '../../lib/messaging/protocol';
import type { Settings } from '../../lib/settings/schema';
import type { CaptionSink, CaptionSource } from './types';

interface TimedTextEvent {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

function textOf(event: TimedTextEvent): string {
  return (event.segs ?? [])
    .map((seg) => seg.utf8 ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * YouTube adapter:
 *  1. preferred: player response captionTracks -> timedtext JSON3 (full prefetch)
 *  2. fallback: observe the rendered caption DOM (works for live/auto captions)
 */
export class YouTubeCaptionSource implements CaptionSource {
  private stopped = false;
  private abort: AbortController | null = null;
  private observer: MutationObserver | null = null;
  private pendingText = '';
  private pendingStart = 0;
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private lastText = '';
  private lastCueAt = 0;
  private seq = 0;
  private domAnnounced = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly settings: Settings,
    private readonly sink: CaptionSink,
  ) {}

  async start(): Promise<void> {
    const tracks = await this.requestTracks();
    if (this.stopped) return;

    const track = this.pickTrack(tracks);
    if (track) {
      try {
        const cues = await this.fetchCues(track);
        if (this.stopped) return;
        if (cues.length > 0) {
          this.sink.info({
            source: 'youtube',
            language: track.languageCode || 'auto',
            ready: true,
          });
          this.sendInChunks(cues);
          return;
        }
      } catch {
        // fall through to DOM captions
      }
    }

    this.startDomFallback();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    this.observer?.disconnect();
    this.observer = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
  }

  private async requestTracks(): Promise<YtCaptionTrack[]> {
    try {
      const response = (await Promise.race([
        chrome.runtime.sendMessage({ type: 'yt.tracks.request' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ])) as { tracks?: YtCaptionTrack[] } | undefined;
      return Array.isArray(response?.tracks) ? response.tracks : [];
    } catch {
      return [];
    }
  }

  private pickTrack(tracks: YtCaptionTrack[]): YtCaptionTrack | null {
    const usable = tracks.filter((track) => track.baseUrl);
    if (usable.length === 0) return null;
    const sourceLang = this.settings.pipeline.sourceLang;

    if (sourceLang !== 'auto') {
      const match = usable.find((track) =>
        track.languageCode.toLowerCase().startsWith(sourceLang.toLowerCase()),
      );
      if (match) return match;
    }

    const nonChinese = usable.filter((track) => !/^zh/i.test(track.languageCode));
    const manual = nonChinese.find((track) => track.kind !== 'asr');
    return manual ?? nonChinese[0] ?? usable[0] ?? null;
  }

  private async fetchCues(track: YtCaptionTrack): Promise<Cue[]> {
    this.abort = new AbortController();
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', 'json3');
    const res = await fetch(url.toString(), {
      credentials: 'include',
      signal: this.abort.signal,
    });
    if (!res.ok) throw new Error(`timedtext ${res.status}`);
    const data = (await res.json()) as { events?: TimedTextEvent[] };
    const cues: Cue[] = [];
    for (const event of data.events ?? []) {
      const text = textOf(event);
      if (!text) continue;
      const start = Math.max(0, (event.tStartMs ?? 0) / 1000);
      const dur = Math.max(0.4, (event.dDurationMs ?? 0) / 1000);
      cues.push({
        id: cueId(start, start + dur, text),
        start,
        end: start + dur,
        text,
        lang: track.languageCode,
      });
    }
    return cues;
  }

  private sendInChunks(cues: Cue[]): void {
    const chunkSize = 250;
    for (let i = 0; i < cues.length; i += chunkSize) {
      if (this.stopped) return;
      this.sink.cues(cues.slice(i, i + chunkSize), 'youtube');
    }
  }

  private startDomFallback(): void {
    // Do not claim DOM captions yet. If none appear, the service worker keeps
    // the audio fallback active. We announce `dom` on the first real caption.
    const target = document.querySelector('#movie_player') ?? document.body;
    if (!target) return;

    this.observer = new MutationObserver(() => this.scheduleFromDom());
    this.observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.scheduleFromDom();
  }

  private scheduleFromDom(): void {
    if (this.stopped || this.isAd()) return;
    const text = this.readDomText();
    if (!text) {
      this.pendingText = '';
      this.pendingStart = 0;
      return;
    }
    if (text === this.lastText) return;
    if (!this.domAnnounced) {
      this.domAnnounced = true;
      this.sink.info({ source: 'dom', language: 'auto', ready: true });
      this.sink.notice('YouTube 字幕接口不可用，改用页面字幕（可能有约 1 秒延迟）');
    }
    if (!this.pendingText) this.pendingStart = this.video.currentTime;
    this.pendingText = text;

    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    const delay = this.video.paused ? 250 : 900;
    this.pendingTimer = setTimeout(() => this.finalizeDom(), delay);
  }

  private finalizeDom(): void {
    if (this.stopped || this.isAd()) return;
    const text = this.pendingText.trim();
    if (!text || text === this.lastText) return;
    const start = this.pendingStart || Math.max(0, this.video.currentTime - 0.6);
    const end = Math.max(start + 1.2, this.video.currentTime + 0.25);
    const id = `ytdom-${this.seq++}-${cueId(start, end, text)}`;
    this.lastText = text;
    this.pendingText = '';
    this.pendingStart = 0;
    this.lastCueAt = Date.now();
    this.sink.cues([{ id, start, end, text, lang: 'auto' }], 'dom');
  }

  private readDomText(): string {
    const segments = document.querySelectorAll('.ytp-caption-segment');
    return Array.from(segments)
      .map((node) => node.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isAd(): boolean {
    const player = document.querySelector('#movie_player');
    return Boolean(
      player?.classList.contains('ad-showing') ||
        document.querySelector('.ytp-ad-player-overlay'),
    );
  }
}
