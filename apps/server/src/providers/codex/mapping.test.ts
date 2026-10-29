import { describe, expect, it } from 'vitest';
import { itemToolActivity } from './mapping.js';

describe('Codex tool activity mapping', () => {
  it('keeps native agent-spawn calls categorized as agents', () => {
    const activity = itemToolActivity({ id: 'spawn-1', type: 'collabAgentToolCall', tool: 'spawnAgent', prompt: 'Inspect auth', agentType: 'explorer' }, 'started');
    expect(activity).toMatchObject({ category: 'agent', name: 'agent:spawnAgent', summary: 'Inspect auth' });
  });
});
