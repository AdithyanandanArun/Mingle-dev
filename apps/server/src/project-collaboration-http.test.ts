import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { JoinProjectInvitationSchema } from '@mingle/contracts';
import { makeRepo, runGit, startTestApp, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const repos: string[] = [];
const token = 'A'.repeat(43);
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
});

async function boot() {
  const logs: string[] = [];
  const t = await startTestApp({ exampleWorkspace: false, env: {}, log: (_level, message, detail) => logs.push(message + String(detail ?? '')) });
  apps.push(t);
  const repo = makeRepo();
  repos.push(repo);
  runGit(repo, 'remote', 'add', 'origin', 'https://github.com/example/explicit-test-project.git');
  const created = await t.api('POST', '/api/projects', { name: 'Example invitation test project', path: repo });
  expect(created.status).toBe(201);
  return { t, projectId: created.json.id as string, logs };
}

it('mounts the real project invitation routes without granting signed-out authority or starting an agent', async () => {
  const { t, projectId, logs } = await boot();
  const agent = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' };
  for (const [method, route, body] of [
    ['GET', `/api/projects/${projectId}/collaboration`, undefined],
    ['POST', `/api/projects/${projectId}/collaboration/invitations`, { email: 'teammate@example.test' }],
    ['POST', '/api/project-invitations/preview', { token }],
    ['POST', '/api/project-invitations/join', { token, localProjectId: projectId, agent }],
  ] as const) {
    const response = await t.api(method, route, body);
    expect(response.status, route).toBeGreaterThanOrEqual(400);
    expect(response.status, route).toBeLessThan(500);
    expect(response.json.error).toBeTypeOf('string');
    expect(JSON.stringify(response.json)).not.toContain(token);
  }
  expect(t.app.store.listSessions()).toEqual([]);
  expect(t.fake.runs).toEqual([]);
  expect(t.app.store.db.prepare('SELECT count(*) AS n FROM mingle_project_collaboration_joins').get()).toEqual({ n: 0 });
  expect(logs.join('\n')).not.toContain(token);
  expect((await t.api('GET', '/api/health')).status).toBe(200);
});

it('rejects foreign origins and malformed invitation payloads at the real HTTP boundary', async () => {
  const { t, projectId } = await boot();
  const blocked = await t.api('POST', `/api/projects/${projectId}/collaboration/invitations`, { email: 'teammate@example.test' }, { origin: 'https://attacker.invalid' });
  expect(blocked.status).toBe(403);
  for (const body of [{ token: 'short' }, { token, userId: 'forged-account' }, { token, redirectTo: 'https://attacker.invalid' }]) {
    expect((await t.api('POST', '/api/project-invitations/preview', body)).status).toBe(400);
  }
  const unsupported = await t.api('POST', '/api/project-invitations/join', {
    token, localProjectId: projectId, agent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'full-access' },
  });
  expect(unsupported.status).toBe(400);
  const validAgent = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' };
  expect(JoinProjectInvitationSchema.safeParse({ token, localProjectId: projectId, agent: validAgent }).success).toBe(true);
  expect(JoinProjectInvitationSchema.safeParse({ token, localProjectId: projectId, agents: [validAgent, validAgent] }).success).toBe(true);
  for (const body of [
    { token, localProjectId: projectId },
    { token, localProjectId: projectId, agent: validAgent, agents: [validAgent] },
    { token, localProjectId: projectId, agents: [] },
    { token, localProjectId: projectId, agents: [validAgent, validAgent, validAgent, validAgent, validAgent] },
    { token, localProjectId: projectId, agents: [{ ...validAgent, policy: 'full-access' }] },
  ]) {
    expect((await t.api('POST', '/api/project-invitations/join', body)).status).toBe(400);
  }
  expect(t.fake.runs).toEqual([]);
  expect(t.app.store.listSessions()).toEqual([]);
});

it('recognizes a freshly cloned checkout throughout Git state and invitation join preflight', async () => {
  const { t, projectId } = await boot();
  const source = t.app.store.getProject(projectId)!.path;
  const parent = mkdtempSync(path.join(os.tmpdir(), 'mingle-clone-detection-'));
  repos.push(parent);
  const checkout = path.join(parent, 'Shared café project');
  runGit(parent, 'clone', '--quiet', '--no-hardlinks', '--', source, checkout);
  runGit(checkout, 'remote', 'set-url', 'origin', 'https://github.com/example/explicit-test-project.git');
  const opened = await t.api('POST', '/api/projects', { name: 'Cloned checkout', path: checkout });
  expect(opened.status).toBe(201);
  const id = opened.json.id;
  for (const endpoint of ['git', 'repository']) {
    const result = await t.api('GET', `/api/projects/${id}/${endpoint}`);
    expect(result.status).toBe(200);
    expect(result.json.isRepo, endpoint).toBe(true);
  }
  const joined = await t.api('POST', '/api/project-invitations/join', {
    token, localProjectId: id,
    agent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' },
  });
  expect(joined.status).toBe(401);
  expect(joined.json.error).not.toMatch(/not.*(?:Git|repository)/i);
  expect(t.fake.runs).toEqual([]);
});

it('reports Git inspection errors separately from folders without a repository', async () => {
  const { t, projectId } = await boot();
  const checkout = t.app.store.getProject(projectId)!.path;
  writeFileSync(path.join(checkout, '.git', 'config'), 'broken fixture config\n');
  const joined = await t.api('POST', '/api/project-invitations/join', {
    token, localProjectId: projectId,
    agent: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised' },
  });
  expect(joined.status).toBe(409);
  expect(joined.json.error).toContain('Git could not inspect this project folder.');
  expect(joined.json.error).toMatch(/bad config/i);
  expect(joined.json.error).not.toContain('not an existing Git repository');
  expect(t.fake.runs).toEqual([]);
});
