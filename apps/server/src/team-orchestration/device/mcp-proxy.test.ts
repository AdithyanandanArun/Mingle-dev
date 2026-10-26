import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { TeamMcpProxy } from './mcp-proxy.ts';

const TEAM = randomUUID();
const SHARED = randomUUID();
const HOST = randomUUID();
const DELIVERY = 'delivery_mcp_test';
const AGENT = 'agent_mcp_test';
const proxies: TeamMcpProxy[] = [];
const clients: Client[] = [];

afterEach(async () => {
  while (clients.length) await clients.pop()!.close();
  while (proxies.length) await proxies.pop()!.close();
});

async function connect(timeoutMs: number, respond: boolean, prepareArtifact?: (input: any, signal: AbortSignal) => Promise<any>, sendGate?: () => Promise<void>) {
  let proxy!: TeamMcpProxy;
  const calls: any[] = [];
  let syncCount = 0;
  proxy = new TeamMcpProxy({
    async send(input) {
      calls.push(input);
      await sendGate?.();
      if (respond) queueMicrotask(() => proxy.resolve({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST, toDeviceId: randomUUID(),
        kind: 'teamgroup.tool.result', payload: { sharedProjectId: SHARED, deliveryId: DELIVERY,
          callId: (input.payload as any).callId, ok: true, result: { task: 'queued' } } }));
      return 'sent';
    },
    async sync() { syncCount += 1; },
  }, timeoutMs);
  proxies.push(proxy);
  const connection = await proxy.create({ teamId: TEAM, sharedProjectId: SHARED, hostDeviceId: HOST, deliveryId: DELIVERY, agentId: AGENT, prepareArtifact });
  const client = new Client({ name: 'device-team-test', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  const clientTransport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  });
  await client.connect(clientTransport);
  return { proxy, connection, client, calls, syncCount: () => syncCount };
}

describe('device team MCP proxy', () => {
  it('forwards typed tool calls to the host and returns the correlated result to the agent', async () => {
    const { client, calls } = await connect(500, true);
    const result = await client.callTool({ name: 'team_members', arguments: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ teamId: TEAM, toDeviceId: HOST, kind: 'teamgroup.tool.call', payload: {
      sharedProjectId: SHARED, deliveryId: DELIVERY, agentId: AGENT, tool: 'team_members', args: {},
    } });
    expect(result.content as any[]).toEqual([{ type: 'text', text: JSON.stringify({ task: 'queued' }) }]);
  });

  it('returns a bounded error to the agent when the host tool result times out', async () => {
    const { client, calls } = await connect(20, false);
    const result = await client.callTool({ name: 'team_inbox', arguments: {} });
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect((result.content as any[])[0]).toMatchObject({ type: 'text' });
    expect(((result.content as any[])[0] as { text: string }).text).toMatch(/bounded timeout/i);
  });

  it('exports a committed owner artifact before forwarding the typed tool call with transfer metadata', async () => {
    const { client, calls } = await connect(500, true, async (input) => {
      expect(calls).toHaveLength(0);
      expect(input).toMatchObject({ recipient: 'lead', path: 'index.html', taskId: 'task-1' });
      return { revision: 'a'.repeat(40), path: input.path, taskId: input.taskId, transferId: 'transfer-owner', ref: 'refs/mingle/team/owner-transfer' };
    });
    const result = await client.callTool({ name: 'team_artifact', arguments: {
      recipient: 'lead', path: 'index.html', revision: 'a'.repeat(40), taskId: 'task-1', note: 'Committed output',
    } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ payload: { tool: 'team_artifact', args: {
      recipient: 'lead', path: 'index.html', revision: 'a'.repeat(40), taskId: 'task-1',
      __mingleArtifactTransfer: { transferId: 'transfer-owner', path: 'index.html', taskId: 'task-1' },
    } } });
    expect(result.isError).toBeFalsy();
  });

  it('does not relay a prepared artifact after its delivery is interrupted during export', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const exporting = new Promise<void>((resolve) => { release = resolve; });
    const { proxy, client, calls } = await connect(500, true, async (_input, signal) => {
      entered();
      await exporting;
      expect(signal.aborted).toBe(true);
      return { revision: 'a'.repeat(40), path: 'index.html', transferId: 'cancelled-transfer' };
    });
    const result = client.callTool({ name: 'team_artifact', arguments: { recipient: 'lead', path: 'index.html', revision: 'a'.repeat(40) } });
    await started;
    proxy.closeDelivery(DELIVERY);
    release();
    const cancelled = await result;
    expect(cancelled.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('does not continue mailbox synchronization after interruption during transport send', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const sending = new Promise<void>((resolve) => { release = resolve; });
    const { proxy, client, calls, syncCount } = await connect(500, true, undefined, async () => {
      entered();
      await sending;
    });
    const result = client.callTool({ name: 'team_members', arguments: {} });
    await started;
    proxy.closeDelivery(DELIVERY);
    release();
    const cancelled = await result;
    expect(cancelled.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(syncCount()).toBe(0);
  });
});
