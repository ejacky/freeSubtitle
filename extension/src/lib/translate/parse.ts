import { stripCodeFence } from '../text';

export interface ParsedTranslations {
  byIndex: Map<number, string>;
  jsonValid: boolean;
  raw: string;
}

function cleanValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value.trim();
  text = text.replace(/^(?:zh|中文|译文|translation)\s*[:：]\s*/i, '').trim();
  text = text.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  text = text.replace(/\s*\n+\s*/g, ' ').trim();
  return text || undefined;
}

function fromArray(value: unknown[]): Map<number, string> {
  const map = new Map<number, string>();
  value.forEach((item, idx) => {
    if (typeof item === 'string') {
      const text = cleanValue(item);
      if (text) map.set(idx + 1, text);
      return;
    }
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, unknown>;
    const key = Number(obj.i ?? obj.index ?? obj.id ?? idx + 1);
    const text = cleanValue(obj.zh ?? obj.text ?? obj.translation ?? obj.value);
    if (Number.isFinite(key) && text) map.set(key, text);
  });
  return map;
}

function fromObject(value: Record<string, unknown>): Map<number, string> {
  const map = new Map<number, string>();
  const nested = value.translations;
  if (Array.isArray(nested)) return fromArray(nested);
  for (const [key, val] of Object.entries(value)) {
    const n = Number(key);
    const text = cleanValue(val);
    if (Number.isFinite(n) && text) map.set(n, text);
  }
  return map;
}

/** Tolerant parser: JSON array, {"translations":[...]}, object map, or numbered lines. */
export function parseTranslations(raw: string): ParsedTranslations {
  const cleaned = stripCodeFence(raw);
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      const byIndex = fromArray(parsed);
      if (byIndex.size > 0) return { byIndex, jsonValid: true, raw };
    } else if (parsed && typeof parsed === 'object') {
      const byIndex = fromObject(parsed as Record<string, unknown>);
      if (byIndex.size > 0) return { byIndex, jsonValid: true, raw };
    }
  } catch {
    // fall through to line parsing
  }

  const byIndex = new Map<number, string>();
  const lineRe = /^\s*(\d+)\s*[.、):：-]\s*(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(cleaned))) {
    const n = Number(match[1]);
    const text = cleanValue(match[2]);
    if (Number.isFinite(n) && text) byIndex.set(n, text);
  }

  // Last resort: a single line of prose is treated as line 1 if it looks like
  // a translation rather than a refusal (refusal detection happens separately).
  if (byIndex.size === 0) {
    const text = cleanValue(cleaned);
    if (text && text.length <= 500) byIndex.set(1, text);
  }

  return { byIndex, jsonValid: false, raw };
}
