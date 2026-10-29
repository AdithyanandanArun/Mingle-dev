import type { Provider, SubagentMessage, ToolCall } from '@mingle/contracts';

export interface SubagentRun {
  id: string;
  providerId: string;
  runId: string;
  parentCall: ToolCall;
  label: string;
  handle: string;
  type: string;
  model: string;
  prompt: string;
  status: ToolCall['status'];
  startedAt: string;
  endedAt: string | null;
  finalResult: string;
  messages: SubagentMessage[];
  childToolCalls: ToolCall[];
}

function recordInput(call: ToolCall): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.input);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function textField(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isSubagentLaunch(call: ToolCall, provider: Provider): boolean {
  if (call.category !== 'agent' || /mingle_team|team_/i.test(call.name)) return false;
  if (provider === 'claude') return call.name === 'Task' || call.name === 'Agent';
  if (provider === 'codex') return call.name === 'agent:spawnAgent' || call.name === 'agent:spawn_agent';
  if (provider === 'opencode') return call.name.toLowerCase() === 'task';
  return false;
}

export function slugSubagentLabel(label: string): string {
  return label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'subagent';
}

export function subagentStatusLabel(status: ToolCall['status']): 'Running' | 'Done' | 'Failed' | 'Interrupted' {
  if (status === 'running') return 'Running';
  if (status === 'failed') return 'Failed';
  if (status === 'interrupted') return 'Interrupted';
  return 'Done';
}

/** Derives only provider-reported child-agent launches, excluding Mingle team coordination tools. */
export function deriveSubagents(calls: readonly ToolCall[], provider: Provider, parentModel: string): SubagentRun[] {
  const launches = calls.filter((call) => isSubagentLaunch(call, provider));
  return launches.map((parentCall, index) => {
    const input = recordInput(parentCall);
    const agentType = textField(input, 'subagent_type', 'subagentType', 'agent_type', 'agentType', 'subagent', 'agent', 'type')
      ?? (provider === 'claude' ? 'Agent' : parentCall.name.replace(/^agent:/, ''));
    const label = textField(input, 'description', 'name', 'subagent_type', 'subagentType', 'agent_type', 'agentType', 'subagent', 'agent')
      ?? `Subagent ${index + 1}`;
    const reportedModel = textField(input, 'model', 'model_id', 'modelId');
    return {
      id: parentCall.id,
      providerId: parentCall.providerId,
      runId: parentCall.runId,
      parentCall,
      label,
      handle: slugSubagentLabel(label),
      type: agentType,
      model: reportedModel ?? parentModel,
      prompt: textField(input, 'prompt', 'task') ?? '',
      status: parentCall.status,
      startedAt: parentCall.startedAt,
      endedAt: parentCall.finishedAt,
      finalResult: parentCall.output,
      messages: parentCall.subagentMessages ?? [],
      childToolCalls: calls.filter((call) => call.runId === parentCall.runId && call.parentProviderId === parentCall.providerId),
    } satisfies SubagentRun;
  }).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
