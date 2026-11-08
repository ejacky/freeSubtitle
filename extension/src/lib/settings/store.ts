import { DEFAULT_SETTINGS, mergeSettings } from './defaults';
import type { ProviderConfig, Settings } from './schema';

const SETTINGS_KEY = 'settings';
const SECRETS_KEY = 'secrets';

export type Secrets = Record<string, string>;

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(got[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  const normalized = mergeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
}

export async function loadSecrets(): Promise<Secrets> {
  const got = await chrome.storage.local.get(SECRETS_KEY);
  const value = got[SECRETS_KEY];
  return value && typeof value === 'object' ? (value as Secrets) : {};
}

export async function saveSecrets(secrets: Secrets): Promise<void> {
  await chrome.storage.local.set({ [SECRETS_KEY]: secrets });
}

export async function setSecret(key: string, value: string): Promise<void> {
  const secrets = await loadSecrets();
  if (value) secrets[key] = value;
  else delete secrets[key];
  await saveSecrets(secrets);
}

export function secretFor(provider: ProviderConfig, secrets: Secrets): string | undefined {
  if (!provider.apiKeyStorageKey) return undefined;
  return secrets[provider.apiKeyStorageKey] || undefined;
}

export async function secretsPresence(): Promise<Record<string, boolean>> {
  const secrets = await loadSecrets();
  return Object.fromEntries(Object.keys(secrets).map((key) => [key, Boolean(secrets[key])]));
}

/**
 * Content scripts should never be able to read API keys. This restricts
 * chrome.storage.local to trusted extension contexts.
 */
export async function restrictStorageAccess(): Promise<void> {
  try {
    const storage = chrome.storage.local as unknown as {
      setAccessLevel?: (opts: { accessLevel: string }) => Promise<void>;
    };
    await storage.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older Chrome: best effort only.
  }
}

export async function resetSettings(): Promise<Settings> {
  const settings = mergeSettings(DEFAULT_SETTINGS);
  await saveSettings(settings);
  return settings;
}
