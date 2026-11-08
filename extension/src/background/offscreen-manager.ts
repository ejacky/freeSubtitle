import type { OffscreenCommand, OffscreenEvent } from '../lib/messaging/protocol';
import { log } from '../lib/log';

/**
 * Owns the singleton offscreen document and its long-lived port. The port also
 * doubles as a service-worker keepalive: the offscreen document pings every 20s.
 */
export class OffscreenManager {
  private port: chrome.runtime.Port | null = null;
  private ready = false;
  private waiters: Array<(port: chrome.runtime.Port) => void> = [];
  private rejecters: Array<(err: Error) => void> = [];
  private eventListeners = new Set<(event: OffscreenEvent) => void>();

  onEvent(listener: (event: OffscreenEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  attach(port: chrome.runtime.Port): void {
    if (port.name !== 'offscreen') return;
    this.port = port;
    this.ready = false;
    port.onMessage.addListener((message: OffscreenEvent) => {
      if (message?.type === 'ping') {
        try {
          port.postMessage({ type: 'pong' });
        } catch {
          // ignore
        }
        return;
      }
      if (message?.type === 'ready') {
        this.ready = true;
        const waiters = this.waiters.splice(0);
        for (const resolve of waiters) resolve(port);
      }
      if (message?.type === 'pong') return;
      for (const listener of this.eventListeners) {
        try {
          listener(message);
        } catch (err) {
          log('warn', 'offscreen.event.listener_failed', { message, error: String(err) });
        }
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.port === port) {
        this.port = null;
        this.ready = false;
      }
    });
  }

  async ensure(): Promise<chrome.runtime.Port> {
    if (this.port && this.ready) return this.port;

    const has = await chrome.offscreen.hasDocument().catch(() => false);
    if (!has) {
      try {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: [
            chrome.offscreen.Reason.USER_MEDIA,
            chrome.offscreen.Reason.AUDIO_PLAYBACK,
          ],
          justification: 'Capture and play back the current tab audio to generate live subtitles.',
        });
      } catch (err) {
        // Another caller may have created it concurrently.
        const nowHas = await chrome.offscreen.hasDocument().catch(() => false);
        if (!nowHas) throw err;
      }
    }

    if (this.port && this.ready) return this.port;

    return new Promise<chrome.runtime.Port>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('offscreen document did not become ready'));
      }, 5000);
      const onReady = (port: chrome.runtime.Port) => {
        cleanup();
        resolve(port);
      };
      const onReject = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== onReady);
        this.rejecters = this.rejecters.filter((r) => r !== onReject);
      };
      this.waiters.push(onReady);
      this.rejecters.push(onReject);
    });
  }

  post(message: OffscreenCommand): void {
    try {
      this.port?.postMessage(message);
    } catch (err) {
      log('warn', 'offscreen.post_failed', { type: message.type, error: String(err) });
    }
  }

  async close(): Promise<void> {
    this.port = null;
    this.ready = false;
    this.waiters.splice(0);
    this.rejecters.splice(0);
    try {
      if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
    } catch (err) {
      log('warn', 'offscreen.close_failed', { error: String(err) });
    }
  }
}
