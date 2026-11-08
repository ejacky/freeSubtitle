import type { SettingsView } from '../../types';
import type { ProviderConfig, Settings } from '../../lib/settings/schema';
import type {
  LocalTestResult,
  ProviderTestResult,
} from '../../lib/messaging/protocol';
import { sendRuntime } from '../../lib/messaging/protocol';

type Direction = 'translation' | 'asr';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const layout = $<HTMLSelectElement>('layout');
const position = $<HTMLSelectElement>('position');
const fontScale = $<HTMLInputElement>('fontScale');
const hideNative = $<HTMLInputElement>('hideNative');
const translationProviders = $<HTMLDivElement>('translationProviders');
const asrProviders = $<HTMLDivElement>('asrProviders');
const addTranslation = $<HTMLButtonElement>('addTranslation');
const addAsr = $<HTMLButtonElement>('addAsr');
const ollamaBaseUrl = $<HTMLInputElement>('ollamaBaseUrl');
const ollamaModel = $<HTMLInputElement>('ollamaModel');
const whisperBaseUrl = $<HTMLInputElement>('whisperBaseUrl');
const whisperModel = $<HTMLInputElement>('whisperModel');
const testLocalBtn = $<HTMLButtonElement>('testLocal');
const localTestResult = $<HTMLSpanElement>('localTestResult');
const localFirst = $<HTMLInputElement>('localFirst');
const switchThreshold = $<HTMLInputElement>('switchThreshold');
const showOriginalOnFail = $<HTMLInputElement>('showOriginalOnFail');
const consent = $<HTMLInputElement>('consent');
const debugText = $<HTMLInputElement>('debugText');
const clearCacheBtn = $<HTMLButtonElement>('clearCache');
const exportLogsBtn = $<HTMLButtonElement>('exportLogs');
const cacheState = $<HTMLSpanElement>('cacheState');
const saveBtn = $<HTMLButtonElement>('saveBtn');
const saveState = $<HTMLSpanElement>('saveState');
const toast = $<HTMLDivElement>('toast');

let settings: Settings;
let secretsPresence: Record<string, boolean> = {};
let pendingSecrets: Record<string, string> = {};
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(message: string, error = false): void {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3800);
}

function kindLabel(kind: ProviderConfig['kind']): string {
  switch (kind) {
    case 'openai-chat':
      return 'OpenAI 兼容';
    case 'ollama-native':
      return 'Ollama';
    case 'openai-asr':
      return 'OpenAI ASR';
    case 'local-whisper':
      return '本地 Whisper';
    case 'mock':
      return 'Mock';
    default:
      return kind;
  }
}

function secretPlaceholder(storageKey?: string): string {
  if (!storageKey) return '';
  return secretsPresence[storageKey] ? '已保存，留空不修改' : '未设置';
}

function providerRow(
  provider: ProviderConfig,
  direction: Direction,
  index: number,
  total: number,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = `provider-row${provider.enabled ? '' : ' disabled'}`;
  row.dataset.id = provider.id;
  row.dataset.direction = direction;

  const top = document.createElement('div');
  top.className = 'provider-top';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = provider.enabled;
  enabled.dataset.field = 'enabled';
  enabled.title = '启用';

  const name = document.createElement('input');
  name.className = 'name';
  name.value = provider.label;
  name.dataset.field = 'label';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = kindLabel(provider.kind);

  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'mini';
  up.textContent = '↑';
  up.dataset.action = 'up';
  up.disabled = index === 0;

  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'mini';
  down.textContent = '↓';
  down.dataset.action = 'down';
  down.disabled = index === total - 1;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'mini';
  remove.textContent = '删除';
  remove.dataset.action = 'remove';

  top.append(enabled, name, badge, up, down, remove);

  const grid = document.createElement('div');
  grid.className = 'provider-grid';

  const baseField = field('Base URL', 'url', provider.baseUrl, 'baseUrl');
  const modelField = field('模型', 'text', provider.model, 'model');
  grid.append(baseField, modelField);

  if (provider.apiKeyStorageKey) {
    const key = document.createElement('input');
    key.type = 'password';
    key.autocomplete = 'off';
    key.placeholder = secretPlaceholder(provider.apiKeyStorageKey);
    key.dataset.field = 'apiKey';
    key.dataset.secretKey = provider.apiKeyStorageKey;
    key.value = '';
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const label = document.createElement('span');
    label.textContent = 'API Key';
    wrap.append(label, key);
    grid.append(wrap);
  } else {
    const spacer = document.createElement('div');
    grid.append(spacer);
  }

  if (provider.kind === 'openai-chat') {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const label = document.createElement('span');
    label.textContent = 'Reasoning';
    const select = document.createElement('select');
    select.dataset.field = 'reasoningEffort';
    for (const value of ['', 'none', 'low', 'medium', 'high']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value || '默认';
      if ((provider.reasoningEffort ?? '') === value) option.selected = true;
      select.append(option);
    }
    wrap.append(label, select);
    grid.append(wrap);
  } else {
    grid.append(document.createElement('div'));
  }

  const actions = document.createElement('div');
  actions.className = 'provider-actions';
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'mini';
  test.textContent = '测试';
  test.dataset.action = 'test';
  const status = document.createElement('span');
  status.className = 'status';
  actions.append(test, status);

  row.append(top, grid, actions);
  return row;
}

