import { describe, expect, it } from 'vitest';
import { buildMessages, buildSingleMessages } from '../src/lib/translate/prompt';

describe('buildMessages', () => {
  it('includes context, glossary and numbered lines', () => {
    const { messages, idMap } = buildMessages({
      lines: [
        { id: 'a', text: 'Hello' },
        { id: 'b', text: 'World' },
      ],
      context: ['Before one', 'Before two', 'Before three'],
      glossary: 'Ada = 艾达',
    });
    expect(idMap).toEqual(['a', 'b']);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('不要拒绝');
    const user = messages[1]?.content ?? '';
    expect(user).toContain('1. Hello');
    expect(user).toContain('2. World');
    expect(user).toContain('Ada = 艾达');
    expect(user).not.toContain('Before one');
    expect(user).toContain('Before two');
  });

  it('builds a minimal single-line request', () => {
    const { messages } = buildSingleMessages('The train leaves at nine.', ['Previous line']);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.content).toContain('The train leaves at nine.');
  });
});
