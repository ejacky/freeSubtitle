import type { OffscreenCommand } from '../lib/messaging/protocol';
import { TabAudioCapture } from './capture';
import { log } from '../lib/log';
import { arrayBufferToBase64 } from '../lib/base64';

let port: chrome.runtime.Port | null = null;
let capture: TabAudioCapture | null = null;
let tabId = 0;
let seq = 0;
let keepalive: ReturnType<typeof setInterval> | null = null;

function connect(): void {
  try {
    const next = chrome.runtime.connect({ name: 'offscreen' });
    port = next;
    next.onMessage.addListener((message: OffscreenCommand) => {
      if (port === next) handleCommand(message);
    });
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
      // The service worker may have been suspended; reconnect and let it
      // recover the session state via `ready` / `capture.started`.
      setTimeout(connect, 1000);
    });
    next.postMessage({ type: 'ready' });
    if (capture?.isActive) {
      next.postMessage({ type: 'capture.started', tabId });
    }
  } catch {
    setTimeout(connect, 1500);
  }
}

function send(event: Record<string, unknown>): void {
  try {
    port?.postMessage(event);
  } catch {
    // Port is gone; the reconnect loop will restore it.
  }
}

function handleCommand(message: OffscreenCommand): void {
  switch (message.type) {
    case 'capture.start': {
      tabId = message.tabId;
      seq = 0;
      capture?.stop();
      capture = new TabAudioCapture({
        onSegment: (wav, segment, generation) => {
          seq++;
          send({
            type: 'audio.segment',
            tabId,
            seq,
            wavBase64: arrayBufferToBase64(wav),
            t0: segment.t0,
            t1: segment.t1,
            rms: segment.rms,
            generation,
          });
        },
        onLevel: (rms) => send({ type: 'audio.level', tabId, rms }),
        onEnded: () => send({ type: 'capture.ended', tabId }),
        onError: (code, messageText) =>
          send({ type: 'capture.error', tabId, code, message: messageText }),
      });
      void capture
        .start(message.streamId, message.vad)
        .then(() => send({ type: 'capture.started', tabId }))
        .catch((err) => {
          log('error', 'offscreen.capture_failed', { error: String(err) });
        });
      break;
    }
    case 'capture.stop':
      capture?.stop();
      capture = null;
      break;
    case 'capture.generation':
      capture?.setGeneration(message.generation);
      break;
    case 'ping':
      send({ type: 'pong' });
      break;
    default:
      break;
  }
}

connect();

// A long-lived port message at least every 20 s keeps the MV3 service worker
// from being suspended while a long video is playing.
keepalive = setInterval(() => {
  send({ type: 'ping' });
}, 20_000);

window.addEventListener('unload', () => {
  if (keepalive) clearInterval(keepalive);
  capture?.stop();
});
