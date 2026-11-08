import { describe, expect, it } from 'vitest';
import { makeCacheKey } from '../src/lib/translate/cache';

describe('makeCacheKey', () => {
  it('is deterministic and context-sensitive', async () => {
    const a = await makeCacheKey({
      version: 1,
      targetLang: 'zh-CN',
      source: 'Hello world',
      context: ['Before'],
    });
    const b = await makeCacheKey({
      version: 1,
      targetLang: 'zh-CN',
      source: 'Hello world',
      context: ['Before'],
    });
    const c = await makeCacheKey({
      version: 1,
      targetLang: 'zh-CN',
      source: 'Hello world',
      context: ['Different'],
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(a).not.toBe(c);
  });

  it('normalizes whitespace', async () => {
    const a = await makeCacheKey({ version: 1, targetLang: 'zh-CN', source: 'Hello   world' });
    const b = await makeCacheKey({ version: 1, targetLang: 'zh-CN', source: ' Hello world ' });
    expect(a).toBe(b);
  });
});
