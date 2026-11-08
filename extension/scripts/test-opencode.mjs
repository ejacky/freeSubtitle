#!/usr/bin/env node
/**
 * Quick OpenCode Go connectivity probe (does not print the API key).
 *
 *   OPENCODE_GO_API_KEY=sk-... node scripts/test-opencode.mjs [model]
 */
const key = process.env.OPENCODE_GO_API_KEY;
const model = process.argv[2] || 'deepseek-v4.1-flash';
if (!key) {
  console.error('Set OPENCODE_GO_API_KEY first (do not commit it).');
  process.exit(1);
}

const started = Date.now();
const res = await fetch('https://opencode.ai/inference/go/openai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    'x-opencode-session': crypto.randomUUID(),
  },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'You are a subtitle translator. Output only Chinese.' },
      { role: 'user', content: 'The train leaves at nine.' },
    ],
    max_tokens: 80,
    reasoning_effort: 'low',
    temperature: 0.1,
  }),
  signal: AbortSignal.timeout(30000),
});

const text = await res.text();
console.log('status:', res.status, 'latency:', Date.now() - started, 'ms');
if (!res.ok) {
  console.log(text.slice(0, 800));
  process.exit(2);
}
try {
  const json = JSON.parse(text);
  console.log('content:', json.choices?.[0]?.message?.content?.slice(0, 300) ?? '(empty)');
  console.log('usage:', json.usage ?? null);
} catch {
  console.log(text.slice(0, 500));
}
