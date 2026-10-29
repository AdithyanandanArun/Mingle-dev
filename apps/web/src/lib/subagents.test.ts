import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@mingle/contracts';
import { deriveSubagents, slugSubagentLabel, subagentStatusLabel } from './subagents';

function call(overrides: Partial<ToolCall> & Pick<ToolCall, 'id' | 'providerId' | 'name' | 'category'>): ToolCall {
  const { id, providerId, name, category, ...rest } = overrides;
  return {
    id, runId: 'run-1', sessionId: 'session-1', providerId, parentProviderId: null,
    name, category, status: 'running', summary: '', command: null,
    input: '{}', output: '', cwd: null, exitCode: null, processId: null,
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, durationMs: null, ...rest,
  };
}

describe('subagent helpers', () => {
  it('derives Claude labels, prompt, reported model, status, messages and direct child tools', () => {
    const parent = call({
      id: 'mingle-task', providerId: 'task-call', name: 'Task', category: 'agent', status: 'completed',
      finishedAt: '2026-01-01T00:00:03.000Z', output: 'Finished auth review.',
      input: JSON.stringify({ description: 'Explore Auth Flow', subagent_type: 'Explore', model: 'claude-haiku-4-5', prompt: 'Trace sign in' }),
      subagentMessages: [{ id: 'message-1', content: 'Found the route.', createdAt: '2026-01-01T00:00:01.000Z' }],
    });
    const child = call({ id: 'tool-1', providerId: 'read-1', name: 'Read', category: 'file', parentProviderId: 'task-call' });
    const unrelated = call({ id: 'tool-2', providerId: 'read-2', name: 'Read', category: 'file', parentProviderId: null });

    expect(deriveSubagents([parent, child, unrelated], 'claude', 'claude-sonnet-5-5')).toEqual([expect.objectContaining({
      id: 'mingle-task', handle: 'explore-auth-flow', label: 'Explore Auth Flow', type: 'Explore', model: 'claude-haiku-4-5',
      prompt: 'Trace sign in', status: 'completed', endedAt: '2026-01-01T00:00:03.000Z',
      finalResult: 'Finished auth review.', messages: parent.subagentMessages, childToolCalls: [child],
    })]);
  });

  it('recognizes Codex spawn calls and excludes Mingle team coordination tools', () => {
    const launch = call({ id: 'launch', providerId: 'spawn-1', name: 'agent:spawnAgent', category: 'agent', input: JSON.stringify({ prompt: 'Inspect tests', agentType: 'explorer' }) });
    const teamTool = call({ id: 'team', providerId: 'team-1', name: 'mcp:mingle_team/team_send', category: 'agent' });
    expect(deriveSubagents([launch, teamTool], 'codex', 'gpt-6-luna')).toMatchObject([
      { id: 'launch', handle: 'explorer', prompt: 'Inspect tests', type: 'explorer', model: 'gpt-6-luna', status: 'running' },
    ]);
  });

  it('normalizes labels and reports terminal status labels', () => {
    expect(slugSubagentLabel('Éxplore: Auth / Session')).toBe('explore-auth-session');
    expect(subagentStatusLabel('running')).toBe('Running');
    expect(subagentStatusLabel('completed')).toBe('Done');
    expect(subagentStatusLabel('failed')).toBe('Failed');
    expect(subagentStatusLabel('interrupted')).toBe('Interrupted');
  });
});
