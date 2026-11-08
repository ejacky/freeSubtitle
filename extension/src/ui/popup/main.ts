import type { Mode, SessionView, SettingsView } from '../../types';
import type { Settings } from '../../lib/settings/schema';
import type { StartResult } from '../../lib/messaging/protocol';
import { sendRuntime } from '../../lib/messaging/protocol';

const statusDot = document.getElementById('statusDot') as HTMLSpanElement;
const statusText = document.getElementById('statusText') as HTMLDivElement;
const detail = document.getElementById('detail') as HTMLDivElement;
const modeSelect = document.getElementById('modeSelect') as HTMLSelectElement;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const notice = document.getElementById('notice') as HTMLDivElement;
const providerList = document.getElementById('providerList') as HTMLDivElement;
const optionsLink = document.getElementById('optionsLink') as HTMLButtonElement;
const stats = document.getElementById('stats') as HTMLSpanElement;

let settings: Settings | null = null;
let view: SessionView | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let busy = false;
let unsupported = false;

function setNotice(message: string, error = false): void {
  if (!message) {
    notice.hidden = true;
    notice.textContent = '';
    return;
  }
  notice.hidden = false;
  notice.textContent = message;
  notice.classList.toggle('error', error);
}

function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
}

function supportedUrl(url?: string): boolean {
  if (!url) return true;
  return /^https?:/i.test(url);
}

function render(): void {
  if (!settings) return;
  modeSelect.value = settings.pipeline.mode;
  const active = Boolean(view?.active);
  const state = view?.state ?? 'idle';

  statusDot.className = 'dot';
  if (!active) {
    statusDot.classList.add('ok');
    statusText.textContent = '就绪';
    detail.textContent = '打开一个视频页面，点击下方按钮开始。';
  } else if (state === 'starting') {
    statusDot.classList.add('busy');
    statusText.textContent = '正在启动…';
    detail.textContent = view?.detail ?? '正在连接标签页音频';
  } else if (state === 'error') {
    statusDot.classList.add('bad');
    statusText.textContent = '启动失败';
    detail.textContent = view?.detail ?? '请打开设置检查服务配置。';
  } else if (state === 'degraded') {
    statusDot.classList.add('warn');
    statusText.textContent = '降级运行';
    detail.textContent = view?.detail ?? '部分服务不可用，已尝试降级。';
  } else {
    statusDot.classList.add('busy');
    statusText.textContent = active ? '翻译中' : '就绪';
    detail.textContent = view?.detail ?? '正在查找视频…';
  }

  startBtn.hidden = active;
  stopBtn.hidden = !active;
  startBtn.disabled = busy || !settings.privacy.consentAccepted || unsupported;

  if (!settings.privacy.consentAccepted) {
    setNotice('请先在设置中确认隐私说明，再开始翻译。', false);
  } else if (!notice.hidden && notice.classList.contains('error')) {
    // keep the last error until the next action
  } else {
    setNotice('');
  }

  if (active && view?.stats) {
    const minutes = Math.max(1, Math.round((Date.now() - view.stats.startedAt) / 60000));
    const tokens = view.stats.inputTokens + view.stats.outputTokens;
    const level = Math.round((view.audioLevel ?? 0) * 100);
    stats.textContent = `${minutes} 分钟 · ${view.stats.translatedCues} 条 · ${
      view.stats.asrSegments > 0 ? `${view.stats.asrSegments} 段` : ''
    } · ${tokens > 0 ? `${tokens} tok` : '—'} · 音频 ${level}%`;
  } else {
    stats.textContent = '';
  }

  providerList.textContent = '';
  const providers = view?.providers ?? [];
  if (providers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'provider';
    empty.textContent = '暂无服务配置';
    providerList.append(empty);
    return;
  }
  for (const provider of providers) {
    const row = document.createElement('div');
    row.className = 'provider';
    const dot = document.createElement('span');
    dot.className = 'pdot';
    if (provider.skippedReason) dot.classList.add('bad');
    else if (provider.cooldownUntil && provider.cooldownUntil > Date.now()) dot.classList.add('warn');
    else if (provider.ok === true) dot.classList.add('ok');
    else if (provider.ok === false) dot.classList.add('bad');
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = provider.label;
    const meta = document.createElement('span');
    meta.className = 'pmeta';
    meta.textContent = provider.skippedReason ?? provider.lastError ?? provider.kind;
    meta.title = meta.textContent;
    row.append(dot, name, meta);
    providerList.append(row);
  }
}

async function load(): Promise<void> {
  try {
    const data = await sendRuntime<SettingsView>({ type: 'settings.get' });
    settings = data.settings;
    view = data.session;
    render();
    const tab = await activeTab();
    unsupported = Boolean(tab && !supportedUrl(tab.url));
    if (unsupported) {
      setNotice('当前页面不是普通网页，无法注入字幕。', true);
      startBtn.disabled = true;
    }
  } catch (err) {
    setNotice(`无法连接扩展后台：${String(err)}`, true);
  }
}

async function start(): Promise<void> {
  if (!settings || busy) return;
  busy = true;
  startBtn.disabled = true;
  setNotice('');
  try {
    const tab = await activeTab();
    if (!tab?.id) throw new Error('找不到当前标签页');
    if (!supportedUrl(tab.url)) throw new Error('当前页面不支持扩展字幕');

    const mode = modeSelect.value as Mode;
    let streamId = '';
    if (mode !== 'captions') {
      await sendRuntime({ type: 'session.prepare' });
      streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
          const error = chrome.runtime.lastError;
          if (error || !id) reject(new Error(error?.message ?? '无法捕获当前标签页音频'));
          else resolve(id);
        });
      });
    }
    const result = await sendRuntime<StartResult>({
      type: 'session.start',
      tabId: tab.id,
      streamId,
      mode,
    });
    if (!result?.ok) throw new Error(result?.error ?? '启动失败');
    await load();
  } catch (err) {
    setNotice(String(err instanceof Error ? err.message : err), true);
  } finally {
    busy = false;
    render();
  }
}

async function stop(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await sendRuntime({ type: 'session.stop' });
    await load();
  } catch (err) {
    setNotice(String(err instanceof Error ? err.message : err), true);
  } finally {
    busy = false;
    render();
  }
}

startBtn.addEventListener('click', () => void start());
stopBtn.addEventListener('click', () => void stop());
optionsLink.addEventListener('click', () => chrome.runtime.openOptionsPage());

modeSelect.addEventListener('change', async () => {
  if (!settings) return;
  const next: Settings = {
    ...settings,
    pipeline: { ...settings.pipeline, mode: modeSelect.value as Mode },
  };
  settings = next;
  try {
    const response = await sendRuntime<{ ok: boolean; settings?: Settings }>({
      type: 'settings.update',
      settings: next,
    });
    if (response?.settings) settings = response.settings;
  } catch {
    // The popup can still start with the chosen mode locally.
  }
});

void load();
pollTimer = setInterval(() => {
  void load().catch(() => undefined);
}, 1000);

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});
