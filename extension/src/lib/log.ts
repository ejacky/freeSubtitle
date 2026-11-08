export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  at: number;
  level: LogLevel;
  event: string;
  data?: unknown;
}

const MAX_ENTRIES = 300;
const entries: LogEntry[] = [];

const SECRET_WORDS = /(api[-_ ]?key|authorization|bearer|token|secret|password)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') {
    if (value.length > 400) return `${value.slice(0, 400)}…`;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_WORDS.test(key) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

export function log(level: LogLevel, event: string, data?: unknown): void {
  const entry: LogEntry = { at: Date.now(), level, event, data: redact(data) };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  if (level === 'error' || level === 'warn') {
    console[level](`[freeSubtitle] ${event}`, entry.data ?? '');
  } else {
    console.debug(`[freeSubtitle] ${event}`, entry.data ?? '');
  }
}

export function getLogs(): ReadonlyArray<LogEntry> {
  return entries;
}

export function clearLogs(): void {
  entries.length = 0;
}
