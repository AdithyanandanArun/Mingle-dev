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

async function connect(timeoutMs: number, respond: boolean) {
  let proxy!: TeamMcpProxy;
  const calls: any[] = [];
  proxy = new TeamMcpProxy({
    async send(input) {
      calls.push(input);
      if (respond) queueMicrotask(() => proxy.resolve({ id: randomUUID(), teamId: TEAM, fromDeviceId: HOST, toDeviceId: randomUUID(),
        kind: 'teamgroup.tool.result', payload: { sharedProjectId: SHARED, deliveryId: DELIVERY,
          callId: (input.payload as any).callId, ok: true, result: { task: 'queued' } } }));
      return 'sent';
    },
    async sync() {},
  }, timeoutMs);
  proxies.push(proxy);
  const connection = await proxy.create({ teamId: TEAM, sharedProjectId: SHARED, hostDeviceId: HOST, deliveryId: DELIVERY, agentId: AGENT });
  const client = new Client({ name: 'device-team-test', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  const clientTransport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  });
  await client.connect(clientTransport);
  return { proxy, connection, client, calls };
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
});
