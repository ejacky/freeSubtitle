import { OffscreenManager } from './offscreen-manager';
import { SessionManager } from './session-manager';
import { readYouTubeTracks } from './inject';
import { testLocalServices, testProvider } from './provider-test';
import { clearCache } from '../lib/translate/cache';
import { getLogs } from '../lib/log';
import {
  loadSecrets,
  loadSettings,
  resetSettings,
  restrictStorageAccess,
  saveSecrets,
  saveSettings,
  secretsPresence,
} from '../lib/settings/store';
import type { Settings } from '../lib/settings/schema';
import type { Secrets } from '../lib/settings/store';
import type { RuntimeMessage } from '../lib/messaging/protocol';
import type { SettingsView } from '../types';
import { log } from '../lib/log';

const offscreen = new OffscreenManager();
const sessions = new SessionManager(offscreen);

let settingsCache: Settings | null = null;
let secretsCache: Secrets | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await restrictStorageAccess();
      settingsCache = await loadSettings();
      secretsCache = await loadSecrets();
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

async function getSettings(force = false): Promise<Settings> {
  await ensureInit();
  if (force || !settingsCache) settingsCache = await loadSettings();
  return settingsCache;
}

async function getSecrets(force = false): Promise<Secrets> {
  await ensureInit();
  if (force || !secretsCache) secretsCache = await loadSecrets();
  return secretsCache;
}

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: String(error instanceof Error ? error.message : error) };
}

async function handleMessage(
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  await ensureInit();

  switch (message?.type) {
    case 'session.start': {
      const settings = await getSettings();
      const secrets = await getSecrets();
      if (!settings.privacy.consentAccepted) {
        return { ok: false, error: '请先在设置中确认隐私说明' };
      }
      return sessions.start(message.tabId, message.streamId, message.mode, settings, secrets);
    }
    case 'session.prepare':
      await sessions.prepare();
      return { ok: true };
    case 'session.stop':
      await sessions.stop(message.tabId);
      return { ok: true };
    case 'session.status':
      return sessions.view(await getSettings(), await getSecrets());
    case 'settings.get': {
      const settings = await getSettings(true);
      const secretFlags = await secretsPresence();
      const view: SettingsView = {
        settings,
        secrets: secretFlags,
        session: sessions.view(settings, await getSecrets()),
        version: chrome.runtime.getManifest().version,
      };
      return view;
    }
    case 'settings.update': {
      await saveSettings(message.settings);
      if (message.secrets && Object.keys(message.secrets).length > 0) {
        const existing = await loadSecrets();
        await saveSecrets({ ...existing, ...message.secrets });
      }
      settingsCache = await loadSettings();
      secretsCache = await loadSecrets();
      sessions.applySettings(settingsCache, secretsCache);
      return { ok: true, settings: settingsCache };
    }
    case 'settings.reset': {
      settingsCache = await resetSettings();
      secretsCache = await loadSecrets();
      sessions.applySettings(settingsCache, secretsCache);
      return { ok: true, settings: settingsCache };
    }
    case 'provider.test': {
      const settings = await getSettings(true);
      const secrets = await getSecrets(true);
      return testProvider(settings, secrets, message.providerId, message.direction);
    }
    case 'local.test': {
      const settings = await getSettings(true);
      return testLocalServices(settings);
    }
    case 'cache.clear':
      await clearCache();
      return { ok: true };
    case 'logs.get':
      return { logs: getLogs() };

    case 'yt.tracks.request': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { tracks: [] };
      return { tracks: await readYouTubeTracks(tabId) };
    }

    case 'content.ready':
    case 'content.video':
    case 'content.captionSource':
    case 'content.cues':
    case 'content.time':
    case 'content.seek':
    case 'content.notice':
      sessions.handleContentMessage(message, sender);
      return { ok: true };

    default:
      return { ok: false, error: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message as RuntimeMessage, sender)
    .then((response) => sendResponse(response))
    .catch((err) => {
      log('error', 'message.failed', { type: (message as { type?: string })?.type, error: String(err) });
      sendResponse(fail(err));
    });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen') return;
  offscreen.attach(port);
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ensureInit();
    // Persist defaults on first install, but never overwrite existing settings.
    const stored = await chrome.storage.local.get('settings');
    if (!stored.settings) await saveSettings(settingsCache!);
    void chrome.action.setBadgeText({ text: '' });
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureInit();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void sessions.stop(tabId);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-translation') return;
  void (async () => {
    if (sessions.activeTabId !== undefined) {
      await sessions.stop();
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const settings = await getSettings();
    const secrets = await getSecrets();
    if (!settings.privacy.consentAccepted) return;
    const mode = settings.pipeline.mode;
    let streamId = '';
    if (mode !== 'captions') {
      await sessions.prepare().catch((err) => {
        log('warn', 'command.prepare_failed', { error: String(err) });
      });
      streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
          const error = chrome.runtime.lastError;
          if (error || !id) reject(new Error(error?.message ?? '无法捕获当前标签页音频'));
          else resolve(id);
        });
      }).catch((err) => {
        log('warn', 'command.capture_failed', { error: String(err) });
        return '';
      });
      if (!streamId) return;
    }
    await sessions.start(tab.id, streamId, mode, settings, secrets);
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A full navigation destroys the injected content script. For YouTube SPA
  // navigation, tabs.onUpdated usually only reports a title change; the content
  // script handles yt-navigate-finish itself.
  if (changeInfo.status === 'loading' && sessions.activeTabId === tabId) {
    void sessions.stop(tabId);
  }
});

// Fallback initialization for the first service-worker wake-up.
void ensureInit();
