import type {
  CaptionInfo,
  Cue,
  LiveLine,
  Mode,
  TranslatedCue,
  VideoInfo,
} from '../types';
import type { BackgroundToContent, ContentToBackground } from '../lib/messaging/protocol';
import type { Settings } from '../lib/settings/schema';
import { log } from '../lib/log';
import { CaptionController } from './caption-sources/controller';
import { SubtitleOverlay } from './overlay';
import { VideoRegistry } from './video-registry';

const ZERO: VideoInfo = {
  area: 0,
  width: 0,
  height: 0,
  paused: true,
  currentTime: 0,
  duration: 0,
  drm: false,
};

declare global {
  interface Window {
    __freeSubtitleContent?: boolean;
  }
}

if (!window.__freeSubtitleContent) {
  window.__freeSubtitleContent = true;
  init();
}

function init(): void {
  let settings: Settings | null = null;
  let mode: Mode = 'auto';
  let sessionStarted = false;
  let frameActive = false;
  let generation = 0;
  let captionInfo: CaptionInfo = { source: 'none', ready: false };
  let overlay: SubtitleOverlay | null = null;
  let controller: CaptionController | null = null;
  const cueBuffer: Cue[] = [];

  const registry = new VideoRegistry({
    onChange: (video, info) => {
      if (!sessionStarted) return;
      if (frameActive) {
        generation++;
        overlay?.clear();
        if (video) overlay?.attach(video);
        else overlay?.activateFallback();
        if (mode !== 'audio') void restartController(video);
        if (video) send({ type: 'content.ready', video: info, captions: captionInfo });
        else send({ type: 'content.video', video: ZERO });
      } else if (video) {
        send({ type: 'content.ready', video: info, captions: captionInfo });
      }
    },
    onTime: (info) => {
      if (!sessionStarted || !frameActive) return;
      const video = registry.video;
      send({
        type: 'content.time',
        currentTime: info.currentTime,
        paused: info.paused,
        rate: video?.playbackRate ?? 1,
        generation,
      });
    },
    onSeek: () => {
      if (!sessionStarted || !frameActive) return;
      generation++;
      overlay?.clearLive();
      send({ type: 'content.seek', generation });
    },
    onState: (info) => {
      if (!sessionStarted) return;
      if (frameActive) send({ type: 'content.video', video: info });
      if (overlay && registry.video?.ended) overlay.clearLive();
    },
    onSourceChange: (info) => {
      if (!sessionStarted || !frameActive) return;
      // Same <video> element, new media: X modal next video, YouTube ads, SPA.
      generation++;
      cueBuffer.length = 0;
      overlay?.clear();
      const video = registry.video;
      if (video) overlay?.attach(video);
      void restartController(video);
      send({ type: 'content.ready', video: info, captions: captionInfo });
    },
  });

  registry.start();

  function send(message: ContentToBackground): void {
    chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  function announce(): void {
    if (!sessionStarted) return;
    const video = registry.video;
    send({
      type: 'content.ready',
      video: video ? registry.info(video) : ZERO,
      captions: captionInfo,
    });
  }

  function sendTime(): void {
    if (!sessionStarted || !frameActive) return;
    const video = registry.video;
    if (!video) return;
    send({
      type: 'content.time',
      currentTime: video.currentTime,
      paused: video.paused,
      rate: video.playbackRate,
      generation,
    });
  }

  function ensureOverlay(): void {
    if (!settings) return;
    if (!overlay) overlay = new SubtitleOverlay(settings);
    else overlay.setSettings(settings);
    if (cueBuffer.length > 0) overlay.addCues(cueBuffer.slice(-5000));
    const video = registry.video;
    if (video) overlay.attach(video);
  }

  async function restartController(video: HTMLVideoElement | null): Promise<void> {
    if (!settings) return;
    if (controller) {
      await controller.stop();
      controller = null;
    }
    captionInfo = { source: 'none', ready: false };
    send({ type: 'content.captionSource', captions: captionInfo });
    if (!video || !frameActive || mode === 'audio') return;

    controller = new CaptionController(
      {
        cues: (cues, source) => {
          if (mode === 'audio') return;
          cueBuffer.push(...cues);
          if (cueBuffer.length > 6000) cueBuffer.splice(0, cueBuffer.length - 6000);
          overlay?.addCues(cues);
          send({ type: 'content.cues', cues, source });
        },
        info: (info) => {
          captionInfo = info;
          send({ type: 'content.captionSource', captions: info });
        },
        notice: (message) => {
          overlay?.showNotice(message);
          log('info', 'caption.notice', { message });
        },
      },
      settings,
    );
    await controller.start(video);
  }

  function activateFrame(nextSettings: Settings): void {
    settings = nextSettings;
    frameActive = true;
    ensureOverlay();
    const video = registry.video;
    if (video) {
      overlay?.attach(video);
      if (mode !== 'audio') void restartController(video);
    } else {
      overlay?.activateFallback();
    }
    announce();
    sendTime();
  }

  function deactivateFrame(): void {
    frameActive = false;
    void controller?.stop();
    controller = null;
    overlay?.destroy();
    overlay = null;
    captionInfo = { source: 'none', ready: false };
  }

  chrome.runtime.onMessage.addListener((message: BackgroundToContent) => {
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'session.started':
        sessionStarted = true;
        settings = message.settings;
        mode = message.mode;
        generation = 0;
        frameActive = false;
        overlay?.destroy();
        overlay = null;
        cueBuffer.length = 0;
        captionInfo = { source: 'none', ready: false };
        registry.rescan();
        announce();
        break;
      case 'session.stopped':
        sessionStarted = false;
        deactivateFrame();
        // Keep the registry's lightweight observer alive so a second start on
        // the same page does not require re-injection.
        break;
      case 'overlay.activate':
        activateFrame(message.settings);
        break;
      case 'overlay.deactivate':
        deactivateFrame();
        break;
      case 'subtitles.upsert':
        overlay?.upsert(message.cues as TranslatedCue[]);
        break;
      case 'subtitles.live':
        overlay?.setLive(message.lines as LiveLine[]);
        break;
      case 'subtitles.clear':
        overlay?.clearLive();
        break;
      case 'notice':
        overlay?.showNotice(message.notice.message);
        break;
      case 'settings.updated': {
        const previous = settings;
        settings = message.settings;
        mode = message.settings.pipeline.mode;
        overlay?.setSettings(message.settings);
        const modeChanged = previous?.pipeline.mode !== settings.pipeline.mode;
        if (modeChanged && mode === 'audio') {
          void controller?.stop();
          controller = null;
          overlay?.clear();
          captionInfo = { source: 'none', ready: false };
        } else if (
          frameActive &&
          (modeChanged ||
            (previous &&
              (previous.output.hideNative !== settings.output.hideNative ||
                previous.pipeline.sourceLang !== settings.pipeline.sourceLang)))
        ) {
          void restartController(registry.video);
        }
        break;
      }
      default:
        break;
    }
  });

  // YouTube SPA navigation keeps the same content script and video element.
  window.addEventListener('yt-navigate-finish', () => {
    if (!sessionStarted) return;
    setTimeout(() => {
      generation++;
      overlay?.clear();
      registry.rescan();
      announce();
      if (frameActive) void restartController(registry.video);
    }, 600);
  });

  document.addEventListener('fullscreenchange', () => {
    if (!sessionStarted) return;
    setTimeout(() => {
      registry.rescan();
      announce();
      if (frameActive) {
        overlay?.setVideo(registry.video);
        void restartController(registry.video);
      }
    }, 100);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sessionStarted) {
      registry.rescan();
      announce();
    }
  });
}
