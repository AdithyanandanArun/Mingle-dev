import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AdapterEvent, AgentAdapter, AppSettings, Provider, ProviderInfo, RunOptions } from '@mingle/contracts';
import { gitNullPath } from './git-null-path.ts';
import { createApplication, type ApplicationOptions, type MingleApplication } from './app.ts';
import type { ProviderRuntime } from './types.ts';

export type Script = (options: RunOptions, emit: (event: AdapterEvent) => void) => Promise<void>;

/** Scriptable stand-in for the provider module; never starts a real model or child process. */
export class FakeProviders implements ProviderRuntime {
  runs: RunOptions[] = [];
  catalogSkills: import('@mingle/contracts').ProviderSkill[] = [];
  script: Script = async (_o, emit) => { emit({ type: 'text', text: 'ok' }); };
  detections = 0;
  createAdapter(_provider: Provider): AgentAdapter {
    return { run: async (options) => { this.runs.push(options); await this.script(options, options.onEvent); } };
  }
  async detectProviders(_settings: AppSettings): Promise<ProviderInfo[]> {
    this.detections++;
    return [
      { id: 'codex', name: 'Codex', available: false, version: null, executable: null, reason: 'fake: not installed', models: [] },
      { id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null, models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet' }] },
    ];
  }
  async getCatalog() { return { commands: [], skills: this.catalogSkills, warnings: [] }; }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 4000, label = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: gitNullPath(), GIT_CONFIG_NOSYSTEM: '1' };

export function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
}

export function tmpDir(prefix = 'mingle-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Creates a committed Git repository with the given files. */
export function makeRepo(files: Record<string, string> = { 'README.md': '# repo\n' }): string {
  const dir = tmpDir('mingle-repo-');
  runGit(dir, 'init', '-q', '--initial-branch=main');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  runGit(dir, 'add', '-A');
  runGit(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

export interface ApiResponse<T = any> { status: number; json: T; headers: http.IncomingHttpHeaders }

export interface TestApp {
  app: MingleApplication;
  fake: FakeProviders;
  dataDir: string;
  url: string;
  port: number;
  api<T = any>(method: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  cleanup(): Promise<void>;
}

export function rawRequest(port: number, method: string, route: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function startTestApp(options: Partial<ApplicationOptions> & { dataDir?: string; fake?: FakeProviders; keepData?: boolean } = {}): Promise<TestApp> {
  const dataDir = options.dataDir ?? tmpDir('mingle-data-');
  const fake = options.fake ?? new FakeProviders();
  const app = createApplication({
    dataDir, port: 0, webDistDir: null, providers: fake, log: () => undefined, runtime: { abortGraceMs: 250, flushIntervalMs: 20 }, detectOnStart: false, ...options,
  });
  const { port, url } = await app.listen();
  const api = async <T = any>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> => {
    const res = await rawRequest(port, method, route, headers, body === undefined ? undefined : JSON.stringify(body));
    let json: any = null;
    try { json = res.text ? JSON.parse(res.text) : null; } catch { json = res.text; }
    return { status: res.status, json, headers: res.headers };
  };
  return {
    app, fake, dataDir, url, port, api,
    async cleanup() {
      await app.close();
      if (!options.keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
