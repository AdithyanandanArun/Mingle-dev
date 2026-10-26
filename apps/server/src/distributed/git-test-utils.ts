import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { gitNullPath } from '../git-null-path.ts';
import { openDatabase } from '../db.ts';
import { Store } from '../store.ts';
import { tmpDir } from '../test-utils.ts';
import type { DistributedServiceOptions, DeviceTransport } from './git-common.ts';

export interface SentEnvelope { teamId: string; toDeviceId: string; kind: string; payload: any; idempotencyKey: string }
export interface OwnerFixture {
  root: string; store: Store; db: DatabaseSync; projectId: string; userId: string; deviceFor: (teamId: string) => string;
  messages: SentEnvelope[]; options: DistributedServiceOptions; revokedTeams: Set<string>; revokedPeers: Set<string>; trustedDevices: Set<string>;
  close(): void;
}

export function makeOwner(root: string, userId: string, devicePrefix: string): OwnerFixture {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  const project = store.insertProject({ name: 'test owner workspace', path: root });
  const messages: SentEnvelope[] = [];
  const revokedTeams = new Set<string>();
  const revokedPeers = new Set<string>();
  const trustedDevices = new Set<string>();
  const deviceFor = (teamId: string) => `${devicePrefix}-${teamId}`;
  const transport: DeviceTransport = {
    snapshot(teamId) { return { deviceId: teamId ? deviceFor(teamId) : `${devicePrefix}-unscoped` }; },
    async send(input) { messages.push(input); return { accepted: true }; },
  };
  const options: DistributedServiceOptions = {
    store,
    account: { withAuthenticatedClient: async (callback) => callback(null, { id: userId }) },
    transport,
    workspace: { getProject: (id) => store.getProject(id) },
    authorizeTeam: async ({ teamId, peerDeviceId }) => {
      if (revokedTeams.has(teamId)) throw new Error('team membership revoked');
      if (peerDeviceId && revokedPeers.has(`${teamId}:${peerDeviceId}`)) throw new Error('mutual device link revoked');
    },
    authorizeTeamArtifact: async ({ teamId, peerDeviceId }) => {
      if (revokedTeams.has(teamId)) throw new Error('team membership revoked');
      if (revokedPeers.has(`${teamId}:${peerDeviceId}`)) throw new Error('mutual device link revoked');
      if (!trustedDevices.has(peerDeviceId)) throw new Error('peer is not the active owner of this team delivery');
    },
  };
  return { root, store, db, projectId: project.id, userId, deviceFor, messages, options, revokedTeams, revokedPeers,
    trustedDevices,
    close() { try { store.close(); } catch { /* test cleanup */ } rmSync(root, { recursive: true, force: true }); } };
}

export function createTempRoot(): string { return tmpDir('mingle-distributed-test-'); }

export function envelope(input: {
  id?: string; teamId: string; fromDeviceId: string; toDeviceId: string; kind: string; payload: unknown;
}) {
  return { id: input.id ?? `env-${Math.random().toString(36).slice(2)}`, ...input };
}

export function setGitIdentity(root: string): void {
  importRunGit(root, ['config', 'user.name', 'Distributed Test']);
  importRunGit(root, ['config', 'user.email', 'distributed-test@example.invalid']);
}

export function importRunGit(root: string, args: string[]): string {
  // Keep tests on argv-based Git just like the service boundary.
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: gitNullPath(), GIT_CONFIG_NOSYSTEM: '1' } });
}
