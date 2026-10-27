import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { EXAMPLE_ARTIFACT_PATH, EXAMPLE_CLIENT_SESSION_ID, EXAMPLE_CONTRACT_SESSION_ID, EXAMPLE_PROJECT_ID } from './example.ts';
import { SCHEMA_VERSION } from './db.ts';
import { makeRepo, rawRequest, runGit, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => { const t = await startTestApp(options); apps.push(t); return t; };
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

describe('bootstrap and example workspace', () => {
  it('seeds a labelled example workspace with two idle sessions, a task DAG and a real commit, without calling a model', async () => {
    const t = await boot();
    const state = (await t.api('GET', '/api/bootstrap')).json;
    expect(state.projects).toHaveLength(1);
    const project = state.projects[0];
    expect(project).toMatchObject({ id: EXAMPLE_PROJECT_ID, isExample: true });
    expect(state.sessions.map((s: any) => [s.id, s.status])).toEqual([[EXAMPLE_CONTRACT_SESSION_ID, 'idle'], [EXAMPLE_CLIENT_SESSION_ID, 'idle']]);
    expect(state.sessions.every((s: any) => s.isolated && existsSync(s.worktreePath) && s.worktreePath.startsWith(t.app.config.dataDir))).toBe(true);
    expect(state.tasks.map((x: any) => x.status)).toEqual(['ready', 'blocked', 'blocked', 'blocked']);
    expect(state.tasks[3].dependsOn).toHaveLength(2);
    expect(runGit(project.path, 'log', '--format=%s')).toContain('Initial example workspace');
    expect(readFileSync(path.join(project.path, 'README.md'), 'utf8')).toMatch(/example workspace/i);
    expect(JSON.parse(readFileSync(path.join(project.path, EXAMPLE_ARTIFACT_PATH), 'utf8')).info.version).toBe('1.0.0');
    expect(state.messages.every((m: any) => m.role === 'system')).toBe(true); // no invented runs
    expect(state.settings.defaultPolicy).toBe('supervised');
    expect(state.settings.onboardingCompletedVersion).toBeUndefined();
    expect(state.events.map((e: any) => e.type)).toContain('workspace.example.created');
    expect(t.fake.runs).toHaveLength(0);
  });

  it('can start without the example workspace', async () => {
    const t = await boot({ exampleWorkspace: false });
    expect((await t.api('GET', '/api/bootstrap')).json.projects).toEqual([]);
  });

  it('reports health with database and runtime details', async () => {
    const t = await boot();
    const health = (await t.api('GET', '/api/health')).json;
    expect(health).toMatchObject({ ok: true, host: '127.0.0.1', port: t.port, database: { ok: true, schemaVersion: SCHEMA_VERSION, sessions: 2 }, runtime: { activeRuns: 0 } });
  });

  it('keeps all state across restarts, appends events monotonically and seeds the example once', async () => {
    const repo = makeRepo();
    const first = await boot({ keepData: true });
    const project = (await first.api('POST', '/api/projects', { name: 'mine', path: repo })).json;
    const session = (await first.api('POST', '/api/sessions', { projectId: project.id, name: 'Persisted', provider: 'claude', model: 'claude-sonnet-5-5' })).json;
    expect(session).toMatchObject({ isolated: true, status: 'idle' });
    expect(session.worktreePath.startsWith(first.app.config.dataDir)).toBe(true);
    first.fake.script = async (o, emit) => { emit({ type: 'session', providerSessionId: 'prov-1' }); emit({ type: 'text', text: 'Hello ' }); emit({ type: 'tool', name: 'Bash', content: 'ls' }); emit({ type: 'text', text: 'world' }); emit({ type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 }); };
    expect((await first.api('POST', `/api/sessions/${session.id}/messages`, { content: 'hi' })).status).toBe(202);
    await waitFor(async () => (await first.api('GET', '/api/bootstrap')).json.sessions.find((s: any) => s.id === session.id).status === 'idle');
    await first.api('PATCH', '/api/settings', { theme: 'light', onboardingCompletedVersion: 1 });
    const before = (await first.api('GET', '/api/bootstrap')).json;
    const mine = before.messages.filter((m: any) => m.sessionId === session.id);
    expect(mine.map((m: any) => [m.role, m.content, m.kind ?? null])).toEqual([['user', 'hi', null], ['assistant', 'Hello ', null], ['tool', 'Bash\nls', 'tool'], ['assistant', 'world', null]]);
    const dataDir = first.dataDir;
    await first.app.close();
    apps.pop();

    const second = await boot({ dataDir, keepData: false });
    const after = (await second.api('GET', '/api/bootstrap')).json;
    expect(after.projects.map((p: any) => p.name).sort()).toEqual(['Mingle example workspace', 'mine']);
    expect(after.projects).toHaveLength(2);
    expect(after.messages.filter((m: any) => m.sessionId === session.id)).toEqual(mine);
    const restored = after.sessions.find((s: any) => s.id === session.id);
    expect(restored).toMatchObject({ providerSessionId: 'prov-1', inputTokens: 10, outputTokens: 5, costUsd: 0.01, status: 'idle', branch: session.branch });
    expect(after.settings.theme).toBe('light');
    expect(after.settings.onboardingCompletedVersion).toBe(1);
    expect(after.events.filter((e: any) => e.type === 'workspace.example.created')).toHaveLength(1);
    const ids = after.events.map((e: any) => e.id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...ids)).toBeGreaterThan(Math.max(...before.events.map((e: any) => e.id))); // runtime.started of the second boot
    const replay = (await second.api('GET', `/api/events?after=${ids[2]}`)).json;
    expect(replay[0].id).toBeGreaterThan(ids[2]);
  });

  it('makes events append-only at the database level', async () => {
    const t = await boot({ keepData: true });
    const dataDir = t.dataDir;
    await t.app.close();
    apps.pop();
    const db = new DatabaseSync(path.join(dataDir, 'relay.sqlite'));
    expect(() => db.exec("UPDATE events SET summary = 'x'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM events')).toThrow(/append-only/);
    db.close();
    const again = await boot({ dataDir });
    expect(again.app.store.counts().events).toBeGreaterThan(0);
  });

  it('recovers from an unclean stop: interrupts runs, expires approvals, keeps partial text, resets running tasks', async () => {
    const t = await boot({ keepData: true });
    const dataDir = t.dataDir;
    const state = (await t.api('GET', '/api/bootstrap')).json;
    const sessionId = state.sessions[0].id;
    await t.app.close();
    apps.pop();
    const db = new DatabaseSync(path.join(dataDir, 'relay.sqlite'));
    db.prepare("UPDATE sessions SET status = 'waiting' WHERE id = ?").run(sessionId);
    db.prepare("INSERT INTO messages(id, session_id, role, content, kind, created_at) VALUES ('msg_partial', ?, 'assistant', 'half a sent', 'streaming', '2026-01-01T00:00:00Z')").run(sessionId);
    db.prepare("INSERT INTO approvals(id, session_id, tool, description, input, status, created_at) VALUES ('apr_old', ?, 'Bash', 'rm -rf', '{}', 'pending', '2026-01-01T00:00:00Z')").run(sessionId);
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = 'tsk_example_contract'").run();
    db.close();

    const t2 = await boot({ dataDir });
    const after = (await t2.api('GET', '/api/bootstrap')).json;
    expect(after.sessions.find((s: any) => s.id === sessionId)).toMatchObject({ status: 'interrupted' });
    expect(after.messages.find((m: any) => m.id === 'msg_partial')).toMatchObject({ kind: 'partial', content: 'half a sent' });
    expect(after.approvals.find((a: any) => a.id === 'apr_old').status).toBe('denied');
    expect(after.tasks.find((x: any) => x.id === 'tsk_example_contract').status).toBe('ready');
    expect(after.events.map((e: any) => e.type)).toContain('approval.expired');
    const stale = await t2.api('POST', '/api/approvals/apr_old', { decision: 'approved' });
    expect(stale.status).toBe(409);
    expect(t2.fake.runs).toHaveLength(0);
  });
});

describe('local transport security', () => {
  it('rejects foreign Host headers (DNS rebinding) and cross-origin mutations', async () => {
    const t = await boot();
    expect((await rawRequest(t.port, 'GET', '/api/health', { host: 'evil.example:4310' })).status).toBe(403);
    expect((await rawRequest(t.port, 'GET', '/api/health', { host: `127.0.0.1:${t.port}` })).status).toBe(200);
    const body = JSON.stringify({ name: 'x', path: '/tmp' });
    for (const origin of ['http://evil.example', 'https://localhost:4310', 'null', `http://127.0.0.1.evil.example:${t.port}`]) {
      const res = await rawRequest(t.port, 'POST', '/api/projects', { origin }, body);
      expect(res.status, origin).toBe(403);
    }
    expect((await rawRequest(t.port, 'GET', '/api/bootstrap', { origin: 'http://evil.example' })).status).toBe(403);
    expect(JSON.parse((await rawRequest(t.port, 'POST', '/api/projects', { origin: 'http://evil.example' }, body)).text)).toHaveProperty('error');
  });

  it('accepts the app origins: Vite dev server, same-origin (Electron/production) and non-browser clients', async () => {
    const t = await boot();
    const dir = makeRepo();
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', `http://127.0.0.1:${t.port}`, `http://localhost:${t.port}`]) {
      const res = await rawRequest(t.port, 'POST', '/api/projects', { origin, host: origin.replace('http://', '') }, JSON.stringify({ name: 'p', path: dir }));
      expect([200, 201], origin).toContain(res.status);
    }
    expect((await t.api('PATCH', '/api/settings', { theme: 'dark' })).status).toBe(200);
  });

  it('returns JSON errors for validation, unknown routes and methods', async () => {
    const t = await boot();
    expect(await t.api('POST', '/api/projects', { name: '', path: '' })).toMatchObject({ status: 400, json: { error: expect.any(String) } });
    expect((await t.api('GET', '/api/nope')).status).toBe(404);
    expect((await t.api('DELETE', '/api/bootstrap')).status).toBe(405);
    expect((await rawRequest(t.port, 'POST', '/api/projects', {}, '{broken')).status).toBe(400);
    expect((await t.api('POST', '/api/projects', { name: 'x', path: 'relative/path' })).status).toBe(400);
    expect((await t.api('POST', '/api/projects', { name: 'x', path: '/definitely/not/here' })).status).toBe(400);
    expect((await t.api('GET', '/api/events?after=abc')).status).toBe(400);
  });

  it('rejects cross-origin and unknown WebSocket upgrades, accepts allowed ones and pushes state.changed', async () => {
    const t = await boot();
    const open = (origin?: string, p = '/ws') => new Promise<{ ws: WebSocket; ok: boolean; code?: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${t.port}${p}`, { headers: origin ? { origin } : {} });
      ws.on('open', () => resolve({ ws, ok: true }));
      ws.on('unexpected-response', (_req, res) => resolve({ ws, ok: false, code: res.statusCode }));
      ws.on('error', () => undefined);
    });
    expect(await open('http://evil.example')).toMatchObject({ ok: false, code: 403 });
    expect(await open('http://localhost:5173', '/other')).toMatchObject({ ok: false, code: 404 });
    const good = await open('http://localhost:5173');
    expect(good.ok).toBe(true);
    const message = new Promise<any>((resolve) => good.ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
    await t.api('PATCH', '/api/settings', { theme: 'light' });
    expect(await message).toMatchObject({ type: 'state.changed', event: { type: 'settings.updated' } });
    good.ws.close();
  });
});

describe('settings and providers', () => {
  it('validates executable settings, refreshes diagnostics and exposes provider info', async () => {
    const t = await boot();
    expect((await t.api('PATCH', '/api/settings', { claudeExecutable: 'a\nb' })).status).toBe(400);
    for (const onboardingCompletedVersion of [0, 2, -1, 1.5, '1', null]) {
      expect((await t.api('PATCH', '/api/settings', { onboardingCompletedVersion })).status).toBe(400);
    }
    const updated = await t.api('PATCH', '/api/settings', { codexExecutable: '/opt/codex', defaultPolicy: 'balanced' });
    expect(updated.json).toMatchObject({ codexExecutable: '/opt/codex', defaultPolicy: 'balanced' });
    const providers = (await t.api('GET', '/api/providers')).json;
    expect(providers.map((p: any) => p.id)).toEqual(['codex', 'claude', 'antigravity', 'opencode']);
    const before = t.fake.detections;
    await t.api('POST', '/api/providers/refresh');
    expect(t.fake.detections).toBeGreaterThan(before);
  });
});

describe('static serving', () => {
  it('serves the built web app safely and never exposes other files', async () => {
    const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs');
    const { tmpDir } = await import('./test-utils.ts');
    const dist = tmpDir('mingle-dist-');
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Mingle</title>');
    writeFileSync(path.join(dist, 'assets/app.js'), 'console.log(1)');
    writeFileSync(path.join(dist, '.hidden'), 'nope');
    symlinkSync('/etc/passwd', path.join(dist, 'passwd-link'));
    const t = await boot({ webDistDir: dist });
    expect((await rawRequest(t.port, 'GET', '/')).text).toContain('Mingle');
    expect((await rawRequest(t.port, 'GET', '/')).headers['content-security-policy']).toContain("default-src 'self'");
    expect((await rawRequest(t.port, 'GET', '/some/client/route')).text).toContain('Mingle');
    expect((await rawRequest(t.port, 'GET', '/assets/app.js')).headers['content-type']).toMatch(/javascript/);
    for (const bad of ['/.hidden', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%5c..%5cx', '/missing.js']) {
      const res = await rawRequest(t.port, 'GET', bad);
      expect(res.text, bad).not.toContain('root:');
      // Either refused outright, or normalised by the URL parser to an in-dist path that falls back to the SPA shell.
      if (res.status !== 404) expect(res.text, bad).toContain('<title>Mingle</title>');
    }
    expect((await rawRequest(t.port, 'GET', '/.hidden')).status).toBe(404);
    expect((await rawRequest(t.port, 'GET', '/missing.js')).status).toBe(404);
    // A symlink pointing outside dist is never followed; the extensionless path falls back to the SPA shell.
    const link = await rawRequest(t.port, 'GET', '/passwd-link');
    expect(link.text).not.toContain('root:');
    expect(link.text).toContain('<title>Mingle</title>');
  });
});
