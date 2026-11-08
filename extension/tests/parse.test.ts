import { describe, expect, it } from 'vitest';
import { parseTranslations } from '../src/lib/translate/parse';

describe('parseTranslations', () => {
  it('parses a JSON array', () => {
    const parsed = parseTranslations('[{"i":1,"zh":"你好"},{"i":2,"zh":"世界"}]');
    expect(parsed.jsonValid).toBe(true);
    expect(parsed.byIndex.get(1)).toBe('你好');
    expect(parsed.byIndex.get(2)).toBe('世界');
  });

  it('parses a translations wrapper and code fence', () => {
    const parsed = parseTranslations('```json\n{"translations":[{"i":1,"zh":"火车九点出发"}]}\n```');
    expect(parsed.jsonValid).toBe(true);
    expect(parsed.byIndex.get(1)).toBe('火车九点出发');
  });

  it('parses numbered lines when JSON is invalid', () => {
    const parsed = parseTranslations('1. 你好\n2、世界');
    expect(parsed.jsonValid).toBe(false);
    expect(parsed.byIndex.get(1)).toBe('你好');
    expect(parsed.byIndex.get(2)).toBe('世界');
  });

  it('accepts string arrays and strips labels', () => {
    const parsed = parseTranslations('["zh: 你好", "世界"]');
    expect(parsed.byIndex.get(1)).toBe('你好');
    expect(parsed.byIndex.get(2)).toBe('世界');
  });

  it('returns empty map for empty output', () => {
    const parsed = parseTranslations('');
    expect(parsed.byIndex.size).toBe(0);
  });
});
