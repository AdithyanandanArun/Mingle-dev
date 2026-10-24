import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitBundleChunkSchema, GitTransferOfferSchema } from '../../../../packages/contracts/src/remote-git.ts';
import { makeRepo } from '../test-utils.ts';
import { RemoteCommandService } from './commands.ts';
import {
  BUNDLE_CHUNK_BYTES, fingerprintRepository, MAX_BUNDLE_BYTES, runGit,
} from './git-common.ts';
import { GitSyncService } from './git-sync.ts';
import { RepositoryService } from '../repository/service.ts';
import { WorkspaceService } from '../workspace.ts';
import {
  canonicalJson, MAX_DISTRIBUTED_PAYLOAD_BYTES,
} from './crypto.ts';
import { envelope, importRunGit, makeOwner, setGitIdentity, type OwnerFixture } from './git-test-utils.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function makePair(labels = { source: 'source workspace', destination: 'destination workspace' }) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'mingle-git-workflow-'));
  const basePath = makeRepo({ 'README.md': 'shared base\n' });
  const sourceRoot = path.join(parent, labels.source);
  const destinationRoot = path.join(parent, labels.destination);
  execFileSync('git', ['clone', '-q', basePath, sourceRoot], { cwd: parent });
  execFileSync('git', ['clone', '-q', basePath, destinationRoot], { cwd: parent });
  setGitIdentity(sourceRoot);
  setGitIdentity(destinationRoot);
  const source = makeOwner(sourceRoot, 'workflow-source-owner', 'workflow-source');
  const destination = makeOwner(destinationRoot, 'workflow-destination-owner', 'workflow-destination');
  cleanups.push(() => {
    source.close(); destination.close();
    rmSync(parent, { recursive: true, force: true });
    rmSync(basePath, { recursive: true, force: true });
  });
  return { parent, basePath, source, destination };
}

async function bindPair(source: OwnerFixture, destination: OwnerFixture, teamId = 'team-workflow', sharedProjectId = 'shared-workflow') {
  const sourceService = new GitSyncService(source.options);
  const destinationService = new GitSyncService(destination.options);
  await sourceService.bindProject({ teamId, sharedProjectId, localProjectId: source.projectId });
  await destinationService.bindProject({ teamId, sharedProjectId, localProjectId: destination.projectId });
  return { sourceService, destinationService, teamId, sharedProjectId };
}

