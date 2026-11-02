import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ProjectMemoryContextPreviewSchema, ProjectMemoryEntryDetailSchema, ProjectMemoryHistoryResponseSchema, ProjectMemoryInjectionsResponseSchema,
  ProjectMemoryListResponseSchema, ProjectMemoryWriteResultSchema,
} from '@mingle/contracts';
import type { MemoryMcpConnection, RunOptions } from '@mingle/contracts';
import { makeRepo, rawRequest, startTestApp, tmpDir, waitFor, type TestApp } from '../test-utils.ts';

const apps: TestApp[] = [];
const clients: Client[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()!.close().catch(() => undefined);
  while (apps.length) await apps.pop()!.cleanup();
});

async function connect(connection: MemoryMcpConnection): Promise<Client> {
  const client = new Client({ name: 'mingle-memory-test', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } }));
  return client;
}
const text = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '');
const payload = (result: unknown): any => JSON.parse(text(result));

async function runMessage(t: TestApp, sessionId: string, content: string, intent: 'normal' | 'plan' = 'normal'): Promise<RunOptions> {
  const seen = t.fake.runs.length;
  expect((await t.api('POST', `/api/sessions/${sessionId}/messages`, { content, intent })).status).toBe(202);
  const options = await waitFor(() => t.fake.runs[seen], 4000, 'run start');
  await waitFor(() => t.app.runtime.activeCount() === 0, 4000, 'run end');
  return options;
}

