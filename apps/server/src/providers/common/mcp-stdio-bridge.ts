import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface HttpMcpConnection { name: string; url: string; token: string }

const BRIDGE_SOURCE = String.raw`const TOKEN = process.env.MINGLE_MCP_TOKEN || '';
const ENDPOINT = process.env.MINGLE_MCP_URL || '';
const MAX_LINE = 16 * 1024 * 1024;
const MAX_BODY = 16 * 1024 * 1024;
let buffer = '';
let discarding = false;
let ended = false;
let inFlight = 0;
const controllers = new Set();
let endpoint;
try {
  endpoint = new URL(ENDPOINT);
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname) || !TOKEN) throw new Error();
} catch {
  process.exitCode = 1;
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => {});
}
function write(value) {
  if (!ended) {
    const serialized = JSON.stringify(value);
    process.stdout.write((TOKEN ? serialized.split(TOKEN).join('[redacted]') : serialized) + '\n');
  }
}
function errorReply(id, code, message) {
  if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code, message } });
}
function decodeLine(line) {
  let message;
  try { message = JSON.parse(line); }
  catch { errorReply(null, -32700, 'Invalid JSON-RPC message'); return; }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    errorReply(message && typeof message === 'object' ? message.id : null, -32600, 'Invalid JSON-RPC request');
    return;
  }
  void forward(message);
}
async function readLimited(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (output.length > MAX_BODY) { await reader.cancel(); throw new Error('response limit'); }
  }
  output += decoder.decode();
  if (output.length > MAX_BODY) throw new Error('response limit');
  return output;
}
function emitData(data) {
  if (!data || data === '[DONE]') return;
  try {
    const message = JSON.parse(data);
    if (message && typeof message === 'object') write(message);
  } catch { /* Ignore non-JSON event data; never copy transport diagnostics to stdout. */ }
}
async function readEvents(response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      emitData(data);
    }
    if (done) break;
  }
  if (pending) {
    const data = pending.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    emitData(data);
  }
}
async function forward(message) {
  const id = Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : undefined;
  if (inFlight >= 64) { errorReply(id, -32000, 'Too many in-flight MCP requests'); return; }
  const controller = new AbortController();
  controllers.add(controller);
  inFlight += 1;
  try {
    const response = await fetch(endpoint, {
      method: 'POST', signal: controller.signal,
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(message),
    });
    if (response.status === 202 || response.status === 204) {
      if (id !== undefined) errorReply(id, -32603, 'MCP endpoint returned no response');
      return;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      errorReply(id, -32000, 'MCP endpoint returned HTTP ' + response.status);
      return;
    }
    if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      await readEvents(response);
      return;
    }
    const body = await readLimited(response);
    if (!body) {
      if (id !== undefined) errorReply(id, -32603, 'MCP endpoint returned an empty response');
      return;
    }
    let result;
    try { result = JSON.parse(body); }
    catch { errorReply(id, -32603, 'MCP endpoint returned invalid JSON-RPC'); return; }
    if (Array.isArray(result)) {
      for (const message of result) if (message && typeof message === 'object') write(message);
    } else if (result && typeof result === 'object') write(result);
  } catch {
    errorReply(id, -32000, 'MCP endpoint request failed');
  } finally {
    controllers.delete(controller);
    inFlight -= 1;
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (discarding) { discarding = false; continue; }
    if (line.length > MAX_LINE) continue;
    if (line.trim()) decodeLine(line);
  }
  if (buffer.length > MAX_LINE) { buffer = ''; discarding = true; }
});
process.stdin.on('end', () => {
  ended = true;
  for (const controller of controllers) controller.abort();
});
process.stdin.resume();
`;

export async function ensureMcpStdioBridgePath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dataDirectory = env.MINGLE_DATA_DIR?.trim() || env.RELAY_DATA_DIR?.trim() || join(homedir(), '.mingle');
  const directory = join(resolve(dataDirectory), 'provider-bridges');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const digest = createHash('sha256').update(BRIDGE_SOURCE).digest('hex').slice(0, 16);
  const path = join(directory, `mcp-stdio-${digest}.mjs`);
  try { await writeFile(path, BRIDGE_SOURCE, { flag: 'wx', mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await chmod(path, 0o700);
  return path;
}

export function acpMcpServerConfigs(
  connections: readonly HttpMcpConnection[],
  options: { supportsHttp: boolean; bridgePath?: string; command?: string; electronRunAsNode?: boolean },
): Record<string, unknown>[] {
  if (options.supportsHttp) return connections.map((connection) => ({
    type: 'http', name: connection.name, url: connection.url,
    headers: [{ name: 'Authorization', value: `Bearer ${connection.token}` }],
  }));
  if (!connections.length) return [];
  if (!options.bridgePath) throw new Error('An MCP stdio bridge path is required when HTTP MCP is unavailable.');
  const command = options.command ?? process.execPath;
  const electron = options.electronRunAsNode ?? Boolean(process.versions.electron);
  return connections.map((connection) => ({
    name: connection.name,
    command,
    args: [options.bridgePath!],
    env: [
      { name: 'MINGLE_MCP_URL', value: connection.url },
      { name: 'MINGLE_MCP_TOKEN', value: connection.token },
      ...(electron ? [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] : []),
    ],
  }));
}
