import type { Cue, Layout, LiveLine, TranslatedCue } from '../types';
import type { Settings } from '../lib/settings/schema';

const HOST_ID = 'free-subtitle-overlay-host';
const NATIVE_STYLE_ID = 'free-subtitle-native-hide';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
}
.cue {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  max-width: 92vw;
  padding: 6px 12px 7px;
  border-radius: 8px;
  background: rgba(0, 0, 0, var(--fs-opacity, 0.56));
  text-align: center;
  line-height: 1.35;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.22);
  transition: opacity 120ms ease;
}
.cue.hidden { display: none; }
.src {
  white-space: pre-line;
  color: #dbeafe;
  font-size: calc(var(--fs-size, 28px) * 0.72);
  font-weight: 500;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  overflow-wrap: anywhere;
}
.zh {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  white-space: pre-line;
  color: #ffffff;
  font-size: var(--fs-size, 28px);
  font-weight: 650;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.95);
  overflow-wrap: anywhere;
}
.src:empty { display: none; }
.zh-text:empty { display: none; }
.zh.pending { color: #e2e8f0; font-weight: 500; }
.badge[hidden] { display: none; }
.badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(220, 38, 38, 0.82);
  color: #fff;
  font-size: calc(var(--fs-size, 28px) * 0.42);
  font-weight: 600;
  vertical-align: middle;
}
.live .cue { opacity: 0.98; }
.toast {
  position: fixed;
  left: 50%;
  top: 18px;
  transform: translateX(-50%);
  max-width: 80vw;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.92);
  color: #fff;
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  transition: opacity 160ms ease;
}
.toast.hidden { display: none; }
`;

export class SubtitleOverlay {
  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private wrap: HTMLDivElement | null = null;
  private cueEl: HTMLDivElement | null = null;
  private srcEl: HTMLDivElement | null = null;
  private zhEl: HTMLDivElement | null = null;
  private zhTextEl: HTMLSpanElement | null = null;
  private badgeEl: HTMLSpanElement | null = null;
  private toastEl: HTMLDivElement | null = null;
  private nativeStyle: HTMLStyleElement | null = null;

  private video: HTMLVideoElement | null = null;
  private settings: Settings;
  private sourceCues = new Map<string, Cue>();
  private sortedCues: Cue[] = [];
  private translated = new Map<string, TranslatedCue>();
  private live: LiveLine[] = [];
  private liveAt = 0;
  private raf = 0;
  private lastKey = '';
  private toastTimer?: ReturnType<typeof setTimeout>;
  private active = false;
  private fallback = false;
  private onFullscreen = () => this.reparent();

  constructor(settings: Settings) {
    this.settings = settings;
  }

  get isActive(): boolean {
    return this.active;
  }

  attach(video: HTMLVideoElement): void {
    this.video = video;
    this.fallback = false;
    this.active = true;
    this.ensureHost();
    this.ensureNativeHidden();
    this.reparent();
    this.startLoop();
  }

  setVideo(video: HTMLVideoElement | null): void {
    this.video = video;
    if (video) {
      this.fallback = false;
      this.active = true;
      this.ensureHost();
      this.ensureNativeHidden();
      this.reparent();
      this.startLoop();
    }
  }

  /**
   * Audio-only fallback when no <video> can be found (e.g. a player rendered in
   * a closed shadow root or a site-specific widget). Shows a page-bottom bar so
   * live ASR subtitles are not lost.
   */
  activateFallback(): void {
    this.active = true;
    this.fallback = true;
    this.video = null;
    this.ensureHost();
    this.ensureNativeHidden();
    this.reparent();
    this.startLoop();
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.applySettings();
    this.lastKey = '';
  }

  addCues(cues: Cue[]): void {
    for (const cue of cues) this.sourceCues.set(cue.id, cue);
    this.sortedCues = [...this.sourceCues.values()].sort((a, b) => a.start - b.start);
  }

  upsert(cues: TranslatedCue[]): void {
    for (const cue of cues) this.translated.set(cue.id, cue);
    this.lastKey = '';
  }

  setLive(lines: LiveLine[]): void {
    this.live = lines.slice(-2);
    this.liveAt = performance.now();
    this.lastKey = '';
  }

  clear(): void {
    this.sourceCues.clear();
    this.sortedCues = [];
    this.translated.clear();
    this.live = [];
    this.hideCue();
  }

  /** Seeking should only drop rolling ASR lines, not the captions already fetched. */
  clearLive(): void {
    this.live = [];
    this.lastKey = '';
  }

  showNotice(message: string, durationMs = 4500): void {
    this.ensureHost();
    if (!this.toastEl) return;
    this.toastEl.textContent = message;
    this.toastEl.classList.remove('hidden');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastEl?.classList.add('hidden');
    }, durationMs);
  }

  destroy(): void {
    this.active = false;
    this.fallback = false;
    this.video = null;
    this.clear();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.host?.remove();
    this.host = null;
    this.shadow = null;
    this.wrap = null;
    this.cueEl = null;
    this.srcEl = null;
    this.zhEl = null;
    this.zhTextEl = null;
    this.badgeEl = null;
    this.toastEl = null;
    this.nativeStyle?.remove();
    this.nativeStyle = null;
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  /* ------------------------------------------------------------------ */

  private ensureHost(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.all = 'initial';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.append(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const cue = document.createElement('div');
    cue.className = 'cue hidden';
    const src = document.createElement('div');
    src.className = 'src';
    const zhLine = document.createElement('div');
    zhLine.className = 'zh';
    const zhText = document.createElement('span');
    zhText.className = 'zh-text';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.hidden = true;
    zhLine.append(zhText, badge);
    cue.append(src, zhLine);

    const toast = document.createElement('div');
    toast.className = 'toast hidden';
    wrap.append(cue, toast);
    shadow.append(wrap);

    this.host = host;
    this.shadow = shadow;
    this.wrap = wrap;
    this.cueEl = cue;
    this.srcEl = src;
    this.zhEl = zhLine;
    this.zhTextEl = zhText;
    this.badgeEl = badge;
    this.toastEl = toast;

    this.applySettings();
    this.reparent();
    document.addEventListener('fullscreenchange', this.onFullscreen);
  }

  private reparent(): void {
    if (!this.host) return;
    const fullscreen = document.fullscreenElement;
    const parent =
      fullscreen instanceof HTMLVideoElement
        ? (fullscreen.parentElement ?? document.documentElement)
        : (fullscreen ?? document.documentElement);
    if (this.host.parentElement !== parent) parent.append(this.host);
  }

  private applySettings(): void {
    if (!this.host || !this.cueEl) return;
    this.host.style.setProperty('--fs-opacity', String(this.settings.output.opacity));
    this.host.style.setProperty('--fs-size', '28px');
    this.ensureNativeHidden();
  }

  private ensureNativeHidden(): void {
    const shouldHide = this.active && this.settings.output.hideNative;
    if (!shouldHide) {
      this.nativeStyle?.remove();
      this.nativeStyle = null;
      return;
    }
    if (this.nativeStyle) return;
    const style = document.createElement('style');
    style.id = NATIVE_STYLE_ID;
    style.textContent = `
      .ytp-caption-window-container { opacity: 0 !important; }
      .ytp-caption-segment { opacity: 0 !important; }
      video::cue { opacity: 0 !important; }
    `;
    document.head?.append(style);
    this.nativeStyle = style;
  }

  private startLoop(): void {
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.render();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private render(): void {
    if (!this.active || !this.cueEl) {
      this.hideCue();
      return;
    }
    let rect: { left: number; top: number; width: number; height: number; bottom: number; right: number };
    if (this.video) {
      const videoRect = this.video.getBoundingClientRect();
      if (videoRect.width < 40 || videoRect.height < 30) {
        this.hideCue();
        return;
      }
      rect = videoRect;
    } else if (this.fallback) {
      rect = {
        left: 0,
        top: 0,
        width: window.innerWidth,
        height: window.innerHeight,
        bottom: window.innerHeight,
        right: window.innerWidth,
      };
    } else {
      this.hideCue();
      return;
    }

    const now = performance.now();
    const liveVisible = this.live.length > 0 && now - this.liveAt < 15_000;
    const cue = this.video ? this.findCue(this.video.currentTime) : undefined;
    if (!cue && !liveVisible) {
      this.hideCue();
      return;
    }

    const fontPx = Math.round(
      Math.min(42, Math.max(16, rect.height * 0.038 * this.settings.output.fontScale)),
    );
    this.host?.style.setProperty('--fs-size', `${fontPx}px`);

    const isLive = !cue && liveVisible;
    const layout = this.settings.output.layout;
    const key = isLive
      ? `live:${this.live.map((line) => `${line.id}:${line.zh}:${line.status}`).join('|')}:${layout}`
      : `cue:${cue!.id}:${this.translated.get(cue!.id)?.zh ?? ''}:${
          this.translated.get(cue!.id)?.status ?? 'pending'
        }:${layout}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.paint(cue, isLive, layout);
    }

    const cueEl = this.cueEl;
    cueEl.classList.remove('hidden');
    cueEl.style.maxWidth = `${Math.max(220, Math.min(rect.width * 0.92, 1280))}px`;
    cueEl.style.left = `${rect.left + rect.width / 2}px`;
    if (this.settings.output.position === 'top') {
      cueEl.style.top = `${Math.max(8, rect.top + 24)}px`;
      cueEl.style.bottom = 'auto';
    } else {
      cueEl.style.bottom = `${Math.max(8, window.innerHeight - rect.bottom + 24)}px`;
      cueEl.style.top = 'auto';
    }
  }

  private paint(cue: Cue | undefined, isLive: boolean, layout: Layout): void {
    if (!this.srcEl || !this.zhEl || !this.zhTextEl || !this.badgeEl) return;
    let source = '';
    let zh = '';
    let failed = false;

    if (isLive) {
      source = this.live.map((line) => line.source).join('\n');
      zh = this.live.map((line) => line.zh).join('\n');
      failed = this.live.some((line) => line.status === 'failed');
    } else if (cue) {
      source = cue.text;
      const hit = this.translated.get(cue.id);
      zh = hit?.zh ?? '';
      failed = hit?.status === 'failed';
    }

    const same = Boolean(zh && source && zh.trim() === source.trim());
    const showSource = !same && (layout !== 'zh' || !zh);
    this.srcEl.textContent = showSource ? source : '';
    this.zhTextEl.textContent = layout === 'source' ? '' : zh;
    this.zhEl.classList.toggle('pending', !zh && !failed);

    if (!zh && failed && layout !== 'source') {
      this.badgeEl.hidden = false;
      this.badgeEl.textContent = '未翻译';
    } else {
      this.badgeEl.hidden = true;
    }
  }

  private findCue(time: number): Cue | undefined {
    if (this.sortedCues.length === 0) return undefined;
    let lo = 0;
    let hi = this.sortedCues.length - 1;
    let candidate = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.sortedCues[mid]!.start <= time) {
        candidate = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (let i = candidate; i >= Math.max(0, candidate - 2); i--) {
      const cue = this.sortedCues[i]!;
      if (time <= cue.end + 0.25) return cue;
    }
    return undefined;
  }

  private hideCue(): void {
    if (this.cueEl) this.cueEl.classList.add('hidden');
    this.lastKey = '';
  }

}
