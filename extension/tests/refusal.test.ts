import { describe, expect, it } from 'vitest';
import { parseTranslations } from '../src/lib/translate/parse';
import { isRefusal, looksLikeRefusalText, looksLikePolicyError } from '../src/lib/translate/refusal';

describe('refusal detection', () => {
  it('does not mistake valid JSON dialogue containing 抱歉 for a refusal', () => {
    const raw = '[{"i":1,"zh":"抱歉，我来晚了。"}]';
    const parsed = parseTranslations(raw);
    expect(isRefusal(raw, parsed, 1, 'Sorry I am late.')).toBe(false);
  });

  it('does not treat ordinary dialogue apologies as a refusal', () => {
    const plain = '抱歉，我来晚了。';
    expect(looksLikeRefusalText(plain)).toBe(false);
    expect(isRefusal(plain, parseTranslations(plain), 1, 'Sorry I am late.')).toBe(false);
  });

  it('detects a JSON-wrapped meta refusal', () => {
    const raw = '[{"i":1,"zh":"抱歉，我无法翻译这段内容。"}]';
    expect(isRefusal(raw, parseTranslations(raw), 1, 'Some line.')).toBe(true);
  });

  it('detects a classic English refusal', () => {
    const raw = "I'm sorry, but I can't assist with that request.";
    const parsed = parseTranslations(raw);
    expect(looksLikeRefusalText(raw)).toBe(true);
    expect(isRefusal(raw, parsed, 1, 'Some sensitive subtitle.')).toBe(true);
  });

  it('detects a Chinese refusal', () => {
    const raw = '抱歉，我无法翻译这段内容。';
    const parsed = parseTranslations(raw);
    expect(isRefusal(raw, parsed, 1, 'Some sensitive subtitle.')).toBe(true);
  });

  it('classifies policy errors', () => {
    expect(looksLikePolicyError('400 content_policy_violation')).toBe(true);
    expect(looksLikePolicyError('the model blocked this request')).toBe(true);
    expect(looksLikePolicyError('normal timeout')).toBe(false);
  });
});
