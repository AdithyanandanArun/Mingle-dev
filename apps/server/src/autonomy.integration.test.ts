import { afterEach, describe, expect, it } from 'vitest';
import type { GroupSnapshot } from '@mingle/contracts';
import { EXAMPLE_CLIENT_SESSION_ID } from './example.ts';
import { startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async () => {
  const app = await startTestApp();
  apps.push(app);
  return app;
};

afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
});

const claudeConfig = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard' } as const;

async function createGroup(t: TestApp): Promise<GroupSnapshot> {
  await t.api('POST', '/api/providers/refresh', {});
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CLIENT_SESSION_ID,
    mode: 'current-leads',
    agent: { handle: 'backup', isolated: true, configuration: claudeConfig },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return created.json;
}

function failedCommand(id: string) {
  return {
    type: 'tool.activity' as const,
    activity: { id, name: 'shell', category: 'command' as const, status: 'failed' as const, command: 'false', input: 'false', exitCode: 1 },
  };
}

function groupEvents(t: TestApp, groupId: string): Promise<any[]> {
  return t.api('GET', '/api/events').then((response) => (response.json as any[]).filter((event) => event.payload?.groupId === groupId));
}

type TurnHook = (context: any, isLead: boolean, memberTurn: number, emit: (event: any) => void) => Promise<void> | void;

async function driveProviderRuns(t: TestApp, groupId: string, expectedRuns: number): Promise<void> {
  await waitFor(() => {
    const current = t.app.groups.get(groupId);
    return t.fake.runs.length >= expectedRuns && t.app.runtime.activeCount() === 0
      && !current.deliveries.some((delivery) => delivery.status === 'running');
  }, 10_000, `${expectedRuns} provider runs to finish without running group deliveries`);
}

async function runAlternatingTurns(t: TestApp, group: GroupSnapshot, turnLimit: number, hook: TurnHook): Promise<void> {
  const groupId = group.group.id;
  const lead = group.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
  const peer = group.members.find((member) => member.id !== lead.id)!;
  const counts = new Map<string, number>();
  let total = 0;
  t.fake.script = async (options, emit) => {
    total++;
    const member = group.members.find((candidate) => candidate.sessionId === options.session.id);
    if (!member) throw new Error(`Unexpected group member session ${options.session.id}`);
    const delivery = t.app.groups.get(groupId).deliveries.find((candidate) => candidate.status === 'running' && candidate.memberId === member.id);
    if (!delivery?.runId) throw new Error('The current group delivery is not bound to its provider run');
    const context = t.app.groups.contextForRun(options.session.id, delivery.runId);
    if (!context) throw new Error('The active provider run has no group context');
    const memberTurn = (counts.get(member.id) ?? 0) + 1;
    counts.set(member.id, memberTurn);
    await hook(context, member.id === lead.id, memberTurn, emit);
    emit({ type: 'text', text: `Turn ${total} completed; this model text is not progress evidence.` });

    if (total < turnLimit) {
      const recipient = member.id === lead.id ? peer : lead;
      await t.app.groups.message(context, {
        recipient: recipient.handle,
        content: `Continue deterministic autonomy fixture at turn ${total}.`,
        expectsReply: true,
      });
    }
  };

  const accepted = await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Run the deterministic autonomy fixture.' });
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(202);
  await driveProviderRuns(t, groupId, turnLimit);
  await waitFor(() => {
    const current = t.app.groups.get(groupId);
    return t.app.runtime.activeCount() === 0 && !current.deliveries.some((delivery) => delivery.status === 'queued' || delivery.status === 'running');
  }, 10_000, 'all deterministic group deliveries to settle');
}