function field(
  labelText: string,
  type: string,
  value: string,
  fieldName: string,
): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const label = document.createElement('span');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  input.dataset.field = fieldName;
  wrap.append(label, input);
  return wrap;
}

function renderProviders(direction: Direction): void {
  const container = direction === 'translation' ? translationProviders : asrProviders;
  container.textContent = '';
  const list = settings.providers[direction];
  list.forEach((provider, index) => {
    container.append(providerRow(provider, direction, index, list.length));
  });
}

function syncFromDom(direction: Direction): void {
  const container = direction === 'translation' ? translationProviders : asrProviders;
  const list = settings.providers[direction];
  for (const row of Array.from(container.querySelectorAll<HTMLDivElement>('.provider-row'))) {
    const provider = list.find((item) => item.id === row.dataset.id);
    if (!provider) continue;
    const enabled = row.querySelector<HTMLInputElement>('[data-field="enabled"]');
    const label = row.querySelector<HTMLInputElement>('[data-field="label"]');
    const base = row.querySelector<HTMLInputElement>('[data-field="baseUrl"]');
    const model = row.querySelector<HTMLInputElement>('[data-field="model"]');
    const reasoning = row.querySelector<HTMLSelectElement>('[data-field="reasoningEffort"]');
    const key = row.querySelector<HTMLInputElement>('[data-field="apiKey"]');
    provider.enabled = enabled?.checked ?? provider.enabled;
    provider.label = label?.value.trim() || provider.label;
    provider.baseUrl = base?.value.trim() || provider.baseUrl;
    provider.model = model?.value.trim() || provider.model;
    if (reasoning) {
      const value = reasoning.value;
      provider.reasoningEffort = value
        ? (value as ProviderConfig['reasoningEffort'])
        : undefined;
    }
    if (key?.value.trim() && provider.apiKeyStorageKey) {
      pendingSecrets[provider.apiKeyStorageKey] = key.value.trim();
      secretsPresence[provider.apiKeyStorageKey] = true;
      key.value = '';
      key.placeholder = '已保存，留空不修改';
    }
  }
}

function readForm(): Settings {
  syncFromDom('translation');
  syncFromDom('asr');
  settings.output.layout = layout.value as Settings['output']['layout'];
  settings.output.position = position.value as Settings['output']['position'];
  settings.output.fontScale = Number(fontScale.value) || 1;
  settings.output.hideNative = hideNative.checked;
  settings.local.ollamaBaseUrl = ollamaBaseUrl.value.trim();
  settings.local.ollamaModel = ollamaModel.value.trim();
  settings.local.whisperBaseUrl = whisperBaseUrl.value.trim();
  settings.local.whisperModel = whisperModel.value.trim();
  settings.contentPolicy.localFirst = localFirst.checked;
  settings.contentPolicy.switchToLocalAfter = Math.max(
    1,
    Number(switchThreshold.value) || 3,
  );
  settings.contentPolicy.showOriginalOnFail = showOriginalOnFail.checked;
  settings.privacy.consentAccepted = consent.checked;
  settings.privacy.debugText = debugText.checked;

  // The local endpoint/model fields are authoritative; keep the provider rows
  // in sync so the UI does not show stale values.
  for (const provider of settings.providers.translation) {
    if (provider.kind === 'ollama-native') {
      provider.baseUrl = settings.local.ollamaBaseUrl;
      provider.model = settings.local.ollamaModel;
    }
  }
  for (const provider of settings.providers.asr) {
    if (provider.kind === 'local-whisper') {
      provider.baseUrl = `${settings.local.whisperBaseUrl.replace(/\/+$/, '')}/v1`;
      provider.model = settings.local.whisperModel;
    }
  }
  return settings;
}

