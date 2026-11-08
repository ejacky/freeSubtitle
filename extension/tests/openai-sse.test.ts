import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIChatProvider } from '../src/lib/providers/openai-chat';
import { collectChat } from '../src/lib/providers/types';
import type { ProviderConfig } from '../src/lib/settings/schema';

const config: ProviderConfig = {
  id: 'test',
  kind: 'openai-chat',
  label: 'Test',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  headers: { 'x-opencode-session': '{{sessionId}}' },
  supportsTemperature: true,
  enabled: true,
};

function sse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAIChatProvider', () => {
  it('parses SSE deltas and ignores reasoning content', async () => {
    const body = [
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"火车"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"九点出发。"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchMock = vi.fn(async () => sse(body));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIChatProvider(config, 'key');
    const { text } = await collectChat(provider, {
      messages: [{ role: 'user', content: 'x' }],
      sessionId: 'session-1',
    });
    expect(text).toBe('火车九点出发。');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-opencode-session']).toBe('session-1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key');
  });

  it('maps a policy 400 to ProviderError.policy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'content policy violation' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const provider = new OpenAIChatProvider(config, 'key');
    await expect(
      collectChat(provider, { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'policy' });
  });

  it('sends reasoning_effort and omits temperature for GPT-6 style models', async () => {
    const fetchMock = vi.fn(async () => sse('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIChatProvider(
      { ...config, supportsTemperature: false, reasoningEffort: 'none' },
      'key',
    );
    await collectChat(provider, { messages: [{ role: 'user', content: 'x' }] });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('none');
    expect(body.temperature).toBeUndefined();
  });
});