function transferInput(source: OwnerFixture, destination: OwnerFixture, teamId: string, sharedProjectId: string, idempotencyKey?: string) {
  return {
    teamId, sharedProjectId, toDeviceId: destination.deviceFor(teamId),
    expectedHead: importRunGit(source.root, ['rev-parse', 'HEAD']).trim(),
    baseHead: importRunGit(source.root, ['rev-parse', 'HEAD^']).trim(),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

async function receiveOffer(source: OwnerFixture, destination: OwnerFixture, pair: Awaited<ReturnType<typeof bindPair>>, payload?: unknown) {
  const offerMessage = [...source.messages].reverse().find((message) => message.kind === 'git.offer')!;
  await pair.destinationService.onEnvelope(envelope({
    teamId: pair.teamId, fromDeviceId: source.deviceFor(pair.teamId), toDeviceId: destination.deviceFor(pair.teamId),
    kind: offerMessage.kind, payload: payload ?? offerMessage.payload,
  }));
  return (await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.direction === 'incoming')!;
}

async function approveBoth(source: OwnerFixture, destination: OwnerFixture, pair: Awaited<ReturnType<typeof bindPair>>, offerId: string, incomingId: string) {
  const sourceRequest = (await pair.sourceService.snapshot(pair.teamId)).requests.find((request) => request.id === offerId)!;
  const incoming = (await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.id === incomingId)!;
  await pair.sourceService.decide({ requestId: sourceRequest.id, decision: 'approved', expectedDigest: sourceRequest.requestDigest });
  expect(source.messages.filter((message) => message.kind === 'git.bundle.chunk')).toHaveLength(0);
  await pair.destinationService.decide({ requestId: incoming.id, decision: 'approved', expectedDigest: incoming.requestDigest });
  const approval = [...destination.messages].reverse().find((message) => message.kind === 'git.import-approved')!;
  await pair.sourceService.onEnvelope(envelope({
    teamId: pair.teamId, fromDeviceId: destination.deviceFor(pair.teamId), toDeviceId: source.deviceFor(pair.teamId),
    kind: approval.kind, payload: approval.payload,
  }));
  return source.messages.filter((message) => message.kind === 'git.bundle.chunk');
}

async function deliverChunks(
  source: OwnerFixture,
  destination: OwnerFixture,
  pair: Awaited<ReturnType<typeof bindPair>>,
  chunks: OwnerFixture['messages'],
) {
  for (const chunk of chunks) await pair.destinationService.onEnvelope(envelope({
    teamId: pair.teamId, fromDeviceId: source.deviceFor(pair.teamId), toDeviceId: destination.deviceFor(pair.teamId),
    kind: chunk.kind, payload: chunk.payload,
  }));
}

function installProductionSizeBoundary(owner: OwnerFixture): void {
  const send = owner.options.transport.send;
  owner.options.transport = {
    ...owner.options.transport,
    async send(input) {
      const payloadJson = canonicalJson(input.payload);
      if (Buffer.byteLength(payloadJson, 'utf8') > MAX_DISTRIBUTED_PAYLOAD_BYTES) {
        throw new RangeError('Distributed payload exceeds the 256 KiB limit.');
      }
      return send(input);
    },
  };
}

describe('distributed Git workflow acceptance (disposable local repositories)', () => {
  it('sends 128 KiB binary chunks through the production payload-size boundary, resumes out-of-order receive, and imports only an isolated ref', async () => {
    const { source, destination } = makePair();
    const feature = randomBytes(700 * 1024);
    writeFileSync(path.join(source.root, 'large-feature.bin'), feature);
    importRunGit(source.root, ['add', 'large-feature.bin']);
    importRunGit(source.root, ['commit', '-q', '-m', 'large committed feature']);
    installProductionSizeBoundary(source);
    const pair = await bindPair(source, destination);
    const originalDestinationHead = importRunGit(destination.root, ['rev-parse', 'HEAD']).trim();
    const offer = await pair.sourceService.request(transferInput(source, destination, pair.teamId, pair.sharedProjectId));
    const incoming = await receiveOffer(source, destination, pair);
    const chunks = await approveBoth(source, destination, pair, offer.id, incoming.id);

    expect(BUNDLE_CHUNK_BYTES).toBe(128 * 1024);
    expect(MAX_BUNDLE_BYTES / BUNDLE_CHUNK_BYTES).toBe(128);
    expect(GitTransferOfferSchema.parse({
      requestId: offer.id, sharedProjectId: pair.sharedProjectId, sourceHead: offer.sourceHead,
      baseHead: offer.baseHead, branch: offer.branch ?? null, bundleSha256: offer.bundleSha256,
      bundleSizeBytes: MAX_BUNDLE_BYTES, chunkCount: 128,
    }).chunkCount).toBe(128);
    const finalChunk = GitBundleChunkSchema.parse({ requestId: offer.id, index: 127, chunkCount: 128, data: Buffer.alloc(BUNDLE_CHUNK_BYTES).toString('base64') });
    expect(finalChunk.index).toBe(127);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.every((chunk) => Buffer.byteLength(canonicalJson(chunk.payload), 'utf8') <= MAX_DISTRIBUTED_PAYLOAD_BYTES)).toBe(true);
    expect(chunks.every((chunk) => Buffer.byteLength((chunk.payload as { data: string }).data, 'base64') <= BUNDLE_CHUNK_BYTES)).toBe(true);
    expect(chunks.every((chunk) => (chunk.payload as { chunkCount: number }).chunkCount === chunks.length)).toBe(true);
    expect(source.messages.filter((message) => message.kind === 'git.bundle.chunk')).toHaveLength(chunks.length);

    const first = chunks.find((chunk) => (chunk.payload as { index: number }).index === 0)!;
    await deliverChunks(source, destination, pair, [first]);
    await deliverChunks(source, destination, pair, [first]); // exact duplicate is idempotent before completion
    expect((await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.id === incoming.id)?.status).toBe('receiving');

    // A service reconstruction represents a local server restart. Incomplete immutable chunks are safe to resume.
    pair.destinationService = new GitSyncService(destination.options);
    const rest = chunks.filter((chunk) => chunk !== first).reverse();
    await deliverChunks(source, destination, pair, rest);
    const imported = (await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.id === incoming.id)!;
    expect(imported.status).toBe('imported');
    expect(importRunGit(destination.root, ['rev-parse', 'HEAD']).trim()).toBe(originalDestinationHead);
    expect(() => readFileSync(path.join(destination.root, 'large-feature.bin'))).toThrow();
    expect(importRunGit(destination.root, ['rev-parse', `refs/mingle/incoming/${incoming.id}`]).trim()).toBe(offer.sourceHead);
    expect(readFileSync(path.join(source.root, 'large-feature.bin'))).toEqual(feature);
  });

  it('rejects changed idempotent intent and inconsistent offer dimensions before destination approval', async () => {
    const { source, destination } = makePair();
    writeFileSync(path.join(source.root, 'feature.txt'), 'committed feature\n');
    importRunGit(source.root, ['add', 'feature.txt']);
    importRunGit(source.root, ['commit', '-q', '-m', 'feature']);
    const pair = await bindPair(source, destination);
    const request = transferInput(source, destination, pair.teamId, pair.sharedProjectId, 'stable-transfer-key');
    const created = await pair.sourceService.request(request);
    expect((await pair.sourceService.request(request)).id).toBe(created.id);
    await expect(pair.sourceService.request({ ...request, expectedHead: 'f'.repeat(40) })).rejects.toThrow(/idempotency key.*different/i);
    await expect(pair.sourceService.request({ ...request, toDeviceId: 'another-linked-device' })).rejects.toThrow(/idempotency key.*different/i);
    expect(source.messages.filter((message) => message.kind === 'git.offer')).toHaveLength(1);

    const offerMessage = source.messages.find((message) => message.kind === 'git.offer')!;
    const payload = offerMessage.payload as Record<string, unknown>;
    await expect(receiveOffer(source, destination, pair, { ...payload, chunkCount: Number(payload.chunkCount) + 1 }))
      .rejects.toThrow(/chunk dimensions/i);
    expect((await pair.destinationService.snapshot(pair.teamId)).requests).toHaveLength(0);
    const valid = await receiveOffer(source, destination, pair);
    expect(valid.status).toBe('awaiting-destination-approval');
  });

  it('keeps dirty source files out of the bundle and refuses destination changes after import approval', async () => {
    const { source, destination } = makePair();
    writeFileSync(path.join(source.root, 'committed.txt'), 'approved source object\n');
    importRunGit(source.root, ['add', 'committed.txt']);
    importRunGit(source.root, ['commit', '-q', '-m', 'committed source object']);
    writeFileSync(path.join(source.root, 'source-only-uncommitted.txt'), 'must not transfer\n');
    writeFileSync(path.join(destination.root, 'README.md'), 'destination local edit\n');
    writeFileSync(path.join(destination.root, 'destination-untracked.txt'), 'preserve this too\n');
    const pair = await bindPair(source, destination);
    const offer = await pair.sourceService.request(transferInput(source, destination, pair.teamId, pair.sharedProjectId));
    const incoming = await receiveOffer(source, destination, pair);
    const chunks = await approveBoth(source, destination, pair, offer.id, incoming.id);
    expect(chunks.length).toBeGreaterThan(0);

    // Change HEAD after the receiving owner approved its reviewed fingerprint, while retaining the pre-existing dirty files.
    writeFileSync(path.join(destination.root, 'destination-advance.txt'), 'new local commit after approval\n');
    importRunGit(destination.root, ['add', 'destination-advance.txt']);
    importRunGit(destination.root, ['commit', '-q', '-m', 'advance destination after approval', '--', 'destination-advance.txt']);
    const changedHead = importRunGit(destination.root, ['rev-parse', 'HEAD']).trim();
    const dirtyBeforeImport = importRunGit(destination.root, ['status', '--porcelain=v1', '-z']);
    await deliverChunks(source, destination, pair, chunks);
    const stale = (await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.id === incoming.id)!;
    expect(stale.status).toBe('stale');
    expect(importRunGit(destination.root, ['rev-parse', 'HEAD']).trim()).toBe(changedHead);
    expect(importRunGit(destination.root, ['status', '--porcelain=v1', '-z'])).toBe(dirtyBeforeImport);
    expect(readFileSync(path.join(destination.root, 'README.md'), 'utf8')).toBe('destination local edit\n');
    expect(readFileSync(path.join(destination.root, 'destination-untracked.txt'), 'utf8')).toBe('preserve this too\n');
    await expect(runGit(destination.root, ['rev-parse', `refs/mingle/incoming/${incoming.id}`], { allowFailure: true })).resolves.toMatchObject({ code: 128 });
    await expect(runGit(destination.root, ['cat-file', '-e', `${offer.sourceHead}:source-only-uncommitted.txt`], { allowFailure: true })).resolves.toMatchObject({ code: 128 });
  });

  it('refuses merge integration when the destination owner has uncommitted work', async () => {
    const { source, destination } = makePair();
    writeFileSync(path.join(source.root, 'incoming-only.txt'), 'source commit\n');
    importRunGit(source.root, ['add', 'incoming-only.txt']);
    importRunGit(source.root, ['commit', '-q', '-m', 'incoming only']);
    writeFileSync(path.join(destination.root, 'owner-edit.txt'), 'uncommitted owner work\n');
    const pair = await bindPair(source, destination);
    const offer = await pair.sourceService.request(transferInput(source, destination, pair.teamId, pair.sharedProjectId));
    const incoming = await receiveOffer(source, destination, pair);
    const chunks = await approveBoth(source, destination, pair, offer.id, incoming.id);
    await deliverChunks(source, destination, pair, chunks);
    expect((await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.id === incoming.id)?.status).toBe('imported');
    const before = await fingerprintRepository(destination.root);
    await expect(pair.destinationService.requestIntegration({
      teamId: pair.teamId, sharedProjectId: pair.sharedProjectId, incomingRequestId: incoming.id,
      action: 'merge', expectedHead: before.head, expectedFingerprint: before.fingerprint,
    })).rejects.toThrow(/clean owner project/i);
    expect(readFileSync(path.join(destination.root, 'owner-edit.txt'), 'utf8')).toBe('uncommitted owner work\n');
    expect((await pair.destinationService.snapshot(pair.teamId)).requests.filter((request) => request.kind === 'integration')).toHaveLength(0);
  });

  it('marks a tampered duplicate chunk failed and does not import it', async () => {
    const { source, destination } = makePair();
    writeFileSync(path.join(source.root, 'small-feature.bin'), randomBytes(500 * 1024));
    importRunGit(source.root, ['add', 'small-feature.bin']);
    importRunGit(source.root, ['commit', '-q', '-m', 'small feature']);
    const pair = await bindPair(source, destination);
    const offer = await pair.sourceService.request(transferInput(source, destination, pair.teamId, pair.sharedProjectId));
    const incoming = await receiveOffer(source, destination, pair);
    const chunks = await approveBoth(source, destination, pair, offer.id, incoming.id);
    const first = chunks[0]!;
    await deliverChunks(source, destination, pair, [first]);
    const payload = first.payload as { data: string };
    const bytes = Buffer.from(payload.data, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...first, payload: { ...payload, data: bytes.toString('base64') } };
    await expect(pair.destinationService.onEnvelope(envelope({
      teamId: pair.teamId, fromDeviceId: source.deviceFor(pair.teamId), toDeviceId: destination.deviceFor(pair.teamId),
      kind: tampered.kind, payload: tampered.payload,
    }))).rejects.toThrow(/duplicate bundle chunk changed its bytes/i);
    expect((await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.id === incoming.id)?.status).toBe('failed');
    expect((await runGit(destination.root, ['show-ref', '--verify', `refs/mingle/incoming/${incoming.id}`], { allowFailure: true })).code).not.toBe(0);
    expect((await pair.destinationService.snapshot(pair.teamId)).audit.some((entry) => entry.action === 'chunk-tamper')).toBe(true);
  });

  it('retains uncertain chunk delivery across restart and never republishes it automatically', async () => {
    const { source, destination } = makePair();
    writeFileSync(path.join(source.root, 'large-feature.bin'), randomBytes(550 * 1024));
    importRunGit(source.root, ['add', 'large-feature.bin']);
    importRunGit(source.root, ['commit', '-q', '-m', 'uncertain feature']);
    const pair = await bindPair(source, destination);
    const offer = await pair.sourceService.request(transferInput(source, destination, pair.teamId, pair.sharedProjectId));
    const incoming = await receiveOffer(source, destination, pair);
    const originalSend = source.options.transport.send;
    let acceptedChunks = 0;
    source.options.transport = {
      ...source.options.transport,
      async send(input) {
        if (input.kind === 'git.bundle.chunk') {
          source.messages.push(input);
          acceptedChunks++;
          if (acceptedChunks === 1) throw new Error('simulated accepted chunk with lost acknowledgement');
          return { accepted: true };
        }
        return originalSend(input);
      },
    };
    const sourceRequest = (await pair.sourceService.snapshot(pair.teamId)).requests.find((request) => request.id === offer.id)!;
    await pair.sourceService.decide({ requestId: offer.id, decision: 'approved', expectedDigest: sourceRequest.requestDigest });
    const pending = (await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.id === incoming.id)!;
    await pair.destinationService.decide({ requestId: incoming.id, decision: 'approved', expectedDigest: pending.requestDigest });
    const approval = destination.messages.find((message) => message.kind === 'git.import-approved')!;
    await expect(pair.sourceService.onEnvelope(envelope({
      teamId: pair.teamId, fromDeviceId: destination.deviceFor(pair.teamId), toDeviceId: source.deviceFor(pair.teamId),
      kind: approval.kind, payload: approval.payload,
    }))).rejects.toThrow(/simulated accepted chunk/i);
    expect((await pair.sourceService.snapshot(pair.teamId)).requests.find((request) => request.id === offer.id)?.status).toBe('unknown');
    expect(source.messages.filter((message) => message.kind === 'git.bundle.chunk')).toHaveLength(1);

    pair.sourceService = new GitSyncService(source.options);
    await pair.sourceService.onEnvelope(envelope({
      teamId: pair.teamId, fromDeviceId: destination.deviceFor(pair.teamId), toDeviceId: source.deviceFor(pair.teamId),
      kind: approval.kind, payload: approval.payload,
    }));
    await pair.sourceService.decide({ requestId: offer.id, decision: 'approved', expectedDigest: offer.requestDigest });
    expect((await pair.sourceService.snapshot(pair.teamId)).requests.find((request) => request.id === offer.id)?.status).toBe('unknown');
    expect(source.messages.filter((message) => message.kind === 'git.bundle.chunk')).toHaveLength(1);
  });

  it('pushes to a disposable bare repository only after exact local approval and blocks configured merge helpers', async () => {
    const { parent, source, destination } = makePair();
    writeFileSync(path.join(source.root, 'remote-feature.txt'), 'remote feature commit\n');
    importRunGit(source.root, ['add', 'remote-feature.txt']);
    importRunGit(source.root, ['commit', '-q', '-m', 'remote feature']);
    const barePath = path.join(parent, 'approved-push.git');
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', barePath]);
    const shimDir = path.join(parent, 'ssh shim');
    mkdirSync(shimDir);
    const sshShim = path.join(shimDir, 'ssh');
    writeFileSync(sshShim, '#!/bin/sh\nexec git-receive-pack "$MINGLE_ACCEPTANCE_BARE"\n');
    chmodSync(sshShim, 0o700);
    const marker = path.join(parent, 'merge-driver-was-run');
    importRunGit(destination.root, ['config', 'merge.untrusted.driver', `touch '${marker}' %O %A %B`]);
    const repository = {
      runGit(cwd: string, args: string[], options: Parameters<typeof runGit>[2] = {}) {
        const pathEnv = [shimDir, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
        return runGit(cwd, args, { ...options, env: { ...options.env, PATH: pathEnv, MINGLE_ACCEPTANCE_BARE: barePath } });
      },
    };
    importRunGit(destination.root, ['remote', 'add', 'approval-remote', 'builder@disposable.invalid:repo.git']);
    const destinationOptions = { ...destination.options, repository };
    const pair = await bindPair(source, { ...destination, options: destinationOptions });
    const offer = await pair.sourceService.request(transferInput(source, destination, pair.teamId, pair.sharedProjectId));
    const incoming = await receiveOffer(source, destination, pair);
    const chunks = await approveBoth(source, destination, pair, offer.id, incoming.id);
    await deliverChunks(source, destination, pair, chunks);
    expect((await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.id === incoming.id)?.status).toBe('imported');

    const refsBefore = execFileSync('git', ['--git-dir', barePath, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
    expect(refsBefore).toBe('');
    const state = await fingerprintRepository(destination.root, repository);
    const importedSnapshot = (await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.id === incoming.id)!;
    expect(importedSnapshot.expectedHead).toBe(state.head);
    expect(importedSnapshot.expectedFingerprint).toBe(state.fingerprint);
    const pushRequest = {
      teamId: pair.teamId, sharedProjectId: pair.sharedProjectId, incomingRequestId: incoming.id,
      action: 'push', expectedHead: state.head, expectedFingerprint: state.fingerprint, remoteName: 'approval-remote',
      idempotencyKey: 'disposable-bare-push',
    } as const;
    const push = await pair.destinationService.requestIntegration(pushRequest);
    expect((await pair.destinationService.requestIntegration(pushRequest)).id).toBe(push.id);
    await expect(pair.destinationService.requestIntegration({ ...pushRequest, action: 'merge', remoteName: undefined }))
      .rejects.toThrow(/idempotency key.*different/i);
    expect(push.status).toBe('awaiting-source-approval');
    expect(execFileSync('git', ['--git-dir', barePath, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' })).toBe('');
    await pair.destinationService.decide({ requestId: push.id, decision: 'approved', expectedDigest: push.requestDigest });
    const expectedHead = importRunGit(destination.root, ['rev-parse', 'HEAD']).trim();
    expect(execFileSync('git', ['--git-dir', barePath, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim()).toBe(expectedHead);
    await pair.destinationService.decide({ requestId: push.id, decision: 'approved', expectedDigest: push.requestDigest });
    expect(execFileSync('git', ['--git-dir', barePath, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim()).toBe(expectedHead);

    const helperState = await fingerprintRepository(destination.root, repository);
    const merge = await pair.destinationService.requestIntegration({
      teamId: pair.teamId, sharedProjectId: pair.sharedProjectId, incomingRequestId: incoming.id,
      action: 'merge', expectedHead: helperState.head, expectedFingerprint: helperState.fingerprint,
    });
    await expect(pair.destinationService.decide({ requestId: merge.id, decision: 'approved', expectedDigest: merge.requestDigest }))
      .rejects.toThrow(/external merge drivers/i);
    expect(() => readFileSync(marker)).toThrow();
    expect((await pair.destinationService.snapshot(pair.teamId)).requests.find((request) => request.id === merge.id)?.status).toBe('awaiting-source-approval');
  });

  it('serializes distributed external mutations under the existing local repository lease', async () => {
    const { parent, destination } = makePair();
    const runtime = { isActive: () => false };
    const workspace = new WorkspaceService(destination.store, parent, runtime as never);
    const repository = new RepositoryService({ store: destination.store, workspace, runtime, log: () => undefined });
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let mutations = 0;
    const first = repository.withExternalMutation(destination.projectId, async () => {
      enteredFirst();
      await firstGate;
      mutations++;
    });
    await firstEntered;
    expect(() => repository.assertProjectAvailable(destination.projectId)).toThrow(/repository operation/i);
    let secondEntered = false;
    const second = repository.withExternalMutation(destination.projectId, async () => {
      secondEntered = true;
      mutations++;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    expect(mutations).toBe(2);
    await repository.close();
  });

  it('serializes isolated-ref imports without stopping existing runs and blocks new runs during the ref mutation', async () => {
    const { parent, destination } = makePair();
    const runtime = { isActive: () => true };
    destination.store.insertSession({ projectId: destination.projectId, name: 'Active provider run', provider: 'codex', model: 'codex-test-model',
      effort: 'high', policy: 'supervised', isolated: false, worktreePath: destination.root, branch: 'main' });
    const workspace = new WorkspaceService(destination.store, parent, runtime as never);
    const repository = new RepositoryService({ store: destination.store, workspace, runtime, log: () => undefined });
    await expect(repository.withExternalMutation(destination.projectId, async () => undefined)).rejects.toThrow(/running/i);
    await repository.withExternalRefMutation(destination.projectId, async () => {
      const session = destination.store.listSessions(destination.projectId)[0]!;
      expect(() => repository.assertSessionAvailable(session)).toThrow(/repository change/i);
    });
    await repository.close();
  });

  it('executes only typed read-only Git in a hostile-but-valid directory and rejects argv, Windows paths, symlinks, and revoked peers', async () => {
    const hostileDirectory = '--help;touch remote-command-pwned\n\t';
    const { source, destination } = makePair({
      source: 'source with spaces',
      destination: `destination with spaces\n${hostileDirectory}`,
    });
    mkdirSync(path.join(destination.root, hostileDirectory));
    writeFileSync(path.join(destination.root, hostileDirectory, 'visible.txt'), 'actual file\n');
    const pair = await bindPair(source, destination, 'team-hostile-paths', 'shared-hostile-paths');
    const command = new RemoteCommandService(destination.options);
    const sourceService = new RemoteCommandService(source.options);
    const request = await sourceService.request({
      teamId: pair.teamId, sharedProjectId: pair.sharedProjectId, toDeviceId: destination.deviceFor(pair.teamId),
      operation: { kind: 'git.status' }, cwd: hostileDirectory,
    });
    expect(request.status).toBe('dispatched');
    const idempotentRequest = {
      teamId: pair.teamId, sharedProjectId: pair.sharedProjectId, toDeviceId: destination.deviceFor(pair.teamId),
      operation: { kind: 'git.status' } as const, cwd: '.', idempotencyKey: 'fixed-command-request',
    };
    const firstIdempotent = await sourceService.request(idempotentRequest);
    expect((await sourceService.request(idempotentRequest)).id).toBe(firstIdempotent.id);
    await expect(sourceService.request({ ...idempotentRequest, cwd: hostileDirectory }))
      .rejects.toThrow(/idempotency key.*different/i);
    await expect(sourceService.request({ ...idempotentRequest, operation: { kind: 'git.head' } }))
      .rejects.toThrow(/idempotency key.*different/i);
    const wire = source.messages.find((message) => message.kind === 'command.request')!;
    await command.onEnvelope(envelope({
      teamId: pair.teamId, fromDeviceId: source.deviceFor(pair.teamId), toDeviceId: destination.deviceFor(pair.teamId),
      kind: wire.kind, payload: wire.payload,
    }));
    const incoming = (await command.snapshot(pair.teamId)).requests[0]!;
    expect(incoming.status).toBe('awaiting-approval');
    const result = await command.decide({ requestId: incoming.id, decision: 'approved', expectedDigest: incoming.requestDigest });
    expect(result.status).toBe('completed');
    expect(result.output).toContain('visible.txt');
    expect(() => readFileSync(path.join(destination.root, 'remote-command-pwned'))).toThrow();

    const requestCount = (await command.snapshot(pair.teamId)).requests.length;
    const malicious = (requestId: string, payload: Record<string, unknown>) => command.onEnvelope(envelope({
      teamId: pair.teamId, fromDeviceId: source.deviceFor(pair.teamId), toDeviceId: destination.deviceFor(pair.teamId),
      kind: 'command.request', payload: { requestId, sharedProjectId: pair.sharedProjectId, operation: { kind: 'git.status' }, cwd: '.', ...payload },
    }));
    await expect(malicious('invalid-raw-argv', { operation: { kind: 'git.status', args: [';touch remote-command-pwned'] } })).rejects.toThrow(/Malformed typed command request/);
    await expect(sourceService.request({
      teamId: pair.teamId, sharedProjectId: pair.sharedProjectId, toDeviceId: destination.deviceFor(pair.teamId),
      operation: { kind: 'git.status' }, cwd: 'C:/Windows',
    })).rejects.toThrow(/project-relative/i);
    await expect(malicious('invalid-drive-absolute', { cwd: 'C:/Windows' })).rejects.toThrow(/project-relative/i);
    await expect(malicious('invalid-parent', { cwd: '../outside' })).rejects.toThrow(/traversal/i);
    await expect(malicious('invalid-control', { cwd: `safe\0path` })).rejects.toThrow(/project-relative|NUL|Malformed/i);
    const outside = mkdtempSync(path.join(os.tmpdir(), 'mingle-hostile-outside-'));
    symlinkSync(outside, path.join(destination.root, 'escape-link'), 'dir');
    await expect(malicious('invalid-symlink', { cwd: 'escape-link' })).rejects.toThrow(/symlink/i);
    expect((await command.snapshot(pair.teamId)).requests).toHaveLength(requestCount);
    destination.revokedPeers.add(`${pair.teamId}:${source.deviceFor(pair.teamId)}`);
    await expect(command.decide({ requestId: incoming.id, decision: 'approved', expectedDigest: incoming.requestDigest })).rejects.toThrow(/revoked/i);
    expect((await command.snapshot(pair.teamId)).requests).toHaveLength(0);
    rmSync(outside, { recursive: true, force: true });
  });
});
