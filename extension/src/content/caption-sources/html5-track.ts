import type { CaptionInfo, Cue } from '../../types';
import { cueId } from '../../lib/hash';
import type { Settings } from '../../lib/settings/schema';
import type { CaptionSink, CaptionSource } from './types';

function cueText(cue: TextTrackCue): string {
  return (cue as TextTrackCue & { text?: string }).text?.replace(/\s+/g, ' ').trim() ?? '';
}

/**
 * Reads native HTML5 TextTracks. Prefetch is best-effort: cross-origin tracks
 * expose `cues === null`, in which case we translate on cuechange only.
 */
export class TrackCaptionSource implements CaptionSource {
  private track: TextTrack | null = null;
  private started = false;
  private stopped = false;
  private previousMode: TextTrackMode | null = null;
  private seen = new Set<string>();
  private onCueChange = () => this.emitActive();
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly settings: Settings,
    private readonly sink: CaptionSink,
  ) {}

  async start(): Promise<void> {
    this.started = true;
    const track = await this.findTrack();
    if (this.stopped) return;
    if (!track) {
      this.sink.info({ source: 'none', ready: true });
      return;
    }

    this.track = track;
    this.previousMode = track.mode;
    track.mode = this.settings.output.hideNative ? 'hidden' : 'showing';

    try {
      track.addEventListener('cuechange', this.onCueChange);
    } catch {
      // Some implementations do not support events; fall back to polling.
    }

    this.sink.info({
      source: 'track',
      language: track.language || 'auto',
      ready: true,
    });

    this.prefetch(track);
    this.emitActive();

    // Some players attach tracks after metadata; poll politely for a while.
    if (track.cues === null) {
      let tries = 0;
      const poll = () => {
        if (this.stopped || tries++ > 12) return;
        if (track.cues && track.cues.length > 0) {
          this.prefetch(track);
          this.emitActive();
          return;
        }
        this.retryTimer = setTimeout(poll, 1000);
      };
      this.retryTimer = setTimeout(poll, 1000);
    }
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.track?.removeEventListener('cuechange', this.onCueChange);
    if (this.track && this.previousMode !== null) {
      try {
        this.track.mode = this.previousMode;
      } catch {
        // ignore
      }
    }
    this.track = null;
  }

  private async findTrack(): Promise<TextTrack | null> {
    const immediate = this.pickTrack();
    if (immediate) return immediate;

    return new Promise((resolve) => {
      let tries = 0;
      const timer = setInterval(() => {
        if (this.stopped) {
          clearInterval(timer);
          resolve(null);
          return;
        }
        const found = this.pickTrack();
        if (found || tries++ > 10) {
          clearInterval(timer);
          resolve(found);
        }
      }, 500);
    });
  }

  private pickTrack(): TextTrack | null {
    const tracks = Array.from(this.video.textTracks ?? []);
    const usable = tracks.filter(
      (track) =>
        (track.kind === 'subtitles' || track.kind === 'captions') &&
        Array.from(track.cues ?? []).some((cue) => cueText(cue)),
    );
    if (usable.length === 0) return null;

    const sourceLang = this.settings.pipeline.sourceLang;
    if (sourceLang !== 'auto') {
      const match = usable.find((track) =>
        track.language.toLowerCase().startsWith(sourceLang.toLowerCase()),
      );
      if (match) return match;
    }

    const nonChinese = usable.filter(
      (track) => !/^zh/i.test(track.language) && !/chinese|中文/i.test(track.label),
    );
    return nonChinese[0] ?? usable[0] ?? null;
  }

  private prefetch(track: TextTrack): void {
    let cues: TextTrackCueList | null = null;
    try {
      cues = track.cues;
    } catch {
      cues = null;
    }
    if (!cues || cues.length === 0) return;

    const out: Cue[] = [];
    const limit = Math.min(cues.length, 5000);
    for (let i = 0; i < limit; i++) {
      const cue = cues[i];
      if (!cue) continue;
      const text = cueText(cue);
      if (!text) continue;
      const id = cueId(cue.startTime, cue.endTime, text);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      out.push({
        id,
        start: cue.startTime,
        end: Math.max(cue.endTime, cue.startTime + 0.6),
        text,
        lang: track.language,
      });
    }
    if (out.length > 0) this.sink.cues(out, 'track');
  }

  private emitActive(): void {
    const active = this.track?.activeCues;
    if (!active) return;
    const out: Cue[] = [];
    for (let i = 0; i < active.length; i++) {
      const cue = active[i];
      if (!cue) continue;
      const text = cueText(cue);
      if (!text) continue;
      const id = cueId(cue.startTime, cue.endTime, text);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      out.push({
        id,
        start: cue.startTime,
        end: Math.max(cue.endTime, cue.startTime + 0.6),
        text,
        lang: this.track?.language,
      });
    }
    if (out.length > 0) this.sink.cues(out, 'track');
  }
}
