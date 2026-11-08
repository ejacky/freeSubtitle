import type { ProviderConfig } from '../settings/schema';
import {
  ProviderError,
  providerErrorFromResponse,
  type ChatDelta,
  type ChatProvider,
  type ChatRequest,
  type ChatUsage,
} from './types';

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

function renderHeaders(cfg: ProviderConfig, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  for (const [key, value] of Object.entries(cfg.headers ?? {})) {
    headers[key] = value.replace(/\{\{sessionId\}\}/g, sessionId ?? '');
  }
  return headers;
}

function parseUsage(value: unknown): ChatUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? NaN);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? NaN);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  return {
    inputTokens: Number.isFinite(input) ? input : undefined,
    outputTokens: Number.isFinite(output) ? output : undefined,
  };
}

/**
 * OpenAI-compatible chat completions with SSE streaming.
 * The API key is injected by ProviderRegistry via {@link withApiKey}.
 */
export class OpenAIChatProvider implements ChatProvider {
  readonly id: string;
  readonly label: string;

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly apiKey?: string,
  ) {
    this.id = cfg.id;
    this.label = cfg.label;
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatDelta> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages,
      stream: true,
      max_tokens: req.maxTokens ?? 800,
      ...(this.cfg.supportsTemperature === false ? {} : { temperature: req.temperature ?? 0.2 }),
      ...(this.cfg.reasoningEffort ? { reasoning_effort: this.cfg.reasoningEffort } : {}),
      ...(this.cfg.extraBody ?? {}),
    };

    let res: Response;
    try {
      res = await fetch(`${trimBase(this.cfg.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          ...renderHeaders(this.cfg, req.sessionId),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ProviderError('aborted', '请求已取消', { providerId: this.id, cause: err });
      }
      throw new ProviderError('network', '网络请求失败', {
        providerId: this.id,
        cause: err,
        detail: String(err),
      });
    }

    if (!res.ok) throw await providerErrorFromResponse(res, this.id);

    // Some gateways ignore stream=true and return a normal JSON completion.
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json = (await res.json()) as Record<string, unknown>;
      const choices = Array.isArray(json.choices) ? json.choices : [];
      const message = (choices[0] as Record<string, unknown> | undefined)?.message as
        | Record<string, unknown>
        | undefined;
      const content = typeof message?.content === 'string' ? message.content : '';
      if (content) yield { content };
      yield { done: true, usage: parseUsage(json.usage) };
      return;
    }

    if (!res.body) throw new ProviderError('transient', '响应没有 body', { providerId: this.id });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: ChatUsage | undefined;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line; tolerate CRLF and lone LF.
        let splitAt = buffer.search(/\r?\n\r?\n/);
        while (splitAt !== -1) {
          const rawEvent = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt).replace(/^\r?\n\r?\n/, '');
          const delta = this.parseEvent(rawEvent);
          if (delta) {
            if (delta.usage) usage = { ...usage, ...delta.usage };
            if (delta.content) yield { content: delta.content };
            if (delta.done) {
              yield { done: true, usage };
              return;
            }
          }
          splitAt = buffer.search(/\r?\n\r?\n/);
        }
      }

      // Some gateways close the stream without a trailing blank line.
      if (buffer.trim()) {
        const delta = this.parseEvent(buffer);
        if (delta?.content) yield { content: delta.content };
        if (delta?.usage) usage = { ...usage, ...delta.usage };
      }
      yield { done: true, usage };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ProviderError('aborted', '请求已取消', { providerId: this.id, cause: err });
      }
      throw new ProviderError('transient', '读取流式响应失败', {
        providerId: this.id,
        cause: err,
        detail: String(err),
      });
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  }

  private parseEvent(raw: string): ChatDelta | null {
    const dataLines = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return { done: true };

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.error) {
      const error = obj.error as Record<string, unknown>;
      const message = String(error.message ?? '上游返回错误');
      const isPolicy = /(policy|safety|moderation|blocked|violat|敏感|违规)/i.test(message);
      throw new ProviderError(isPolicy ? 'policy' : 'transient', message, {
        providerId: this.id,
        detail: message,
      });
    }

    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    const content = typeof delta?.content === 'string' ? delta.content : undefined;
    const usage = parseUsage(obj.usage);
    const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
    return { content, usage, done: finish === 'stop' && !content ? true : undefined };
  }
}
