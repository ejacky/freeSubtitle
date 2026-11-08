import type { VideoInfo } from '../types';
import { log } from '../lib/log';

export interface VideoCallbacks {
  onChange: (video: HTMLVideoElement | null, info: VideoInfo) => void;
  onTime: (info: VideoInfo) => void;
  onSeek: () => void;
  onState: (info: VideoInfo) => void;
  onSourceChange: (info: VideoInfo) => void;
}

const ZERO: VideoInfo = {
  area: 0,
  width: 0,
  height: 0,
  paused: true,
  currentTime: 0,
  duration: 0,
  drm: false,
};

/** Finds the best visible <video>, including videos inside open shadow roots. */
export class VideoRegistry {
  private videos = new Set<HTMLVideoElement>();
  private current: HTMLVideoElement | null = null;
  private observer: MutationObserver | null = null;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private timeTimer?: ReturnType<typeof setInterval>;
  private pickTimer?: ReturnType<typeof setInterval>;
  private attached: HTMLVideoElement | null = null;

  constructor(private readonly callbacks: VideoCallbacks) {}

  get video(): HTMLVideoElement | null {
    return this.current;
  }

  start(): void {
    this.collect(document);
    this.pickAndNotify();
    this.observer = new MutationObserver((mutations) => {
      // Keep this cheap: do not deeply inspect every added node. Debounce and
      // rescan the (usually tiny) set of video elements instead.
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          this.scheduleScan();
          return;
        }
      }
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    this.timeTimer = setInterval(() => {
      if (!this.current) return;
      this.callbacks.onTime(this.info(this.current));
    }, 250);
    // Layout can change without DOM mutations (players opening in a modal,
    // responsive resize). Re-pick periodically so X/Twitter-style players do
    // not stay "no video" forever.
    this.pickTimer = setInterval(() => {
      if (this.current) this.collectLight(document);
      else this.collect(document);
      this.pickAndNotify();
    }, 2000);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.timeTimer) clearInterval(this.timeTimer);
    this.timeTimer = undefined;
    if (this.pickTimer) clearInterval(this.pickTimer);
    this.pickTimer = undefined;
    this.detach();
    this.videos.clear();
    this.current = null;
  }

  rescan(): void {
    this.collect(document);
    this.pickAndNotify();
  }

  info(video: HTMLVideoElement): VideoInfo {
    const rect = video.getBoundingClientRect();
    const width = Math.max(0, rect.width);
    const height = Math.max(0, rect.height);
    const mediaKeys = (video as HTMLVideoElement & { mediaKeys?: MediaKeys | null }).mediaKeys;
    return {
      area: Math.round(width * height),
      width: Math.round(width),
      height: Math.round(height),
      paused: video.paused,
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      title: document.title,
      src: video.currentSrc || video.src || undefined,
      drm: Boolean(mediaKeys),
    };
  }

  currentInfo(): VideoInfo {
    return this.current ? this.info(this.current) : { ...ZERO };
  }

  /* ------------------------------------------------------------------ */

  private scheduleScan(): void {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      if (this.current) this.collectLight(document);
      else this.collect(document);
      this.pickAndNotify();
    }, 350);
  }

  private collect(root: Document | ShadowRoot | Element): void {
    root.querySelectorAll('video').forEach((video) => this.videos.add(video as HTMLVideoElement));
    if (root instanceof Element || root instanceof Document) {
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) this.collect(el.shadowRoot);
      });
    }
  }

  private collectLight(root: Document | ShadowRoot | Element): void {
    root.querySelectorAll('video').forEach((video) => this.videos.add(video as HTMLVideoElement));
  }

  private pickAndNotify(): void {
    for (const video of this.videos) {
      if (!video.isConnected) this.videos.delete(video);
    }

    const visible = [...this.videos].filter((video) => {
      if (!video.isConnected) return false;
      const rect = video.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 45) return false;
      const style = getComputedStyle(video);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    const playing = visible.filter((video) => !video.paused && !video.ended);
    const pool = playing.length > 0 ? playing : visible;
    let best: HTMLVideoElement | null = null;
    let bestArea = 0;
    for (const video of pool) {
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = video;
        bestArea = area;
      }
    }

    if (!best) {
      if (this.current) {
        this.current = null;
        this.detach();
        this.callbacks.onChange(null, { ...ZERO });
      }
      return;
    }

    if (this.current && this.current !== best && !this.current.paused) {
      const currentRect = this.current.getBoundingClientRect();
      if (currentRect.width * currentRect.height * 1.6 > bestArea) {
        best = this.current;
      }
    }

    if (best !== this.current) {
      this.current = best;
      this.attach(best);
      this.callbacks.onChange(best, this.info(best));
    }
  }

  private attach(video: HTMLVideoElement): void {
    this.detach();
    this.attached = video;
    const onTime = () => {
      if (this.current === video) this.callbacks.onTime(this.info(video));
    };
    const onSeek = () => {
      if (this.current === video) this.callbacks.onSeek();
    };
    const onState = () => {
      if (this.current === video) this.callbacks.onState(this.info(video));
    };
    const onSourceChange = () => {
      if (this.current === video) this.callbacks.onSourceChange(this.info(video));
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeking', onSeek);
    video.addEventListener('play', onState);
    video.addEventListener('pause', onState);
    video.addEventListener('ratechange', onState);
    video.addEventListener('loadedmetadata', onState);
    video.addEventListener('ended', onState);
    video.addEventListener('loadstart', onSourceChange);
    video.addEventListener('emptied', onSourceChange);
    (video as HTMLVideoElement & { __freeSubtitleDetach?: () => void }).__freeSubtitleDetach = () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeking', onSeek);
      video.removeEventListener('play', onState);
      video.removeEventListener('pause', onState);
      video.removeEventListener('ratechange', onState);
      video.removeEventListener('loadedmetadata', onState);
      video.removeEventListener('ended', onState);
      video.removeEventListener('loadstart', onSourceChange);
      video.removeEventListener('emptied', onSourceChange);
    };
    log('debug', 'video.attached', { src: video.currentSrc?.slice(0, 120) });
  }

  private detach(): void {
    const video = this.attached as
      | (HTMLVideoElement & { __freeSubtitleDetach?: () => void })
      | null;
    video?.__freeSubtitleDetach?.();
    if (video) delete video.__freeSubtitleDetach;
    this.attached = null;
  }
}
