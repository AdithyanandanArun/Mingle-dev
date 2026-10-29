import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAntigravityAdapter } from './adapter.js';
import { FakeChild, type FakeChildOptions, type Json } from '../testing/fake-child.js';
import { makeRun } from '../testing/helpers.js';

const TOKEN = 'synthetic-progress-capability-token';
const boxes: string[] = [];

async function fakeRuntime(directory: string): Promise<string> {
  const executable = join(directory, 'agy_acp_server.par');
  const companion = join(directory, 'localharness_external');
  const script = `#!${process.execPath}\n`;
  await writeFile(executable, script, { mode: 0o700 });
  await writeFile(companion, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  await chmod(companion, 0o700);
  return executable;
}

function runtimeProtocol(http: boolean): NonNullable<FakeChildOptions['onMessage']> {
  let configOptions: Record<string, unknown>[] = [
    { id: 'model', category: 'model', currentValue: 'gemini-3.8-flash', options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] },
    { id: 'mode', category: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'auto_edit' }, { value: 'yolo' }] },
  ];
  return (message: Json, child: FakeChild) => {
    switch (message.method) {
      case 'initialize':
        child.send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.4.1' }, agentCapabilities: { mcpCapabilities: { http } } } });
        break;
      case 'session/new':
        child.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'agy-session-1', configOptions } });
        break;
      case 'session/set_config_option':
        configOptions = configOptions.map((option) => option.id === message.params.configId ? { ...option, currentValue: message.params.value } : option);
        child.send({ jsonrpc: '2.0', id: message.id, result: { configOptions } });
        break;
      case 'session/prompt':
        child.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
        break;
      default:
        child.send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  };
}

async function runAntigravity(http: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'mingle-antigravity-adapter-test-'));
  boxes.push(directory);
  const executable = await fakeRuntime(directory);
  const run = makeRun({ session: { provider: 'antigravity', model: 'default', effort: 'none', policy: 'supervised' } });
  run.options.settings.antigravityExecutable = executable;
  run.options.progressMcp = { url: 'http://127.0.0.1:4310/api/progress/mcp', token: TOKEN };
  const child = new FakeChild({ onMessage: runtimeProtocol(http) });
  const adapter = createAntigravityAdapter({
    env: { PATH: '/usr/bin', HOME: directory, XDG_CACHE_HOME: directory, MINGLE_DATA_DIR: directory },
    spawn: () => child,
    timeoutMs: 1_500,
  });
  await adapter.run(run.options);
  return { child };
}

afterEach(async () => { for (const directory of boxes.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('Antigravity ACP adapter MCP setup', () => {
  it('uses HTTP MCP when the runtime advertises it', async () => {
    const { child } = await runAntigravity(true);
    expect(child.requestsFor('session/new')[0]?.params.mcpServers).toEqual([{
      type: 'http', name: 'mingle_progress', url: 'http://127.0.0.1:4310/api/progress/mcp', headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
    }]);
  });

  it('uses a stdio MCP bridge when the runtime does not advertise HTTP', async () => {
    const { child } = await runAntigravity(false);
    const params = child.requestsFor('session/new')[0]?.params;
    expect(params.mcpServers).toMatchObject([{
      name: 'mingle_progress', command: process.execPath, args: [expect.stringContaining('mcp-stdio-')], env: [
        { name: 'MINGLE_MCP_URL', value: 'http://127.0.0.1:4310/api/progress/mcp' }, { name: 'MINGLE_MCP_TOKEN', value: TOKEN },
      ],
    }]);
    expect(params._meta.antigravity.eagerMcpServers).toEqual(['mingle_progress']);
  });
});
