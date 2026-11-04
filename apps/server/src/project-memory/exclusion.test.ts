import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, makeRepo, waitFor, type TestApp } from '../test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

describe('one-run project memory exclusion', () => {
  it('is server enforced, session scoped, queued durably, and resets on the next default run', async () => {
    const t = await startTestApp({ exampleWorkspace: false }); apps.push(t);
    const project = (await t.api('POST', '/api/projects', { name: 'memory-scope', path: makeRepo() })).json;
    const session = (await t.api('POST', '/api/sessions', { projectId: project.id, name: 'Standalone', provider: 'claude', model: 'claude-sonnet-5-5' })).json;
    await t.api('POST', `/api/projects/${project.id}/memory`, { kind: 'fact', title: 'Remembered rule', body: 'MEMORY_SENTINEL should appear in default runs.' });

    const invalid = await t.api('POST', `/api/sessions/${session.id}/messages`, { content: 'bad flag', memory: 'include' });
    expect(invalid.status).toBe(400);
    const otherProject = (await t.api('POST', '/api/projects', { name: 'other', path: makeRepo() })).json;
    const other = (await t.api('POST', '/api/sessions', { projectId: otherProject.id, name: 'Other', provider: 'claude', model: 'claude-sonnet-5-5' })).json;
    expect((await t.api('POST', `/api/sessions/${other.id}/messages`, { content: 'isolation', memory: 'exclude' })).status).toBe(202);
    const otherRun = await waitFor(() => t.fake.runs.find((run) => run.session.id === other.id), 4000, 'other session run');
    await waitFor(() => t.app.runtime.activeCount() === 0, 4000, 'other run end');
    expect(otherRun.context).not.toContain('MEMORY_SENTINEL');
    expect(otherRun.memoryMcp).toBeUndefined();
    const otherRunId = t.app.store.db.prepare('SELECT id FROM session_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(other.id)!.id as string;
    expect(t.app.store.runMemoryExcluded(otherRunId)).toBe(true);

    const firstSeen = t.fake.runs.length;
    expect((await t.api('POST', `/api/sessions/${session.id}/messages`, { content: 'exclude now', memory: 'exclude' })).status).toBe(202);
    const excluded = await waitFor(() => t.fake.runs[firstSeen], 4000, 'excluded run');
    await waitFor(() => t.app.runtime.activeCount() === 0, 4000, 'excluded run end');
    expect(excluded.context).not.toContain('MEMORY_SENTINEL');
    expect(excluded.memoryMcp).toBeUndefined();
    const excludedRunId = t.app.store.db.prepare('SELECT id FROM session_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(session.id)!.id as string;
    expect(t.app.store.runMemoryExcluded(excludedRunId)).toBe(true);
    expect((await t.api('GET', `/api/sessions/${session.id}/memory-injections`)).json.excludedRunIds).toContain(excludedRunId);

    const nextSeen = t.fake.runs.length;
    expect((await t.api('POST', `/api/sessions/${session.id}/messages`, { content: 'default again' })).status).toBe(202);
    const included = await waitFor(() => t.fake.runs[nextSeen], 4000, 'default memory run');
    await waitFor(() => t.app.runtime.activeCount() === 0, 4000, 'default run end');
    expect(included.context).toContain('MEMORY_SENTINEL');
    expect(included.memoryMcp).toBeDefined();
    const includedRunId = t.app.store.db.prepare('SELECT id FROM session_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(session.id)!.id as string;
    expect(t.app.store.runMemoryExcluded(includedRunId)).toBe(false);

    const planIndex = t.fake.runs.length;
    expect((await t.api('POST', `/api/sessions/${session.id}/messages`, { content: 'plan without memory', intent: 'plan', memory: 'exclude' })).status).toBe(202);
    const plan = await waitFor(() => t.fake.runs[planIndex], 4000, 'plan run');
    await waitFor(() => t.app.runtime.activeCount() === 0, 4000, 'plan run end');
    expect(plan.intent).toBe('plan');
    expect(plan.memoryMcp).toBeUndefined();
    expect(plan.context ?? '').not.toContain('MEMORY_SENTINEL');
  });

  it('persists exclusion on queued delivery and applies it only when that queue item starts', async () => {
    const t = await startTestApp({ exampleWorkspace: false }); apps.push(t);
    const project = (await t.api('POST', '/api/projects', { name: 'queued-memory', path: makeRepo() })).json;
    const session = (await t.api('POST', '/api/sessions', { projectId: project.id, name: 'Queued', provider: 'claude', model: 'claude-sonnet-5-5' })).json;
    await t.api('POST', `/api/projects/${project.id}/memory`, { kind: 'fact', title: 'Queue rule', body: 'QUEUE_MEMORY_SENTINEL should not reach excluded turns.' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    t.fake.script = async (options) => { if (options.prompt.includes('hold active')) await held; };
    expect((await t.api('POST', `/api/sessions/${session.id}/messages`, { content: 'hold active' })).status).toBe(202);
    await waitFor(() => t.fake.runs.length === 1, 4000, 'held run');
    const response = await t.api('POST', `/api/sessions/${session.id}/messages`, { content: 'queued excluded', memory: 'exclude' });
    expect(response.status).toBe(202);
    expect(response.json.queued).toMatchObject({ memory: 'exclude' });
    expect(t.app.store.listQueuedMessages(session.id)[0]).toMatchObject({ memory: 'exclude' });
    const edited = await t.api('PATCH', `/api/sessions/${session.id}/queue/${response.json.queued.id}`, { content: 'edited queued excluded' });
    expect(edited.json).toMatchObject({ memory: 'exclude', content: 'edited queued excluded' });
    release();
    const queuedRun = await waitFor(() => t.fake.runs[1], 4000, 'queued run dispatch');
    await waitFor(() => t.app.runtime.activeCount() === 0, 4000, 'queued run end');
    expect(queuedRun.prompt).toContain('edited queued excluded');
    expect(queuedRun.context).not.toContain('QUEUE_MEMORY_SENTINEL');
    expect(queuedRun.memoryMcp).toBeUndefined();
  });

  it('applies workflow-start exclusion to the first turn while rejecting unsupported public modes', async () => {
    const t = await startTestApp({ exampleWorkspace: false }); apps.push(t);
    const project = (await t.api('POST', '/api/projects', { name: 'workflow-memory', path: makeRepo() })).json;
    const session = (await t.api('POST', '/api/sessions', { projectId: project.id, name: 'Goal', provider: 'claude', model: 'claude-sonnet-5-5' })).json;
    await t.api('POST', `/api/projects/${project.id}/memory`, { kind: 'fact', title: 'Goal rule', body: 'WORKFLOW_MEMORY_SENTINEL must be absent on the excluded first turn.' });
    expect((await t.api('POST', `/api/sessions/${session.id}/workflow`, { goal: 'Start a goal', memory: 'other' })).status).toBe(400);
    expect((await t.api('POST', `/api/sessions/${session.id}/workflow`, { goal: 'Start a goal', memory: 'exclude' })).status).toBe(202);
    const run = await waitFor(() => t.fake.runs[0], 4000, 'workflow start');
    await waitFor(() => t.app.runtime.activeCount() === 0, 4000, 'workflow start end');
    expect(run.context).not.toContain('WORKFLOW_MEMORY_SENTINEL');
    expect(run.memoryMcp).toBeUndefined();
    const startRunId = t.app.store.db.prepare('SELECT run_id FROM session_workflow_runs WHERE session_id=? AND seq=1').get(session.id)!.run_id as string;
    expect(t.app.store.runMemoryExcluded(startRunId)).toBe(true);
    const continuation = await waitFor(() => t.fake.runs[1], 4000, 'workflow continuation');
    expect(continuation.context).toContain('WORKFLOW_MEMORY_SENTINEL');
    expect(continuation.memoryMcp).toBeDefined();
  });
});
