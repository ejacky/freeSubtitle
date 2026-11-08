const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const KANA_RE = /[\u3040-\u30ff]/g;

export function cjkRatio(text: string): number {
  const matches = text.match(CJK_RE);
  if (!matches) return 0;
  const visible = text.replace(/\s+/g, '').length || 1;
  return matches.length / visible;
}

export function looksChinese(text: string, threshold = 0.3): boolean {
  // Kana is a strong Japanese signal. Japanese sentences can have enough
  // kanji to pass a naive CJK-ratio check, which used to skip translation.
  const kana = text.match(KANA_RE)?.length ?? 0;
  if (kana > 0) return false;
  return cjkRatio(text) >= threshold;
}

export function isChineseLanguage(language: string | undefined | null): boolean {
  if (!language) return false;
  return /^(zh|zho|chi|chinese|cmn|yue)/i.test(language.trim());
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Remove ` thinking...</think>` / `<thinking>...</thinking>` blocks from reasoning models. */
export function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
    .trim();
}

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return fence && fence[1] ? fence[1].trim() : trimmed;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

const NO_SPEECH_TAGS = [
  /^\[(music|applause|laughter|silence|beep|noise)\]$/i,
  /^\((music|applause|laughter|silence|beep|noise)\)$/i,
  /^music$/i,
  /^applause$/i,
];

const HALLUCINATION_LINES = [
  /^thank you(?: so much)? for watching\.?$/i,
  /^thanks for watching\.?$/i,
  /^subtitles? by .+$/i,
  /^transcribed by .+$/i,
  /^请不吝点赞.*$/,
  /^明镜与点点栏目$/,
];

export function isNoSpeech(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  if (NO_SPEECH_TAGS.some((re) => re.test(value))) return true;
  if (HALLUCINATION_LINES.some((re) => re.test(value))) return true;
  return false;
}

/** Collapse a repeated overlap between two ASR segments. */
export function dedupeOverlap(previous: string, next: string): string {
  if (!previous) return next;
  const a = previous.trim();
  const b = next.trim();
  if (!a || !b) return b;
  const max = Math.min(a.length, b.length, 40);
  for (let n = max; n >= 6; n--) {
    if (a.slice(-n) === b.slice(0, n)) return b.slice(n).trim();
  }
  return b;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 3.6);
}

export function truncateToApproxTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let value = text;
  while (value.length > 0 && estimateTokens(value) > maxTokens) {
    value = value.slice(0, Math.floor(value.length * 0.8));
  }
  return value.trim();
}
