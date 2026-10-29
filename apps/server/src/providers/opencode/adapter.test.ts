import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpencodeAdapter } from './adapter.js';
import { clearExecutableCache } from '../discovery.js';
import { FakeChild, type FakeChildOptions, type Json } from '../testing/fake-child.js';
import { makeRun, text } from '../testing/helpers.js';

const TOKEN = 'synthetic-progress-capability-token';
const boxes: string[] = [];

async function fakeExecutable(directory: string): Promise<string> {
  const path = join(directory, 'opencode-fixture.mjs');
  await writeFile(path, `#!${process.execPath}\nif (process.argv[2] === '--version') process.stdout.write('opencode 1.19.3\\n');\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function connectionFor(http: boolean, taskEvents = false): NonNullable<FakeChildOptions['onMessage']> {
  return (message: Json, child: FakeChild) => {
    switch (message.method) {
      case 'initialize':
        child.send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'opencode', version: '1.19.3' }, agentCapabilities: { mcpCapabilities: { http } } } });
        break;
      case 'session/new':
        child.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'ses_parent12345678', configOptions: [{ id: 'model', category: 'model', currentValue: 'opencode/fixture', options: [{ value: 'opencode/fixture' }] }] } });
        break;
      case 'session/prompt':
        if (taskEvents) {
          child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_parent12345678', update: {
            sessionUpdate: 'tool_call', toolCallId: 'task-call', name: 'task', title: 'Inspect authentication', kind: 'task', status: 'in_progress',
            rawInput: { description: 'Inspect authentication', subagent_type: 'explore', prompt: 'Find the login flow' },
            rawOutput: { childSessionId: 'ses_child12345678' },
          } } });
          child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_child12345678', update: {
            sessionUpdate: 'agent_message_chunk', messageId: 'child-message', content: { type: 'text', text: 'Login is handled in auth.ts.' },
          } } });
          child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_child12345678', update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'child-read', name: 'read', title: 'Read auth module', kind: 'read', status: 'completed',
            rawInput: { file_path: 'src/auth.ts' }, rawOutput: { output: 'export function login() {}' },
          } } });
          child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_parent12345678', update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'task-call', name: 'task', title: 'Inspect authentication', kind: 'task', status: 'completed',
            rawInput: { description: 'Inspect authentication', subagent_type: 'explore', prompt: 'Find the login flow' }, rawOutput: 'Auth flow located.',
          } } });
          child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_parent12345678', update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The root answer.' },
          } } });
        }
        child.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
        break;
      case 'session/close':
        child.send({ jsonrpc: '2.0', id: message.id, result: {} });
        break;
      default:
        child.send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  };
}

async function runOpenCode(input: { http: boolean; taskEvents?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), 'mingle-opencode-adapter-test-'));
  boxes.push(directory);
  const executable = await fakeExecutable(directory);
  const run = makeRun({ session: { provider: 'opencode', model: 'default', effort: 'none', policy: 'supervised' } });
  run.options.settings.opencodeExecutable = executable;
  run.options.progressMcp = { url: 'http://127.0.0.1:4310/api/progress/mcp', token: TOKEN };
  const child = new FakeChild({ onMessage: connectionFor(input.http, input.taskEvents) });
  const spawned: { file: string; args: string[]; options: SpawnOptions }[] = [];
  const adapter = createOpencodeAdapter({
    env: { PATH: '/usr/bin', HOME: directory, MINGLE_DATA_DIR: directory },
    spawn: (file, args, options) => { spawned.push({ file, args, options }); return child; },
    timeoutMs: 1_500,
  });
  await adapter.run(run.options);
  return { run, child, spawned, directory };
}

afterEach(async () => {
  clearExecutableCache();
  for (const directory of boxes.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('OpenCode ACP adapter', () => {
  it('uses HTTP MCP when advertised', async () => {
    const { child } = await runOpenCode({ http: true });
    expect(child.requestsFor('session/new')[0]?.params.mcpServers).toEqual([{
      type: 'http', name: 'mingle_progress', url: 'http://127.0.0.1:4310/api/progress/mcp', headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
    }]);
  });

  it('uses an isolated stdio bridge and captures OpenCode task text and child tools', async () => {
    const { run, child } = await runOpenCode({ http: false, taskEvents: true });
    const servers = child.requestsFor('session/new')[0]?.params.mcpServers;
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'mingle_progress', command: process.execPath, args: [expect.stringContaining('mcp-stdio-')], env: [
      { name: 'MINGLE_MCP_URL', value: 'http://127.0.0.1:4310/api/progress/mcp' }, { name: 'MINGLE_MCP_TOKEN', value: TOKEN },
    ] });
    expect(text(run.events)).toBe('The root answer.');
    expect(run.events.filter((event) => event.type === 'subagent.text')).toEqual([
      { type: 'subagent.text', parentId: 'task-call', messageId: 'child-message', text: 'Login is handled in auth.ts.' },
    ]);
    expect(run.events.filter((event) => event.type === 'tool.activity').map((event) => event.activity)).toContainEqual(expect.objectContaining({
      id: 'task-call', name: 'task', category: 'agent', status: 'completed', input: expect.stringContaining('subagent_type'), output: 'Auth flow located.',
    }));
    expect(run.events.filter((event) => event.type === 'tool.activity').map((event) => event.activity)).toContainEqual(expect.objectContaining({
      id: 'subagent:ses_child12345678:child-read', name: 'read', category: 'file', parentId: 'task-call', output: 'export function login() {}',
    }));
  });
});
