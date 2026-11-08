export type ProviderErrorKind =
  | 'auth'
  | 'rate'
  | 'policy'
  | 'transient'
  | 'invalid'
  | 'network'
  | 'aborted'
  | 'config';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly providerId?: string;
  readonly detail?: string;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts: {
      status?: number;
      retryAfterMs?: number;
      providerId?: string;
      detail?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.providerId = opts.providerId;
    this.detail = opts.detail;
    if (opts.cause !== undefined) (this as Error & { cause?: unknown }).cause = opts.cause;
  }
}

const POLICY_WORDS =
  /(content[_ -]?policy|safety|moderation|blocked|violat|disallowed|policy violation|敏感|违规|不安全)/i;
const AUTH_WORDS = /(invalid credential|unauthorized|authentication|api key|incorrect api key)/i;

export async function providerErrorFromResponse(
  res: Response,
  providerId: string,
): Promise<ProviderError> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 4000);
  } catch {
    // ignore
  }
  const retryAfter = Number(res.headers.get('retry-after') ?? '');
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  const status = res.status;
  const detail = body.slice(0, 800);

  if (status === 401 || status === 403) {
    return new ProviderError('auth', `鉴权失败 (${status})`, {
      status,
      providerId,
      detail,
    });
  }
  if (status === 429) {
    return new ProviderError('rate', '请求过于频繁 (429)', {
      status,
      providerId,
      retryAfterMs: retryAfterMs ?? 60_000,
      detail,
    });
  }
  if (status === 400 || status === 422) {
    if (POLICY_WORDS.test(body)) {
      return new ProviderError('policy', '内容审核拒绝', { status, providerId, detail });
    }
    return new ProviderError('invalid', `请求无效 (${status})`, { status, providerId, detail });
  }
  if (status >= 500) {
    return new ProviderError('transient', `服务端错误 (${status})`, {
      status,
      providerId,
      retryAfterMs,
      detail,
    });
  }
  if (POLICY_WORDS.test(body)) {
    return new ProviderError('policy', '内容审核拒绝', { status, providerId, detail });
  }
  if (AUTH_WORDS.test(body)) {
    return new ProviderError('auth', '鉴权失败', { status, providerId, detail });
  }
  return new ProviderError('invalid', `请求失败 (${status})`, { status, providerId, detail });
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  sessionId?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatDelta {
  content?: string;
  usage?: ChatUsage;
  done?: boolean;
}

export interface ChatProvider {
  id: string;
  label: string;
  chat(req: ChatRequest): AsyncGenerator<ChatDelta>;
}

export interface AsrRequest {
  wav: ArrayBuffer;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export interface AsrResult {
  text: string;
  language?: string;
  durationMs?: number;
}

export interface AsrProvider {
  id: string;
  label: string;
  transcribe(req: AsrRequest): Promise<AsrResult>;
}

export async function collectChat(
  provider: ChatProvider,
  req: ChatRequest,
): Promise<{ text: string; usage?: ChatUsage }> {
  let text = '';
  let usage: ChatUsage | undefined;
  for await (const delta of provider.chat(req)) {
    if (delta.content) text += delta.content;
    if (delta.usage) usage = { ...usage, ...delta.usage };
    if (delta.done) break;
  }
  return { text, usage };
}

export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return true;
  return err.kind === 'transient' || err.kind === 'network' || err.kind === 'rate';
}
