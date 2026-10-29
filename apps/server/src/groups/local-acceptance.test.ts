import { afterEach, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeRepo, runGit, startTestApp, waitFor, type TestApp } from '../test-utils.ts';

const apps: TestApp[] = [];
const repos: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
});

it('merges a local worker branch into the group integration worktree before full-access acceptance', async () => {
  const projectPath = makeRepo(); repos.push(projectPath);
  runGit(projectPath, 'config', 'user.name', 'Mingle integration test');
  runGit(projectPath, 'config', 'user.email', 'mingle-integration@example.invalid');
  const t = await startTestApp(); apps.push(t);
  await t.api('POST', '/api/providers/refresh', {});
  const project = await t.api<any>('POST', '/api/projects', { name: 'Local group acceptance', path: projectPath });
  expect(project.status).toBe(201);
  const anchor = await t.api<any>('POST', '/api/sessions', { projectId: project.json.id, name: 'Integration', provider: 'claude',
    model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: false });
  expect(anchor.status).toBe(201);
  const created = await t.api<any>('POST', '/api/groups', {
    sessionId: anchor.json.id, mode: 'current-leads',
    agent: { handle: 'local-builder', isolated: true, configuration: {
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard',
    } },
  });
  expect(created.status).toBe(201);
  await t.api('PATCH', `/api/groups/${created.json.group.id}`, { autonomy: { mode: 'extended' } });
  const current = t.app.groups.get(created.json.group.id);
  const worker = current.members.find((member) => member.sessionId !== anchor.json.id)!;
  let taskId: string | null = null;
  let accepted: unknown;
  t.fake.script = async (options, emit) => {
    const snapshot = t.app.groups.get(created.json.group.id);
    const member = snapshot.members.find((candidate) => candidate.sessionId === options.session.id)!;
    const delivery = snapshot.deliveries.find((candidate) => candidate.status === 'running' && candidate.memberId === member.id);
    if (!delivery?.runId) throw new Error('The local acceptance fixture has no live delivery.');
    const context = t.app.groups.contextForRun(options.session.id, delivery.runId);
    if (!context) throw new Error('The local acceptance fixture has no group context.');

    if (options.session.id === anchor.json.id) {
      if (!taskId) {
        const assigned = t.app.groups.assign(context, { recipient: worker.handle, title: 'Add the local feature',
          objective: 'Create feature.txt with the requested content.', acceptanceCriteria: 'feature.txt contains the requested line.',
          scope: ['feature.txt'], dependsOn: [], inputArtifacts: [] }) as { taskId: string };
        taskId = assigned.taskId;
      } else {
        accepted = await t.app.groups.acceptTask(context, { taskId, verificationSummary: 'I inspected the merged feature and verified its contents.' });
      }
    } else {
      const file = path.join(options.session.worktreePath, 'feature.txt');
      writeFileSync(file, 'merged from the local worker\n');
      runGit(options.session.worktreePath, 'add', '--', 'feature.txt');
      runGit(options.session.worktreePath, 'commit', '-m', 'Implement local worker feature');
      t.app.groups.status(context, { taskId: taskId!, status: 'review', note: 'Committed scoped output for review.' });
    }
    emit({ type: 'text', text: 'The current group turn completed.' });
  };

  const sent = await t.api('POST', `/api/groups/${created.json.group.id}/messages`, { content: 'Implement and integrate the local feature.' });
  expect(sent.status).toBe(202);
  await waitFor(() => t.app.runtime.activeCount() === 0
    && !t.app.groups.get(created.json.group.id).deliveries.some((delivery) => delivery.status === 'running' || delivery.status === 'queued'), 15_000, 'local group work to settle');
  expect(accepted, JSON.stringify({ runs: t.fake.runs.length, deliveries: t.app.groups.get(created.json.group.id).deliveries.map(({ id, status, error }) => ({ id, status, error })),
    task: t.app.store.getTask(taskId ?? ''), failures: t.app.store.listEvents().filter((event) => event.type === 'session.run.failed').map((event) => event.payload) })).toBeTruthy();

  expect(t.fake.runs).toHaveLength(3);
  expect(accepted).toMatchObject({ taskId, status: 'done', acceptedBy: 'orchestrator', workerBranch: expect.any(String),
    integrationBranch: 'main', merged: true });
  expect(t.app.store.getTask(taskId!)?.status).toBe('done');
  expect(readFileSync(path.join(projectPath, 'feature.txt'), 'utf8')).toBe('merged from the local worker\n');
  const integrationHead = runGit(projectPath, 'rev-parse', 'HEAD').trim();
  const workerHead = runGit(t.app.store.getSession(worker.sessionId)!.worktreePath, 'rev-parse', 'HEAD').trim();
  expect(() => runGit(projectPath, 'merge-base', '--is-ancestor', workerHead, integrationHead)).not.toThrow();
}, 20_000);
