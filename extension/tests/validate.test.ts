import { describe, expect, it } from 'vitest';
import { parseTranslations } from '../src/lib/translate/parse';
import { validateBatch } from '../src/lib/translate/validate';

describe('validateBatch', () => {
  it('accepts normal Chinese translations', () => {
    const parsed = parseTranslations('[{"i":1,"zh":"火车九点出发。"}]');
    const result = validateBatch(['The train leaves at nine.'], parsed, 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.translations[0]).toBe('火车九点出发。');
  });

  it('rejects missing lines', () => {
    const parsed = parseTranslations('[{"i":1,"zh":"你好"}]');
    const result = validateBatch(['One', 'Two'], parsed, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('缺少');
  });

  it('rejects English-only output for Chinese target', () => {
    const parsed = parseTranslations('[{"i":1,"zh":"The train leaves at nine."}]');
    const result = validateBatch(['The train leaves at nine.'], parsed, 'zh-CN');
    expect(result.ok).toBe(false);
  });

  it('rejects absurd length ratios', () => {
    const parsed = parseTranslations(`[{"i":1,"zh":"${'很'.repeat(200)}"}]`);
    const result = validateBatch(['Hi'], parsed, 'zh-CN');
    expect(result.ok).toBe(false);
  });
});