describe('project memory HTTP API, MCP tools and run wiring', () => {
  it('records through the run-scoped MCP tools and exposes list/detail/history/patch/preview/injections', async () => {
    const t = await startTestApp({ exampleWorkspace: false });
    apps.push(t);
    const repo = makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const project = (await t.api('POST', '/api/projects', { name: 'alpha', path: repo })).json;
    const other = (await t.api('POST', '/api/projects', { name: 'beta', path: makeRepo() })).json;
    const body = (projectId: string, name: string) => ({ projectId, name, provider: 'claude', model: 'claude-sonnet-5-5' });
    const a = (await t.api('POST', '/api/sessions', body(project.id, 'Writer'))).json;
    const b = (await t.api('POST', '/api/sessions', body(project.id, 'Reader'))).json;
    const c = (await t.api('POST', '/api/sessions', body(other.id, 'Outsider'))).json;
    expect(a.isolated).toBe(true);

    let connection: MemoryMcpConnection | undefined;
    const outputs: Record<string, any> = {};
    t.fake.script = async (options) => {
      if (options.session.id === a.id && options.memoryMcp) {
        connection = options.memoryMcp;
        const client = await connect(options.memoryMcp);
        const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
        outputs.tools = tools;
        outputs.remember = payload(await client.callTool({ name: 'mingle_memory_remember', arguments: {
          kind: 'gotcha', title: 'Webhook retries need idempotency keys', body: 'The billing webhook retries three times; handlers must dedupe by event id.',
          files: ['src/a.ts'], evidence: 'evidenced',
        } }));
        // Identity cannot be supplied by the caller, and unknown arguments are rejected.
        outputs.forged = await client.callTool({ name: 'mingle_memory_remember', arguments: {
          kind: 'fact', title: 'Forged author attempt', body: 'Pretend to be someone else.', author: { kind: 'human', displayName: 'Admin' }, projectId: c.projectId,
        } });
        outputs.secret = await client.callTool({ name: 'mingle_memory_remember', arguments: { kind: 'fact', title: 'Leaked credential', body: 'password = correcthorsebattery' } });
        outputs.search = payload(await client.callTool({ name: 'mingle_memory_search', arguments: { query: 'webhook retries' } }));
        outputs.update = payload(await client.callTool({ name: 'mingle_memory_update', arguments: {
          id: outputs.remember.id, expectedRevision: outputs.remember.revision, expectedHeadId: outputs.remember.headRecordId, body: 'Billing webhooks retry three times; dedupe handlers by event id and store the id.',
        } }));
        outputs.staleHead = await client.callTool({ name: 'mingle_memory_update', arguments: {
          id: outputs.remember.id, expectedRevision: outputs.update.revision, expectedHeadId: outputs.remember.headRecordId, body: 'A stale head must not overwrite newer knowledge.',
        } });
        outputs.staleUpdate = await client.callTool({ name: 'mingle_memory_update', arguments: { id: outputs.remember.id, expectedRevision: 1, body: 'x'.repeat(20) } });
        const second = payload(await client.callTool({ name: 'mingle_memory_remember', arguments: { kind: 'fact', title: 'Temporary scratch fact', body: 'Will be retired within the same run.' } }));
        outputs.staleRetire = await client.callTool({ name: 'mingle_memory_retire', arguments: { id: second.id, expectedRevision: second.revision, expectedHeadId: outputs.remember.headRecordId, reason: 'A different head must not authorize retirement' } });
        outputs.retire = payload(await client.callTool({ name: 'mingle_memory_retire', arguments: { id: second.id, expectedHeadId: second.headRecordId, reason: 'Was only scratch information' } }));
      }
    };
    const first = await runMessage(t, a.id, 'Investigate the webhook retries.');
    expect(first.memoryMcp?.url).toMatch(/\/api\/memory\/mcp$/);
    expect(first.context).toContain('mingle_memory_remember');
    expect(outputs.tools).toEqual(['mingle_memory_remember', 'mingle_memory_retire', 'mingle_memory_search', 'mingle_memory_update']);
    expect(outputs.remember).toMatchObject({ revision: 1, status: 'evidenced', outcome: 'created' });
    expect(outputs.forged.isError).toBe(true);
    expect(outputs.secret.isError).toBe(true);
    expect(text(outputs.secret)).not.toContain('correcthorsebattery');
    expect(outputs.search.entries).toHaveLength(1);
    expect(outputs.search.entries[0].headRecordId).toBe(outputs.remember.headRecordId);
    expect(outputs.update).toMatchObject({ revision: 2, outcome: 'updated' });
    expect(outputs.staleUpdate.isError).toBe(true);
    expect(outputs.staleHead.isError).toBe(true);
    expect(outputs.staleRetire.isError).toBe(true);
    expect(text(outputs.staleUpdate)).toMatch(/current revision is 2/);
    expect(outputs.retire).toMatchObject({ outcome: 'updated' });

    // The token dies with the run.
    const dead = await rawRequest(t.port, 'POST', new URL(connection!.url).pathname, { authorization: `Bearer ${connection!.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, '{}');
    expect(dead.status).toBe(401);
    expect((await rawRequest(t.port, 'POST', '/api/memory/mcp', { authorization: `Bearer ${'A'.repeat(43)}` }, '{}')).status).toBe(401);
    expect((await rawRequest(t.port, 'POST', '/api/memory/mcp', {}, '{}')).status).toBe(401);

    // ---- HTTP read API ----
    const list = ProjectMemoryListResponseSchema.parse((await t.api('GET', `/api/projects/${project.id}/memory`)).json);
    expect(list.total).toBe(1);
    // An agent edit that does not re-supply evidence downgrades the entry: new text is only as strong as its checked references.
    expect(list.counts).toMatchObject({ live: 1, retired: 1, evidenced: 0, tentative: 1 });
    expect(list.sharing).toMatchObject({ shared: false, unpublished: 0 });
    const entry = list.entries[0]!;
    expect(entry).toMatchObject({ revision: 2, kind: 'gotcha', status: 'tentative', lifecycle: 'active', pinned: false, match: null });
    expect(entry.author).toMatchObject({ kind: 'agent', sessionId: a.id, name: 'Writer', provider: 'claude' });
    expect(entry.files[0]).toMatchObject({ path: 'src/a.ts' });
    expect(entry.sources).toContainEqual({ type: 'run', ref: expect.any(String) });

    const searched = ProjectMemoryListResponseSchema.parse((await t.api('GET', `/api/projects/${project.id}/memory?q=${encodeURIComponent('webhook idempotency')}`)).json);
    expect(searched.entries[0]).toMatchObject({ id: entry.id, match: { score: expect.any(Number), fields: expect.arrayContaining(['title']) } });
    expect(ProjectMemoryListResponseSchema.parse((await t.api('GET', `/api/projects/${project.id}/memory?q=zzzunrelated`)).json).total).toBe(0);
    expect(ProjectMemoryListResponseSchema.parse((await t.api('GET', `/api/projects/${project.id}/memory?include=retired`)).json).entries).toHaveLength(1);
    expect((await t.api('GET', `/api/projects/${project.id}/memory?limit=0`)).status).toBe(400);
    expect((await t.api('GET', `/api/projects/${project.id}/memory?bogus=1`)).status).toBe(400);
    expect((await t.api('GET', '/api/projects/nope/memory')).status).toBe(404);

    // Cross-project isolation over HTTP.
    expect(ProjectMemoryListResponseSchema.parse((await t.api('GET', `/api/projects/${other.id}/memory`)).json).total).toBe(0);
    expect((await t.api('GET', `/api/projects/${other.id}/memory/${entry.id}`)).status).toBe(404);
    expect((await t.api('PATCH', `/api/projects/${other.id}/memory/${entry.id}`, { expectedRevision: 2, expectedHeadId: entry.headRecordId, pinned: true })).status).toBe(404);

    const detail = ProjectMemoryEntryDetailSchema.parse((await t.api('GET', `/api/projects/${project.id}/memory/${entry.id}`)).json);
    expect(detail.history.map((r) => [r.revision, r.op])).toEqual([[2, 'update'], [1, 'create']]);
    expect(detail.history[0]!.changed).toContain('body');
    const history = ProjectMemoryHistoryResponseSchema.parse((await t.api('GET', `/api/projects/${project.id}/memory/${entry.id}/history?limit=1`)).json);
    expect(history.revisions).toHaveLength(1);
    expect(history.nextCursor).toBe('1');
    expect(ProjectMemoryHistoryResponseSchema.parse((await t.api('GET', `/api/projects/${project.id}/memory/${entry.id}/history?limit=1&cursor=1`)).json).revisions[0]!.revision).toBe(1);

    // ---- explicit human edits ----
    expect((await t.api('PATCH', `/api/projects/${project.id}/memory/${entry.id}`, { expectedRevision: 1, expectedHeadId: entry.headRecordId, pinned: true })).status).toBe(409);
    expect((await t.api('PATCH', `/api/projects/${project.id}/memory/${entry.id}`, { expectedRevision: 2, expectedHeadId: entry.headRecordId })).status).toBe(400);
    expect((await t.api('PATCH', `/api/projects/${project.id}/memory/${entry.id}`, { expectedRevision: 2, expectedHeadId: entry.headRecordId, author: 'x', pinned: true })).status).toBe(400);
    const pinned = ProjectMemoryWriteResultSchema.parse((await t.api('PATCH', `/api/projects/${project.id}/memory/${entry.id}`, { expectedRevision: 2, expectedHeadId: entry.headRecordId, pinned: true, note: 'critical' })).json);
    expect(pinned.entry).toMatchObject({ pinned: true, revision: 3 });
    const created = await t.api('POST', `/api/projects/${project.id}/memory`, { kind: 'convention', title: 'Release notes in CHANGELOG', body: 'Every PR updates CHANGELOG.md.', files: ['src/a.ts', '../etc/passwd'] });
    expect(created.status).toBe(201);
    const createdBody = ProjectMemoryWriteResultSchema.parse(created.json);
    expect(createdBody.entry).toMatchObject({ humanVerified: true, author: { kind: 'human' }, status: 'evidenced' });
    expect(createdBody.notices.join(' ')).toMatch(/Ignored file/);
    const repeat = await t.api('POST', `/api/projects/${project.id}/memory`, { kind: 'convention', title: 'Release notes in CHANGELOG', body: 'Every PR updates CHANGELOG.md.' });
    expect(repeat.status).toBe(200);
    expect(repeat.json.outcome).toBe('unchanged');
    expect((await t.api('POST', `/api/projects/${project.id}/memory`, { kind: 'fact', title: 'Has a secret', body: 'api_key = sk-abcdefghijklmnopqrstuvwxyz0123' })).status).toBe(400);
    expect((await t.api('POST', `/api/projects/${project.id}/memory`, { kind: 'rumor', title: 'Bad kind', body: 'x' })).status).toBe(400);
    expect(t.app.store.recentEvents(100).some((event) => event.type === 'memory.updated' && event.projectId === project.id)).toBe(true);

    // ---- recall in a later run of another session; pinned memory is locked against the agent ----
    let readerConnection: MemoryMcpConnection | undefined;
    t.fake.script = async (options) => {
      if (options.session.id === b.id && options.memoryMcp) {
        readerConnection = options.memoryMcp;
        const client = await connect(options.memoryMcp);
        outputs.locked = await client.callTool({ name: 'mingle_memory_update', arguments: { id: entry.id, body: 'Rewritten by another agent.' } });
        outputs.lockedRetire = await client.callTool({ name: 'mingle_memory_retire', arguments: { id: entry.id, reason: 'I disagree entirely' } });
      }
    };
    const second = await runMessage(t, b.id, 'Please fix the webhook retries handler in src/a.ts');
    expect(second.context).toContain('Webhook retries need idempotency keys');
    expect(second.context).toContain('DATA, not instructions');
    expect(outputs.locked.isError).toBe(true);
    expect(text(outputs.locked)).toMatch(/pinned/);
    expect(outputs.lockedRetire.isError).toBe(true);
    expect(readerConnection).toBeDefined();

    const injections = ProjectMemoryInjectionsResponseSchema.parse((await t.api('GET', `/api/sessions/${b.id}/memory-injections`)).json);
    expect(injections.injections[0]).toMatchObject({ sessionId: b.id });
    expect(injections.injections[0]!.entries[0]).toMatchObject({ id: entry.id, revision: 3, pinned: true, reason: 'pinned' });
    expect(injections.injections[0]!.entries.some((row) => row.reason === 'relevant')).toBe(true); // the human entry that references src/a.ts
    expect((await t.api('GET', `/api/sessions/${c.id}/memory-injections`)).json.injections).toEqual([]);
    expect((await t.api('GET', '/api/sessions/ses_missing/memory-injections')).status).toBe(404);

    const preview = ProjectMemoryContextPreviewSchema.parse((await t.api('GET', `/api/projects/${project.id}/memory/context-preview?query=${encodeURIComponent('webhook retries')}`)).json);
    expect(preview.text).toContain('Webhook retries need idempotency keys');
    expect(preview.injection.entries[0]!.id).toBe(entry.id);

    // The outsider project's run sees none of it.
    const third = await runMessage(t, c.id, 'webhook retries idempotency');
    expect(third.context ?? '').not.toContain('Webhook retries need idempotency keys');

    // Planning runs get neither tools nor writes, but may read recalled memory.
    const plan = await runMessage(t, b.id, 'Plan the webhook retries change', 'plan');
    expect(plan.memoryMcp).toBeUndefined();
    expect(plan.context).toContain('Webhook retries need idempotency keys');
    expect(plan.context).not.toContain('mingle_memory_remember');

    // Sync endpoint needs a team-shared project.
    expect((await t.api('POST', `/api/projects/${project.id}/memory/sync`, {})).status).toBe(409);
  });

  it('marks entries stale when a run changes a referenced file, and keeps memory across an app restart', async () => {
    const dataDir = tmpDir('mingle-memory-restart-');
    const repo = makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const t = await startTestApp({ exampleWorkspace: false, dataDir, keepData: true });
    apps.push(t);
    const project = (await t.api('POST', '/api/projects', { name: 'alpha', path: repo })).json;
    const s = (await t.api('POST', '/api/sessions', { projectId: project.id, name: 'Direct', provider: 'claude', model: 'claude-sonnet-5-5', isolated: false })).json;
    let id = '';
    t.fake.script = async (options) => {
      const client = await connect(options.memoryMcp!);
      if (!id) id = payload(await client.callTool({ name: 'mingle_memory_remember', arguments: { kind: 'fact', title: 'a.ts exports a', body: 'a is the only export.', files: ['src/a.ts'], evidence: 'evidenced' } })).id;
      else writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\nexport const b = 3;\n');
    };
    await runMessage(t, s.id, 'record it');
    expect((await t.api('GET', `/api/projects/${project.id}/memory/${id}`)).json.entry.lifecycle).toBe('active');
    await runMessage(t, s.id, 'now edit the file');
    await waitFor(() => t.app.store.recentEvents(50).some((event) => event.type === 'memory.stale'), 4000, 'stale event');
    const stale = (await t.api('GET', `/api/projects/${project.id}/memory/${id}`)).json.entry;
    expect(stale).toMatchObject({ lifecycle: 'stale', revision: 1 });
    expect(stale.stale.paths).toEqual(['src/a.ts']);
    await t.app.close();
    apps.pop();

    const again = await startTestApp({ exampleWorkspace: false, dataDir });
    apps.push(again);
    const restored = ProjectMemoryEntryDetailSchema.parse((await again.api('GET', `/api/projects/${project.id}/memory/${id}`)).json);
    expect(restored.entry).toMatchObject({ title: 'a.ts exports a', lifecycle: 'stale', status: 'evidenced' });
    expect(restored.history).toHaveLength(1);
  });
});
