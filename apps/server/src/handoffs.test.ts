import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_ARTIFACT_PATH, EXAMPLE_CLIENT_SESSION_ID, EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { HandoffService } from './handoffs.ts';
import { makeRepo, runGit, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => { const t = await startTestApp(options); apps.push(t); return t; };
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const sessionOf = async (t: TestApp, id: string) => (await t.api('GET', '/api/bootstrap')).json.sessions.find((s: any) => s.id === id);

describe('handoffs', () => {
  it('verifies the artifact at an actual revision, records a durable event and system message, and does not start a run', async () => {
    const t = await boot();
    const from = await sessionOf(t, EXAMPLE_CONTRACT_SESSION_ID);
    const revision = runGit(from.worktreePath, 'rev-parse', 'HEAD').trim();
    const res = await t.api('POST', '/api/handoffs', { fromSessionId: from.id, toSessionId: EXAMPLE_CLIENT_SESSION_ID, path: EXAMPLE_ARTIFACT_PATH, revision: 'HEAD', note: 'Use v1 only' });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ type: 'handoff.created', sessionId: EXAMPLE_CLIENT_SESSION_ID, payload: { revision, path: EXAMPLE_ARTIFACT_PATH, fromSessionId: from.id, inlined: true } });
    expect(res.json.payload.reference).toContain(revision.slice(0, 12));
    const messages = (await t.api('GET', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`)).json;
    const handoff = messages.find((m: any) => m.kind === 'handoff');
    expect(handoff).toMatchObject({ role: 'system' });
    expect(handoff.content).toContain(res.json.payload.reference);
    expect(handoff.content).toContain('Example Users API'); // artifact content inlined
    expect(handoff.content).toContain('Use v1 only');
    expect(t.fake.runs).toHaveLength(0);
    expect((await sessionOf(t, EXAMPLE_CLIENT_SESSION_ID)).status).toBe('idle');
    expect((await t.api('GET', '/api/events')).json.map((e: any) => e.type)).toContain('handoff.created');
  });

  it('includes unconsumed handoff messages in the next provider prompt exactly once', async () => {
    const t = await boot();
    const from = await sessionOf(t, EXAMPLE_CONTRACT_SESSION_ID);
    await t.api('POST', '/api/handoffs', { fromSessionId: from.id, toSessionId: EXAMPLE_CLIENT_SESSION_ID, path: EXAMPLE_ARTIFACT_PATH, revision: 'HEAD' });
    const first = await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'Build the client' });
    expect(first.status).toBe(202);
    await waitFor(() => t.fake.runs.length === 1);
    expect(t.fake.runs[0]!.prompt).toContain('handoff:');
    expect(t.fake.runs[0]!.prompt).toContain('Example Users API');
    expect(t.fake.runs[0]!.prompt.endsWith('Build the client')).toBe(true);
    await waitFor(async () => (await sessionOf(t, EXAMPLE_CLIENT_SESSION_ID)).status === 'idle' && t.app.runtime.activeCount() === 0);
    const second = await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'Continue' });
    expect(second.status).toBe(202);
    await waitFor(() => t.fake.runs.length === 2);
    expect(t.fake.runs[1]!.prompt).toBe('Continue');
    // The stored user message is what the human typed, not the composed prompt.
    const stored = (await t.api('GET', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`)).json.filter((m: any) => m.role === 'user');
    expect(stored.map((m: any) => m.content)).toEqual(['Build the client', 'Continue']);
  });

  it('keeps handoff context for the next run when a run fails before the provider produced anything', async () => {
    const t = await boot();
    const from = await sessionOf(t, EXAMPLE_CONTRACT_SESSION_ID);
    await t.api('POST', '/api/handoffs', { fromSessionId: from.id, toSessionId: EXAMPLE_CLIENT_SESSION_ID, path: EXAMPLE_ARTIFACT_PATH, revision: 'HEAD' });
    t.fake.script = async () => { throw new Error('cli missing'); };
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'first' })).status).toBe(202);
    await waitFor(async () => (await sessionOf(t, EXAMPLE_CLIENT_SESSION_ID)).status === 'error');
    await waitFor(() => t.app.runtime.activeCount() === 0);
    t.fake.script = async () => undefined;
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'second' })).status).toBe(202);
    await waitFor(() => t.fake.runs.length === 2);
    expect(t.fake.runs[1]!.prompt).toContain('Example Users API');
  });

  it('refuses uncommitted artifacts, bad revisions, unrelated commits, escapes and cross-project handoffs', async () => {
    const t = await boot();
    const from = await sessionOf(t, EXAMPLE_CONTRACT_SESSION_ID);
    const body = (over: object) => ({ fromSessionId: from.id, toSessionId: EXAMPLE_CLIENT_SESSION_ID, path: EXAMPLE_ARTIFACT_PATH, revision: 'HEAD', ...over });
    // Uncommitted working-tree file: not an artifact at any revision.
    writeFileSync(path.join(from.worktreePath, 'api/draft.json'), '{}');
    const draft = await t.api('POST', '/api/handoffs', body({ path: 'api/draft.json' }));
    expect(draft.status).toBe(422);
    expect(draft.json.error).toMatch(/not committed/);
    // Modified-but-uncommitted artifact is still resolved from the committed revision.
    writeFileSync(path.join(from.worktreePath, EXAMPLE_ARTIFACT_PATH), 'LOCAL EDIT');
    const ok = await t.api('POST', '/api/handoffs', body({}));
    expect(ok.status).toBe(201);
    const text = (await t.api('GET', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`)).json.find((m: any) => m.kind === 'handoff').content;
    expect(text).not.toContain('LOCAL EDIT');

    expect((await t.api('POST', '/api/handoffs', body({ revision: 'deadbeefdeadbeef' }))).status).toBe(422);
    expect((await t.api('POST', '/api/handoffs', body({ revision: '--output=/tmp/x' }))).status).toBe(422);
    expect((await t.api('POST', '/api/handoffs', body({ revision: 'HEAD..main' }))).status).toBe(422);
    expect((await t.api('POST', '/api/handoffs', body({ path: '../../etc/passwd' }))).status).toBe(403);
    expect((await t.api('POST', '/api/handoffs', body({ path: '.git/config' }))).status).toBe(403);
    expect((await t.api('POST', '/api/handoffs', body({ path: 'api' }))).status).toBe(422); // directory, not a file
    expect((await t.api('POST', '/api/handoffs', body({ path: '*' }))).status).toBe(422);
    expect((await t.api('POST', '/api/handoffs', body({ toSessionId: from.id }))).status).toBe(422);
    expect((await t.api('POST', '/api/handoffs', body({ toSessionId: 'missing' }))).status).toBe(404);

    // A commit that exists in the repo but is not in the source session history is refused.
    const project = (await t.api('GET', '/api/bootstrap')).json.projects[0];
    const target = await sessionOf(t, EXAMPLE_CLIENT_SESSION_ID);
    writeFileSync(path.join(target.worktreePath, 'only-client.txt'), 'x');
    runGit(target.worktreePath, 'add', '-A');
    runGit(target.worktreePath, '-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-q', '-m', 'client only');
    const foreign = runGit(target.worktreePath, 'rev-parse', 'HEAD').trim();
    expect(runGit(project.path, 'cat-file', '-t', foreign).trim()).toBe('commit'); // shared object store
    const rejected = await t.api('POST', '/api/handoffs', body({ revision: foreign, path: 'only-client.txt' }));
    expect(rejected.status).toBe(422);
    expect(rejected.json.error).toMatch(/history/);

    const other = (await t.api('POST', '/api/projects', { name: 'other', path: makeRepo() })).json;
    const stranger = (await t.api('POST', '/api/sessions', { projectId: other.id, name: 'x', provider: 'codex', model: 'm' })).json;
    const cross = await t.api('POST', '/api/handoffs', body({ toSessionId: stranger.id }));
    expect(cross.status).toBe(422);
    expect(cross.json.error).toMatch(/same project/);
  });

  it('accepts an unreachable imported commit only when the internal verifier matches its exact file evidence', async () => {
    const t = await boot();
    const from = await sessionOf(t, EXAMPLE_CONTRACT_SESSION_ID);
    const to = await sessionOf(t, EXAMPLE_CLIENT_SESSION_ID);
    writeFileSync(path.join(to.worktreePath, 'owner-artifact.ts'), 'export const ownerArtifact = true;\n');
    runGit(to.worktreePath, 'add', '--', 'owner-artifact.ts');
    runGit(to.worktreePath, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-m', 'owner artifact');
    const revision = runGit(to.worktreePath, 'rev-parse', 'HEAD').trim();
    const input = { fromSessionId: from.id, toSessionId: EXAMPLE_CLIENT_SESSION_ID, path: 'owner-artifact.ts', revision, note: '' };
    const service = new HandoffService(t.app.store);

    await expect(service.create(input)).rejects.toThrow(/not part of the source session history/i);
    await expect(service.create(input, undefined, () => false)).rejects.toThrow(/not part of the source session history/i);
    const verified: Array<{ revision: string; path: string; blob: string }> = [];
    const event = await service.create(input, undefined, (proof) => {
      verified.push(proof);
      return proof.revision === revision && proof.path === 'owner-artifact.ts' && /^[0-9a-f]{40,64}$/.test(proof.blob);
    });

    expect(verified).toHaveLength(1);
    expect(event).toMatchObject({ type: 'handoff.created', sessionId: EXAMPLE_CLIENT_SESSION_ID,
      payload: { fromSessionId: from.id, toSessionId: EXAMPLE_CLIENT_SESSION_ID, path: 'owner-artifact.ts', revision } });
  });
});
