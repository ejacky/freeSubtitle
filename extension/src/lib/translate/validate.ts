import { cjkRatio, looksChinese } from '../text';
import type { ParsedTranslations } from './parse';

export interface ValidationResult {
  ok: boolean;
  translations: string[];
  reasons: string[];
}

export function validateBatch(
  sources: string[],
  parsed: ParsedTranslations,
  targetLang: string,
): ValidationResult {
  const translations: string[] = [];
  const reasons: string[] = [];

  sources.forEach((source, index) => {
    const i = index + 1;
    const value = parsed.byIndex.get(i);
    if (!value) {
      reasons.push(`缺少第 ${i} 条`);
      translations.push('');
      return;
    }
    const compact = value.replace(/\s+/g, '');
    if (!compact) {
      reasons.push(`第 ${i} 条为空`);
      translations.push('');
      return;
    }
    if (compact.length > 2000) {
      reasons.push(`第 ${i} 条过长`);
      translations.push('');
      return;
    }

    const sourceCompact = source.replace(/\s+/g, '');
    const ratio = compact.length / Math.max(1, sourceCompact.length);
    if (ratio > 3.5 || ratio < 0.12) {
      reasons.push(`第 ${i} 条长度异常 (${ratio.toFixed(2)})`);
      translations.push('');
      return;
    }

    if (targetLang.startsWith('zh')) {
      const sourceCjk = cjkRatio(source);
      const words = source.trim().split(/\s+/).filter(Boolean);
      const isShortProperNoun =
        words.length > 0 &&
        words.length <= 3 &&
        words.every((word) => /^[A-Z0-9][A-Za-z0-9.&'-]*$/.test(word)) &&
        compact.toLowerCase() === sourceCompact.toLowerCase();
      if (
        !looksChinese(value, 0.12) &&
        sourceCjk < 0.2 &&
        !/[0-9]/.test(compact) &&
        !isShortProperNoun
      ) {
        reasons.push(`第 ${i} 条不像中文`);
        translations.push('');
        return;
      }
    }

    translations.push(value);
  });

  return { ok: reasons.length === 0 && translations.every(Boolean), translations, reasons };
}

export function looksLikeTranslation(text: string, targetLang: string): boolean {
  if (!text.trim()) return false;
  if (!targetLang.startsWith('zh')) return true;
  return looksChinese(text, 0.12);
}
