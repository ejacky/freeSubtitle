import { cjkRatio } from '../text';
import type { ParsedTranslations } from './parse';

/**
 * "Meta refusals" only. Do NOT include bare "抱歉" / "I'm sorry": those are
 * perfectly normal subtitle dialogue. The model must say it cannot translate
 * (or cite a content policy) to be treated as a refusal.
 */
const META_REFUSAL_PATTERNS: RegExp[] = [
  /(?:无法|不能|没法|拒绝)(?:翻译|协助|提供|处理|完成)/,
  /(?:抱歉|对不起)[，,。！!\s]*(?:我)?(?:无法|不能|没法)/,
  /(?:cannot|can't|can not|unable to|won't)\s+(?:translate|assist|help|comply|provide|process)/i,
  /(?:i'm|i am)\s+(?:sorry|unable)[^.]{0,40}(?:cannot|can't|unable)/i,
  /content\s+(?:policy|guidelines?|moderation)/i,
  /(?:violates?|against)\s+(?:our|the)\s+(?:policy|guidelines|terms)/i,
  /as an ai\b/i,
  /(?:policy|safety|moderation)\s+(?:violation|blocked|refusal)/i,
];

export function looksLikeRefusalText(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return META_REFUSAL_PATTERNS.some((re) => re.test(value));
}

/**
 * A response is a refusal if any translated value is a meta refusal, or if the
 * raw response is a meta refusal. Ordinary dialogue containing "抱歉/对不起"
 * is explicitly allowed.
 */
export function isRefusal(
  raw: string,
  parsed: ParsedTranslations,
  expected: number,
  _sourceText: string,
): boolean {
  const values = [...parsed.byIndex.values()];
  if (values.some((value) => looksLikeRefusalText(value))) return true;

  let complete = parsed.byIndex.size >= expected;
  for (let i = 1; i <= expected; i++) {
    if (!parsed.byIndex.get(i)) {
      complete = false;
      break;
    }
  }
  if (parsed.jsonValid && complete) return false;

  if (looksLikeRefusalText(raw) && (cjkRatio(raw) < 0.1 || raw.length < 120)) return true;
  return false;
}

export function looksLikePolicyError(message: string): boolean {
  return /(content[_ -]?policy|safety|moderation|blocked|violat|disallowed|敏感|违规|不安全)/i.test(
    message,
  );
}
