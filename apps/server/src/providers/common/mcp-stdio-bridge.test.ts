import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acpMcpServerConfigs, ensureMcpStdioBridgePath } from './mcp-stdio-bridge.js';

const TOKEN = 'synthetic-mcp-capability-token-never-print';
const running: ChildProcess[] = [];

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Fake MCP server did not bind a TCP port.'));
      else resolve(address.port);
    });
  });
}

function readJsonLines(child: ChildProcess): { next(): Promise<Record<string, unknown>> } {
  const queue: Record<string, unknown>[] = [];
  const waiters: ((value: Record<string, unknown>) => void)[] = [];
  let pending = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string | Buffer) => {
    pending += String(chunk);
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(value); else queue.push(value);
    }
  });
  return { next: () => queue.length ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve)) };
}

function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('error', reject);
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
  });
}

afterEach(async () => {
  for (const child of running.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

describe('ACP stdio MCP bridge', () => {
  it('selects HTTP when advertised and stdio otherwise', () => {
    const connection = { name: 'mingle_progress', url: 'http://127.0.0.1:4310/api/progress/mcp', token: TOKEN };
    expect(acpMcpServerConfigs([connection], { supportsHttp: true, bridgePath: '/private/bridge.mjs' })).toEqual([{
      type: 'http', name: connection.name, url: connection.url, headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
    }]);
    expect(acpMcpServerConfigs([connection], { supportsHttp: false, bridgePath: '/private/bridge.mjs', command: '/runtime/node', electronRunAsNode: true })).toEqual([{
      name: connection.name, command: '/runtime/node', args: ['/private/bridge.mjs'],
      env: [
        { name: 'MINGLE_MCP_URL', value: connection.url }, { name: 'MINGLE_MCP_TOKEN', value: TOKEN },
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      ],
    }]);
    expect(acpMcpServerConfigs([], { supportsHttp: false })).toEqual([]);
  });

  it('round-trips initialize, notification, tools/list and tools/call without echoing the bearer token', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'mingle-mcp-bridge-test-'));
    const authorizations: string[] = [];
    const methods: string[] = [];
    let notificationSeen!: () => void;
    const notificationReceived = new Promise<void>((resolve) => { notificationSeen = resolve; });
    const server = createServer(async (request, response: ServerResponse) => {
      const body = await requestBody(request);
      authorizations.push(String(request.headers.authorization ?? ''));
      methods.push(String(body.method));
      if (!Object.prototype.hasOwnProperty.call(body, 'id')) {
        notificationSeen();
        response.writeHead(202).end();
        return;
      }
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'fixture_tool', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: `result contains ${TOKEN}` }] };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });

    let child: ChildProcess | undefined;
    try {
      const port = await listen(server);
      const bridgePath = await ensureMcpStdioBridgePath({ MINGLE_DATA_DIR: dataDirectory });
      const permissions = (await stat(bridgePath)).mode & 0o777;
      expect(permissions).toBe(0o700);
      child = spawn(process.execPath, [bridgePath], {
        env: { MINGLE_MCP_URL: `http://127.0.0.1:${port}/mcp`, MINGLE_MCP_TOKEN: TOKEN },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      running.push(child);
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string | Buffer) => { stderr += String(chunk); });
      const output = readJsonLines(child);
      const send = (message: Record<string, unknown>) => child!.stdin!.write(`${JSON.stringify(message)}\n`);

      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
      expect(await output.next()).toMatchObject({ id: 1, result: { serverInfo: { name: 'fake-mcp' } } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await notificationReceived;
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(await output.next()).toMatchObject({ id: 2, result: { tools: [{ name: 'fixture_tool' }] } });
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fixture_tool', arguments: {} } });
      const call = await output.next();
      expect(call).toMatchObject({ id: 3, result: { content: [{ type: 'text', text: 'result contains [redacted]' }] } });
      expect(JSON.stringify(call).includes(TOKEN)).toBe(false);
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
      expect(authorizations).toEqual(Array(4).fill(`Bearer ${TOKEN}`));
      child.stdin?.end();
      await new Promise<void>((resolve, reject) => {
        child!.once('error', reject);
        child!.once('close', () => resolve());
      });
      expect(stderr).toBe('');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
