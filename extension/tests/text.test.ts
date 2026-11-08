import { describe, expect, it } from 'vitest';
import { dedupeOverlap, isNoSpeech, stripThinkBlocks, looksChinese, isChineseLanguage } from '../src/lib/text';

describe('text helpers', () => {
  it('strips reasoning blocks', () => {
    expect(stripThinkBlocks('<think>reason</think>你好')).toBe('你好');
  });

  it('detects Chinese', () => {
    expect(looksChinese('这是一个中文字幕')).toBe(true);
    expect(looksChinese('This is English')).toBe(false);
  });

  it('does not mistake Japanese kanji for Chinese', () => {
    expect(looksChinese('これは日本語の字幕です')).toBe(false);
    expect(looksChinese('日本語の字幕を翻訳する')).toBe(false);
    expect(isChineseLanguage('ja')).toBe(false);
    expect(isChineseLanguage('japanese')).toBe(false);
    expect(isChineseLanguage('zh-CN')).toBe(true);
    expect(isChineseLanguage('chinese')).toBe(true);
  });

  it('filters ASR hallucinations', () => {
    expect(isNoSpeech('[Music]')).toBe(true);
    expect(isNoSpeech('Thank you for watching.')).toBe(true);
    expect(isNoSpeech('The train leaves at nine.')).toBe(false);
  });

  it('dedupes overlapping ASR text', () => {
    expect(dedupeOverlap('the quick brown fox', 'brown fox jumps')).toBe('jumps');
    expect(dedupeOverlap('hello', 'completely new')).toBe('completely new');
  });
});
