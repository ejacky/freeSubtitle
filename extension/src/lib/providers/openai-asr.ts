import type { ProviderConfig } from '../settings/schema';
import {
  ProviderError,
  providerErrorFromResponse,
  type AsrProvider,
  type AsrRequest,
  type AsrResult,
} from './types';

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** OpenAI / Groq compatible /audio/transcriptions (multipart). */
export class OpenAIAsrProvider implements AsrProvider {
  readonly id: string;
  readonly label: string;

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly apiKey?: string,
  ) {
    this.id = cfg.id;
    this.label = cfg.label;
  }

  async transcribe(req: AsrRequest): Promise<AsrResult> {
    const form = new FormData();
    form.append('file', new Blob([req.wav], { type: 'audio/wav' }), 'segment.wav');
    form.append('model', this.cfg.model);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (req.language && req.language !== 'auto') form.append('language', req.language);
    if (req.prompt) form.append('prompt', req.prompt.slice(0, 400));

    let res: Response;
    try {
      res = await fetch(`${trimBase(this.cfg.baseUrl)}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: form,
        signal: req.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ProviderError('aborted', 'ASR 请求已取消', { providerId: this.id, cause: err });
      }
      throw new ProviderError('network', 'ASR 网络请求失败', {
        providerId: this.id,
        cause: err,
        detail: String(err),
      });
    }

    if (!res.ok) throw await providerErrorFromResponse(res, this.id);
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new ProviderError('invalid', 'ASR 返回不是 JSON', { providerId: this.id, cause: err });
    }
    const obj = json as Record<string, unknown>;
    const text = typeof obj.text === 'string' ? obj.text : '';
    if (!text && typeof obj.error === 'string') {
      throw new ProviderError('transient', obj.error, { providerId: this.id, detail: obj.error });
    }
    return {
      text,
      language: typeof obj.language === 'string' ? obj.language : undefined,
      durationMs: typeof obj.duration === 'number' ? obj.duration * 1000 : undefined,
    };
  }
}