function customOrigins(next: Settings): string[] {
  const origins = new Set<string>();
  for (const provider of [...next.providers.translation, ...next.providers.asr]) {
    if (!provider.enabled) continue;
    if (provider.apiKeyStorageKey) {
      const hasKey =
        Boolean(secretsPresence[provider.apiKeyStorageKey]) ||
        Boolean(pendingSecrets[provider.apiKeyStorageKey]);
      if (!hasKey) continue;
    }
    try {
      const url = new URL(provider.baseUrl);
      if (
        url.hostname === 'opencode.ai' ||
        url.hostname === 'api.groq.com' ||
        url.hostname === 'api.openai.com'
      ) {
        continue;
      }
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') continue;
      origins.add(`${url.origin}/*`);
    } catch {
      // Invalid URL is reported by validation.
    }
  }
  return [...origins];
}

function validateSettings(next: Settings): void {
  const urls: string[] = [next.local.ollamaBaseUrl, next.local.whisperBaseUrl];
  for (const provider of [...next.providers.translation, ...next.providers.asr]) {
    urls.push(provider.baseUrl);
    if (!provider.baseUrl.trim()) throw new Error(`服务「${provider.label}」缺少 Base URL`);
    if (!provider.model.trim()) throw new Error(`服务「${provider.label}」缺少模型名`);
  }
  for (const value of urls) {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error(`不支持的协议：${value}`);
  }
}

async function save(options: { silent?: boolean } = {}): Promise<boolean> {
  try {
    const next = readForm();
    validateSettings(next);

    const origins = customOrigins(next);
    if (origins.length > 0) {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) throw new Error('未授予自定义服务域名权限，设置未保存');
    }

    saveState.textContent = '保存中…';
    const response = await sendRuntime<{ ok: boolean; settings?: Settings; error?: string }>({
      type: 'settings.update',
      settings: next,
      secrets: pendingSecrets,
    });
    if (!response?.ok) throw new Error(response?.error ?? '保存失败');
    if (response.settings) settings = response.settings;
    pendingSecrets = {};
    secretsPresence = (await sendRuntime<SettingsView>({ type: 'settings.get' })).secrets;
    saveState.textContent = '已保存';
    if (!options.silent) showToast('设置已保存');
    renderProviders('translation');
    renderProviders('asr');
    return true;
  } catch (err) {
    saveState.textContent = '保存失败';
    showToast(String(err instanceof Error ? err.message : err), true);
    return false;
  }
}

async function testProvider(
  direction: Direction,
  id: string,
  statusEl: HTMLSpanElement,
): Promise<void> {
  statusEl.textContent = '测试中…';
  const saved = await save({ silent: true });
  if (!saved) {
    statusEl.textContent = '保存后测试失败';
    return;
  }
  const container = direction === 'translation' ? translationProviders : asrProviders;
  const freshStatus = container.querySelector<HTMLSpanElement>(
    `.provider-row[data-id="${id}"] .status`,
  );
  if (freshStatus) statusEl = freshStatus;
  statusEl.textContent = '测试中…';
  try {
    const result = await sendRuntime<ProviderTestResult>({
      type: 'provider.test',
      providerId: id,
      direction,
    });
    statusEl.textContent = result.ok
      ? `正常${result.latencyMs ? ` · ${result.latencyMs}ms` : ''}`
      : result.message;
  } catch (err) {
    statusEl.textContent = String(err instanceof Error ? err.message : err);
  }
}

