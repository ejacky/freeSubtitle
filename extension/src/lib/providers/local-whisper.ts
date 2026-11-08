import type { ProviderConfig } from '../settings/schema';
import {
  ProviderError,
  type AsrProvider,
  type AsrRequest,
  type AsrResult,
} from './types';

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Local companion service (`local-asr/server.mjs`) accepts raw 16 kHz WAV.
 * Keeping the upload raw avoids multipart parsing in the small Node server.
 */
export class LocalWhisperProvider implements AsrProvider {
  readonly id: string;
  readonly label: string;

  constructor(private readonly cfg: ProviderConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
  }

  async transcribe(req: AsrRequest): Promise<AsrResult> {
    const params = new URLSearchParams({ model: this.cfg.model, response_format: 'json' });
    if (req.language && req.language !== 'auto') params.set('language', req.language);
    if (req.prompt) params.set('prompt', req.prompt.slice(0, 800));

    let res: Response;
    try {
      res = await fetch(`${trimBase(this.cfg.baseUrl)}/audio/transcriptions?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: req.wav,
        signal: req.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ProviderError('aborted', '本地 ASR 请求已取消', { providerId: this.id, cause: err });
      }
      throw new ProviderError('network', '无法连接本地 ASR 服务', {
        providerId: this.id,
        cause: err,
        detail: `${String(err)}。请先运行 local-asr/server.mjs。`,
      });
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 1200);
      } catch {
        // ignore
      }
      throw new ProviderError(
        res.status === 404 ? 'config' : 'transient',
        `本地 ASR 返回 ${res.status}`,
        { status: res.status, providerId: this.id, detail },
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new ProviderError('invalid', '本地 ASR 返回不是 JSON', { providerId: this.id, cause: err });
    }
    const obj = json as Record<string, unknown>;
    return {
      text: typeof obj.text === 'string' ? obj.text : '',
      language: typeof obj.language === 'string' ? obj.language : undefined,
    };
  }
}
