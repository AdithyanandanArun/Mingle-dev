import { spawn } from 'node:child_process';
import path from 'node:path';
import type { AppSettings, ProviderCatalog, ProviderSkill, Session } from '@mingle/contracts';
import { cleanEnv, isRecord, redactSecrets, truncate } from '../common.js';
import { resolveExecutableCached } from '../discovery.js';
import { shutdownChild, type ChildLike } from '../process.js';
import { JsonRpcConnection } from './rpc.js';

const CATALOG_TIMEOUT_MS = 15_000;

function warningsFromSkills(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  return value.data.slice(0, 20).flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.errors)) return [];
    return entry.errors.slice(0, 20).flatMap((error) => {
      if (!isRecord(error) || typeof error.message !== 'string') return [];
      return [`Codex skill discovery: ${truncate(redactSecrets(error.message), 300)}`];
    });
  }).slice(0, 40);
}

function parseCodexSkills(value: unknown): ProviderSkill[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  const skills: ProviderSkill[] = [];
  for (const entry of value.data.slice(0, 20)) {
    if (!isRecord(entry) || !Array.isArray(entry.skills)) continue;
    for (const skill of entry.skills.slice(0, 500)) {
      if (!isRecord(skill) || typeof skill.path !== 'string' || !path.isAbsolute(skill.path) || skill.path.length > 4096) continue;
      if (typeof skill.name !== 'string' || !skill.name.trim()) continue;
      const scope = skill.scope;
      const source: ProviderSkill['source'] = scope === 'repo' ? 'project' : scope === 'user' ? 'user' : 'provider';
      skills.push({
        // Native invocation uses the absolute SKILL.md path as its stable identity.
        id: skill.path,
        path: skill.path,
        name: truncate(skill.name.trim(), 150),
        description: truncate(typeof skill.description === 'string' ? redactSecrets(skill.description) : '', 1_000),
        source,
        enabled: skill.enabled === true,
      });
      if (skills.length >= 1_000) return skills;
    }
  }
  return skills;
}

/** Read Codex's native model and skill catalogs. Slash commands are not exposed as prompt aliases. */
export async function getCodexCatalog(session: Session, settings: AppSettings): Promise<ProviderCatalog> {
  const result: ProviderCatalog = { commands: [], skills: [], warnings: [] };
  const resolved = await resolveExecutableCached({ name: 'codex', override: settings.codexExecutable });
  if (!resolved.ok) {
    result.warnings.push(truncate(redactSecrets(resolved.reason), 500));
    return result;
  }

  let child: ChildLike | undefined;
  let conn: JsonRpcConnection | undefined;
  try {
    const env = cleanEnv(process.env, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']);
    child = spawn(resolved.executable.path, ['app-server'], {
      cwd: session.worktreePath, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    }) as unknown as ChildLike;
    conn = new JsonRpcConnection(child, {
      onNotification: () => undefined,
      onRequest: async () => { throw new Error('Unsupported app-server request during catalog discovery'); },
      formatClose: () => 'Codex app-server exited during catalog discovery.',
      onIssue: (message) => result.warnings.push(truncate(redactSecrets(message), 300)),
    });
    await conn.request('initialize', {
      clientInfo: { name: 'mingle', title: 'Mingle', version: '0.0.1' },
      capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
    }, CATALOG_TIMEOUT_MS);
    conn.notify('initialized', {});
    const skills = await conn.request('skills/list', { cwds: [session.worktreePath], forceReload: true }, CATALOG_TIMEOUT_MS);
    // Catalog requests intentionally do not mutate provider configuration or execute model turns.
    result.skills = parseCodexSkills(skills);
    result.warnings.push(...warningsFromSkills(skills));
  } catch (error) {
    result.warnings.push(`Codex catalog unavailable: ${truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 400)}`);
  } finally {
    if (child && conn) {
      await shutdownChild(child, { closed: conn.closed, group: process.platform !== 'win32', graceMs: 500, termMs: 1_000, killMs: 1_000 });
    }
  }
  return result;
}
