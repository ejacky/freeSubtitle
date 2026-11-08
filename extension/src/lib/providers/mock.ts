import type { ProviderConfig } from '../settings/schema';
import type {
  AsrProvider,
  AsrRequest,
  AsrResult,
  ChatDelta,
  ChatProvider,
  ChatRequest,
} from './types';

/**
 * Deterministic provider for development and for acceptance tests without keys.
 * Set `extraBody.policy` on the config to simulate a moderation refusal.
 */
export class MockChatProvider implements ChatProvider {
  readonly id: string;
  readonly label: string;

  constructor(private readonly cfg: ProviderConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
  }

  async *chat(_req: ChatRequest): AsyncGenerator<ChatDelta> {
    if (this.cfg.extraBody?.policy === true) {
      throw new Error('mock policy refusal');
    }
    const lines = _req.messages.at(-1)?.content ?? '';
    const numbered = [...lines.matchAll(/^(\d+)\.\s*(.+)$/gm)].map((m) => ({
      i: Number(m[1]),
      zh: `第${m[1]}条测试译文：这是用于验证字幕显示链路的中文测试内容。`,
    }));
    if (numbered.length > 0) {
      yield { content: JSON.stringify(numbered) };
    } else {
      yield { content: '这是用于验证字幕显示链路的中文测试内容，长度足够通过校验。' };
    }
    yield { done: true, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

export class MockAsrProvider implements AsrProvider {
  readonly id: string;
  readonly label: string;

  constructor(private readonly cfg: ProviderConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
  }

  async transcribe(_req: AsrRequest): Promise<AsrResult> {
    return { text: 'This is a mock transcript.', language: 'en' };
  }
}
