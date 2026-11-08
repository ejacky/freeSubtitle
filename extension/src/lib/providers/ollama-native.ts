import type { ProviderConfig } from '../settings/schema';
import {
  ProviderError,
  type ChatDelta,
  type ChatProvider,
  type ChatRequest,
  type ChatUsage,
} from './types';

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Ollama native /api/chat. Used instead of the OpenAI-compatible endpoint so we
 * can pin num_thread=4 on this 15 W CPU (8 threads is dramatically slower).
 */
export class OllamaNativeProvider implements ChatProvider {
  readonly id: string;
  readonly label: string;

  constructor(private readonly cfg: ProviderConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatDelta> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages,
      stream: true,
      keep_alive: '30m',
      options: {
        temperature: req.temperature ?? 0.2,
        num_ctx: 2048,
        num_thread: 4,
        ...(this.cfg.extraBody ?? {}),
      },
    };

    let res: Response;
    try {
      res = await fetch(`${trimBase(this.cfg.baseUrl)}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ProviderError('aborted', '请求已取消', { providerId: this.id, cause: err });
      }
      throw new ProviderError('network', '无法连接本地 Ollama', {
        providerId: this.id,
        cause: err,
        detail: `${String(err)}。请确认 ollama serve 已启动，并设置 OLLAMA_ORIGINS=chrome-extension://*。`,
      });
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 800);
      } catch {
        // ignore
      }
      if (res.status === 404) {
        throw new ProviderError('config', `本地没有模型 ${this.cfg.model}，请先 ollama pull`, {
          status: 404,
          providerId: this.id,
          detail,
        });
      }
      if (res.status === 403) {
        throw new ProviderError(
          'config',
          'Ollama 拒绝扩展 Origin（403）；请用 OLLAMA_ORIGINS=chrome-extension://* 重启 Ollama',
          { status: 403, providerId: this.id, detail },
        );
      }
      throw new ProviderError('transient', `Ollama 返回 ${res.status}`, {
        status: res.status,
        providerId: this.id,
        detail,
      });
    }
    if (!res.body) throw new ProviderError('transient', 'Ollama 响应没有 body', { providerId: this.id });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: ChatUsage | undefined;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const delta = this.parseLine(line, usage);
            if (delta?.usage) usage = { ...usage, ...delta.usage };
            if (delta?.content) yield { content: delta.content };
            if (delta?.done) {
              yield { done: true, usage };
              return;
            }
          }
          newline = buffer.indexOf('\n');
        }
      }
      if (buffer.trim()) {
        const delta = this.parseLine(buffer.trim(), usage);
        if (delta?.content) yield { content: delta.content };
        if (delta?.usage) usage = { ...usage, ...delta.usage };
      }
      yield { done: true, usage };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('transient', '读取 Ollama 流失败', {
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

  private parseLine(line: string, previousUsage?: ChatUsage): ChatDelta | null {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (obj.error) {
      throw new ProviderError('transient', String(obj.error), {
        providerId: this.id,
        detail: String(obj.error),
      });
    }
    const message = obj.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === 'string' ? message.content : undefined;
    const done = obj.done === true;
    const usage: ChatUsage | undefined =
      done && (typeof obj.prompt_eval_count === 'number' || typeof obj.eval_count === 'number')
        ? {
            inputTokens:
              typeof obj.prompt_eval_count === 'number' ? obj.prompt_eval_count : previousUsage?.inputTokens,
            outputTokens: typeof obj.eval_count === 'number' ? obj.eval_count : previousUsage?.outputTokens,
          }
        : undefined;
    return { content, done, usage };
  }
}