describe('group autonomy and stall evidence integration', () => {
  it('keeps the new 80-turn default and retains an explicitly saved 16-turn group limit', async () => {
    const t = await boot();
    const initial = await createGroup(t);
    expect(initial.group.maxTurns).toBe(80);

    const saved = await t.api('PATCH', `/api/groups/${initial.group.id}`, { maxTurns: 16 });
    expect(saved.status).toBe(200);
    expect(t.app.groups.get(initial.group.id).group.maxTurns).toBe(16);

    const autonomy = await t.api('PATCH', `/api/groups/${initial.group.id}`, { autonomy: { mode: 'balanced' } });
    expect(autonomy.status).toBe(200);
    expect(t.app.groups.get(initial.group.id).group.maxTurns).toBe(16);
  });

    it('keeps explicit null unlimited and preserves the inherited 2-turn ceiling in supervised mode', async () => {
    const unlimited = await boot();
    const group = await createGroup(unlimited);
    const patched = await unlimited.api('PATCH', `/api/groups/${group.group.id}`, {
      maxTurns: 2, maxHops: 6, autonomy: { mode: 'extended', emergencyTurnLimit: null },
    });
    expect(patched.status).toBe(200);
    await runAlternatingTurns(unlimited, group, 3, () => undefined);
    expect(unlimited.fake.runs).toHaveLength(3);

    const bounded = await boot();
    const boundedGroup = await createGroup(bounded);
    const inherited = await bounded.api('PATCH', `/api/groups/${boundedGroup.group.id}`, {
      maxTurns: 2, maxHops: 6, autonomy: { mode: 'supervised' },
    });
    expect(inherited.status).toBe(200);

    const lead = boundedGroup.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    const peer = boundedGroup.members.find((member) => member.id !== lead.id)!;
    let total = 0;
    const budgetRejections: string[] = [];
    bounded.fake.script = async (options, emit) => {
      total++;
      const member = boundedGroup.members.find((candidate) => candidate.sessionId === options.session.id)!;
      const delivery = bounded.app.groups.get(boundedGroup.group.id).deliveries.find((candidate) => candidate.status === 'running' && candidate.memberId === member.id);
      if (!delivery?.runId) throw new Error('The bounded delivery is not bound to its run');
      const context = bounded.app.groups.contextForRun(options.session.id, delivery.runId);
      if (!context) throw new Error('The bounded run has no group context');
      emit({ type: 'text', text: 'A bounded turn completed.' });
      if (total < 3) {
        const recipient = member.id === lead.id ? peer : lead;
        try {
          await bounded.app.groups.message(context, { recipient: recipient.handle, content: `Bounded turn ${total}.`, expectsReply: true });
        } catch (error) {
          const detail = error as { status?: number; statusCode?: number; message?: string };
          const reason = error instanceof Error ? error.message : String(error);
          if ((detail.status === 409 || detail.statusCode === 409) && /turn budget/i.test(reason)) budgetRejections.push(reason);
          else throw error;
        }
      }
    };
    const accepted = await bounded.api('POST', `/api/groups/${boundedGroup.group.id}/messages`, { content: 'Respect the inherited request ceiling.' });
    expect(accepted.status).toBe(202);
    await driveProviderRuns(bounded, boundedGroup.group.id, 2);
    await waitFor(() => total >= 2 && bounded.app.runtime.activeCount() === 0, 10_000, 'the bounded request to finish');
    expect(bounded.fake.runs).toHaveLength(2);
    expect(budgetRejections).toHaveLength(1);
    expect(budgetRejections[0]).toMatch(/turn budget/i);
  }, 15_000);

  it('deduplicates repeated failed command events within one provider run', async () => {
    const t = await boot();
    const group = await createGroup(t);
    t.fake.script = async (_options, emit) => {
      emit(failedCommand('same-run-1'));
      emit(failedCommand('same-run-2'));
      emit(failedCommand('same-run-3'));
    };
    const accepted = await t.api('POST', `/api/groups/${group.group.id}/messages`, { content: 'Emit three identical failed tool activities in one run.' });
    expect(accepted.status).toBe(202);
    await driveProviderRuns(t, group.group.id, 1);

    const current = t.app.groups.get(group.group.id);
    const lead = current.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    expect(lead.held).not.toBe(true);
    const events = await groupEvents(t, group.group.id);
    const evidence = events.filter((event) => event.type === 'group.stall.evidence');
    expect(evidence, JSON.stringify({ events, tools: (await t.api('GET', '/api/bootstrap')).json.toolCalls })).toHaveLength(1);
    expect(evidence[0].payload.count).toBe(1);
    expect(events.some((event) => event.type === 'group.stall.detected')).toBe(false);
  }, 15_000);

  it('holds only the member after the same failed action recurs across three distinct runs', async () => {
    const t = await boot();
    const group = await createGroup(t);
    await t.api('PATCH', `/api/groups/${group.group.id}`, { maxHops: 6 });
    let leadFailures = 0;
    await runAlternatingTurns(t, group, 5, (_context, isLead, _memberTurn, emit) => {
      if (isLead) {
        leadFailures++;
        emit(failedCommand(`distinct-run-${leadFailures}`));
        emit({ type: 'text', text: 'I completed the checks successfully.' });
      }
    });

    expect(leadFailures).toBe(3);
    const current = t.app.groups.get(group.group.id);
    const lead = current.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    const peer = current.members.find((member) => member.id !== lead.id)!;
    expect(lead.held).toBe(true);
    expect(peer.held).not.toBe(true);
    const events = await groupEvents(t, group.group.id);
    const detected = events.find((event) => event.type === 'group.stall.detected');
    expect(detected?.payload).toMatchObject({ memberId: lead.id, count: 3, threshold: 3 });
    const evidenceRuns = events.filter((event) => event.type === 'group.stall.evidence').map((event) => event.payload.runId);
    expect(new Set(evidenceRuns).size).toBe(3);
  }, 15_000);

  it('clears repeated-action evidence after a successful host-recorded check, not after model text', async () => {
    const t = await boot();
    const group = await createGroup(t);
    await t.api('PATCH', `/api/groups/${group.group.id}`, { maxHops: 12 });
    let leadTurn = 0;
    await runAlternatingTurns(t, group, 9, (_context, isLead, _memberTurn, emit) => {
      if (!isLead) return;
      leadTurn++;
      if (leadTurn === 3) {
        emit({
          type: 'tool.activity',
          activity: { id: 'verified-check', name: 'shell', category: 'command', status: 'completed', command: 'pnpm test', input: 'pnpm test', exitCode: 0 },
        });
      } else {
        emit(failedCommand(`progress-reset-run-${leadTurn}`));
      }
      emit({ type: 'text', text: 'The tests passed.' });
    });

    const current = t.app.groups.get(group.group.id);
    const lead = current.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    expect(lead.held).not.toBe(true);
    const events = await groupEvents(t, group.group.id);
    expect(events.some((event) => event.type === 'group.progress.verified' && event.payload.evidence?.some((item: string) => item.startsWith('successful-check:')))).toBe(true);
    expect(events.some((event) => event.type === 'group.stall.detected')).toBe(false);
    expect(events.filter((event) => event.type === 'group.stall.evidence').map((event) => event.payload.count)).toEqual([1, 2, 1, 2]);
  }, 15_000);

  it('does not treat task-status events as progress that erases failed-action evidence', async () => {
    const t = await boot();
    const group = await createGroup(t);
    await t.api('PATCH', `/api/groups/${group.group.id}`, { maxHops: 12 });
    const lead = group.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    const tasks: string[] = [];
    for (let index = 0; index < 3; index++) {
      const created = await t.api('POST', '/api/tasks', {
        projectId: group.group.projectId, title: `Status-only task ${index + 1}`, description: '', acceptanceCriteria: '', sessionId: lead.sessionId,
      });
      expect(created.status).toBe(201);
      const ready = await t.api('PATCH', `/api/tasks/${created.json.id}`, { status: 'ready' });
      expect(ready.status).toBe(200);
      tasks.push(created.json.id);
    }

    let leadTurn = 0;
    await runAlternatingTurns(t, group, 5, async (_context, isLead, _memberTurn, emit) => {
      if (!isLead) return;
      leadTurn++;
      const taskId = tasks[leadTurn - 1]!;
      await t.app.store.updateTask(taskId, { status: 'running' });
      t.app.store.recordEvent({
        projectId: group.group.projectId,
        sessionId: lead.sessionId,
        type: 'group.status',
        summary: 'Simulated reported status without check or artifact',
        payload: { groupId: group.group.id, taskId, status: 'running', changed: true },
      });
      emit(failedCommand(`status-only-run-${leadTurn}`));
    });

    const current = t.app.groups.get(group.group.id);
    const heldLead = current.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    expect(heldLead.held).toBe(true);
    const events = await groupEvents(t, group.group.id);
    expect(events.filter((event) => event.type === 'group.status' && event.payload.changed === true)).toHaveLength(3);
    expect(events.some((event) => event.type === 'group.stall.detected' && event.payload.memberId === lead.id)).toBe(true);
  }, 15_000);
});
