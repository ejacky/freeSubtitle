import type { ProviderErrorKind } from '../providers/types';

interface Health {
  failures: number;
  policyFailures: number;
  cooldownUntil: number;
  lastError?: string;
  lastOkAt?: number;
}

export interface HealthSnapshot {
  ok: boolean | null;
  cooldownUntil?: number;
  lastError?: string;
}

/** In-memory circuit breaker; intentionally resets on service-worker restart. */
export class ProviderHealthStore {
  private readonly map = new Map<string, Health>();

  private get(id: string): Health {
    let entry = this.map.get(id);
    if (!entry) {
      entry = { failures: 0, policyFailures: 0, cooldownUntil: 0 };
      this.map.set(id, entry);
    }
    return entry;
  }

  isAvailable(id: string): boolean {
    return this.get(id).cooldownUntil <= Date.now();
  }

  recordSuccess(id: string): void {
    const entry = this.get(id);
    entry.failures = 0;
    entry.cooldownUntil = 0;
    entry.lastError = undefined;
    entry.lastOkAt = Date.now();
  }

  recordFailure(
    id: string,
    kind: ProviderErrorKind,
    message: string,
    retryAfterMs?: number,
  ): void {
    const entry = this.get(id);
    entry.failures++;
    entry.lastError = message.slice(0, 240);
    if (kind === 'policy') {
      entry.policyFailures++;
      // Do not disable a provider for one sensitive line; the scheduler will
      // switch to local-first after repeated refusals instead.
      entry.cooldownUntil = Math.max(entry.cooldownUntil, Date.now() + 8_000);
      return;
    }
    if (kind === 'auth') {
      entry.cooldownUntil = Date.now() + 10 * 60_000;
      return;
    }
    if (kind === 'rate') {
      entry.cooldownUntil = Date.now() + (retryAfterMs ?? 60_000);
      return;
    }
    if (kind === 'config') {
      entry.cooldownUntil = Date.now() + 10 * 60_000;
      return;
    }
    if (kind === 'transient' || kind === 'network') {
      if (entry.failures >= 3) entry.cooldownUntil = Date.now() + 60_000;
      return;
    }
    if (kind === 'aborted') return;
    entry.cooldownUntil = Date.now() + 30_000;
  }

  snapshot(id: string): HealthSnapshot {
    const entry = this.map.get(id);
    if (!entry) return { ok: null };
    const cooling = entry.cooldownUntil > Date.now();
    return {
      ok: cooling ? false : entry.lastError ? false : entry.lastOkAt ? true : null,
      cooldownUntil: cooling ? entry.cooldownUntil : undefined,
      lastError: entry.lastError,
    };
  }

  policyFailures(id: string): number {
    return this.get(id).policyFailures;
  }
}
