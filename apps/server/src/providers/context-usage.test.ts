import { describe, expect, it } from 'vitest';
import { acpContextUsage, claudeContextWindow, claudeRequestContext } from './context-usage.js';

describe('native context readings', () => {
  it('reads ACP occupancy without substituting billing totals', () => {
    expect(acpContextUsage({ sessionUpdate: 'usage_update', used: 725, size: 1000 })).toEqual({ usedTokens: 725, contextWindow: 1000 });
    expect(acpContextUsage({ sessionUpdate: 'usage_update', used: 0 })).toEqual({ usedTokens: 0, contextWindow: null });
    expect(acpContextUsage({ sessionUpdate: 'agent_message_chunk', used: 100, size: 1000 })).toBeNull();
    for (const used of [NaN, Infinity, -1, .5, '10']) expect(acpContextUsage({ sessionUpdate: 'usage_update', used, size: 1000 })).toBeNull();
    expect(acpContextUsage({ sessionUpdate: 'usage_update', used: 10, size: 0 })).toBeNull();
  });
  it('includes cached Claude prompt tokens but ignores child-agent context', () => {
    const message = { type: 'assistant', message: { model: 'example', usage: { input_tokens: 50, cache_read_input_tokens: 650, cache_creation_input_tokens: 100 } } };
    expect(claudeRequestContext(message)).toEqual({ usedTokens: 800, model: 'example' });
    expect(claudeRequestContext({ ...message, parent_tool_use_id: 'child' })).toBeNull();
    expect(claudeRequestContext({ type: 'result', usage: message.message.usage })).toBeNull();
  });
});