function bindProviderActions(direction: Direction): void {
  const container = direction === 'translation' ? translationProviders : asrProviders;
  container.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLButtonElement>('[data-action]');
    if (!button) return;
    const row = button.closest<HTMLDivElement>('.provider-row');
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;

    syncFromDom(direction);
    const list = settings.providers[direction];
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) return;

    if (button.dataset.action === 'remove') {
      if (!window.confirm(`删除「${list[index]!.label}」？`)) return;
      list.splice(index, 1);
      renderProviders(direction);
      return;
    }
    if (button.dataset.action === 'up' && index > 0) {
      const [item] = list.splice(index, 1);
      list.splice(index - 1, 0, item!);
      renderProviders(direction);
      return;
    }
    if (button.dataset.action === 'down' && index < list.length - 1) {
      const [item] = list.splice(index, 1);
      list.splice(index + 1, 0, item!);
      renderProviders(direction);
      return;
    }
    if (button.dataset.action === 'test') {
      const status = row.querySelector<HTMLSpanElement>('.status');
      if (status) void testProvider(direction, id, status);
    }
  });
}

function addProvider(direction: Direction): void {
  syncFromDom(direction);
  if (direction === 'translation') {
    const id = `custom-${Date.now()}`;
    settings.providers.translation.push({
      id,
      kind: 'openai-chat',
      label: '自定义翻译服务',
      baseUrl: 'https://api.example.com/v1',
      model: '',
      apiKeyStorageKey: `custom-${id}`,
      supportsTemperature: true,
      enabled: true,
    });
  } else {
    const id = `custom-asr-${Date.now()}`;
    settings.providers.asr.push({
      id,
      kind: 'openai-asr',
      label: '自定义 ASR 服务',
      baseUrl: 'https://api.example.com/v1',
      model: '',
      apiKeyStorageKey: `custom-${id}`,
      enabled: true,
    });
  }
  renderProviders(direction);
}

async function testLocal(): Promise<void> {
  localTestResult.textContent = '测试中…';
  try {
    const result = await sendRuntime<LocalTestResult>({ type: 'local.test' });
    const parts = [
      result.ollama ? `Ollama：${result.ollama.message}` : '',
      result.whisper ? `Whisper：${result.whisper.message}` : '',
    ].filter(Boolean);
    localTestResult.textContent = parts.join('；');
  } catch (err) {
    localTestResult.textContent = String(err instanceof Error ? err.message : err);
  }
}

async function init(): Promise<void> {
  try {
    const data = await sendRuntime<SettingsView>({ type: 'settings.get' });
    settings = data.settings;
    secretsPresence = data.secrets;

    layout.value = settings.output.layout;
    position.value = settings.output.position;
    fontScale.value = String(settings.output.fontScale);
    hideNative.checked = settings.output.hideNative;
    ollamaBaseUrl.value = settings.local.ollamaBaseUrl;
    ollamaModel.value = settings.local.ollamaModel;
    whisperBaseUrl.value = settings.local.whisperBaseUrl;
    whisperModel.value = settings.local.whisperModel;
    localFirst.checked = settings.contentPolicy.localFirst;
    switchThreshold.value = String(settings.contentPolicy.switchToLocalAfter);
    showOriginalOnFail.checked = settings.contentPolicy.showOriginalOnFail;
    consent.checked = settings.privacy.consentAccepted;
    debugText.checked = settings.privacy.debugText;
    cacheState.textContent = `缓存上限 ${settings.cache.maxEntries} 条 / ${settings.cache.ttlDays} 天`;

    renderProviders('translation');
    renderProviders('asr');
    bindProviderActions('translation');
    bindProviderActions('asr');
  } catch (err) {
    showToast(`读取设置失败：${String(err)}`, true);
  }
}

saveBtn.addEventListener('click', () => void save());
addTranslation.addEventListener('click', () => addProvider('translation'));
addAsr.addEventListener('click', () => addProvider('asr'));
testLocalBtn.addEventListener('click', () => void testLocal());
exportLogsBtn.addEventListener('click', async () => {
  try {
    const data = await sendRuntime<{ logs: unknown[] }>({ type: 'logs.get' });
    const text = JSON.stringify(data.logs, null, 2);
    await navigator.clipboard.writeText(text);
    showToast('诊断日志已复制（不含字幕正文）');
  } catch (err) {
    showToast(`复制失败：${String(err instanceof Error ? err.message : err)}`, true);
  }
});

clearCacheBtn.addEventListener('click', async () => {
  try {
    await sendRuntime({ type: 'cache.clear' });
    cacheState.textContent = '翻译缓存已清空';
    showToast('缓存已清空');
  } catch (err) {
    showToast(String(err instanceof Error ? err.message : err), true);
  }
});

void init();
