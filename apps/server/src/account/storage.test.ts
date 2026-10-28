import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountVault } from './vault.ts';
import { DesktopAccountStorage, type DesktopStorageChannel, type DesktopStorageResult } from './desktop-storage.ts';
import { AccountService } from './service.ts';
import { startTestApp } from '../test-utils.ts';

const directories: string[] = [];
const services: AccountService[] = [];
const cleanup: Array<() => Promise<void>> = [];
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'mingle-account-storage-')); directories.push(value); return value; };
const unavailable = (): DesktopStorageResult => ({ key: null, storage: { status: 'unavailable', backend: 'gnome_libsecret', reason: 'keyring-unavailable', retryable: true } });
const available = (key: Buffer): DesktopStorageResult => ({ key: Buffer.from(key), storage: { status: 'available', backend: 'gnome_libsecret', reason: null, retryable: false } });
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const close of cleanup.splice(0)) await close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('correlates private IPC replies across timeouts and retries and rejects plaintext backends', async () => {
  const events = new EventEmitter();
  const requests: Array<{ type: string; requestId: string }> = [];
  const channel: DesktopStorageChannel = {
    send(message) { requests.push(message); },
    onMessage(listener) { events.on('message', listener); return () => events.off('message', listener); },
    onDisconnect(listener) { events.on('disconnect', listener); return () => events.off('disconnect', listener); },
  };
  const client = new DesktopAccountStorage(channel, 20);
  const first = client.request();
  expect((await first).storage.reason).toBe('ipc-unavailable');
  const second = client.request();
  const reply = { type: 'mingle.account-key', key: randomBytes(32).toString('base64'), storage: available(randomBytes(32)).storage };
  events.emit('message', { ...reply, requestId: requests[0]!.requestId }); // Late prior request cannot unlock this one.
  events.emit('message', { ...reply, requestId: requests[1]!.requestId });
  expect((await second).key?.length).toBe(32);
  const third = client.request();
  events.emit('message', { ...reply, requestId: requests[2]!.requestId, storage: { ...reply.storage, backend: 'basic_text' } });
  expect((await third).key).toBeNull();
  const fourth = client.request();
  events.emit('disconnect');
  expect((await fourth).key).toBeNull();
  expect(events.listenerCount('message')).toBe(0);
  client.close();
});

it('retains a memory login and pending verifier when persistence recovers, then decrypts it on restart', () => {
  const dir = directory(), key = randomBytes(32);
  const vault = new AccountVault(dir, null);
  vault.setItem('mingle-account-session-code-verifier', 'example-pkce');
  vault.setItem('mingle-account-session', JSON.stringify({ access_token: 'example-access', refresh_token: 'example-refresh', provider_token: 'never-persist', provider_refresh_token: 'never-persist-either' }));
  expect(vault.enablePersistence(Buffer.from(key), false).restored).toBe(false);
  expect(vault.persistent).toBe(true);
  expect(statSync(vault.file).mode & 0o777).toBe(0o600);
  const ciphertext = readFileSync(vault.file, 'utf8');
  expect(ciphertext).not.toContain('example-access');
  vault.close();
  const next = new AccountVault(dir, key);
  expect(next.getItem('mingle-account-session-code-verifier')).toBeNull();
  expect(JSON.parse(next.getItem('mingle-account-session')!)).toEqual({ access_token: 'example-access', refresh_token: 'example-refresh' });
  next.clear(); next.close();
});

it('does not replace an unreadable saved session or lose the current memory account on retry', () => {
  const dir = directory(), vault = new AccountVault(dir, null);
  vault.setItem('mingle-account-session', JSON.stringify({ refresh_token: 'example-memory-account' }));
  writeFileSync(vault.file, 'damaged-ciphertext', { mode: 0o600 });
  expect(() => vault.enablePersistence(randomBytes(32), false)).toThrow('session-unreadable');
  expect(vault.persistent).toBe(false);
  expect(vault.getItem('mingle-account-session')).toContain('example-memory-account');
  expect(readFileSync(vault.file, 'utf8')).toBe('damaged-ciphertext');
  vault.close();
});

it('keeps an existing saved account through pending-sign-in retry and cancellation', () => {
  const dir = directory(), key = randomBytes(32);
  const prior = new AccountVault(dir, Buffer.from(key));
  prior.setItem('mingle-account-session', JSON.stringify({ refresh_token: 'example-prior-account' })); prior.close();
  const original = readFileSync(prior.file);
  const pending = new AccountVault(dir, null);
  pending.setItem('mingle-account-session-code-verifier', 'example-pending');
  expect(pending.enablePersistence(key, false).restored).toBe(false);
  pending.removeItem('mingle-account-session-code-verifier');
  expect(readFileSync(pending.file)).toEqual(original);
  pending.close();
});

it('reports a disk write failure and keeps the login usable in memory', () => {
  const dir = directory(), failed = vi.fn(), vault = new AccountVault(dir, randomBytes(32), failed);
  mkdirSync(vault.file); // Reproducible failed atomic rename without relying on uid/permission differences.
  vault.setItem('mingle-account-session', JSON.stringify({ refresh_token: 'example-new-login' }));
  expect(vault.persistent).toBe(false);
  expect(failed).toHaveBeenCalledWith('storage-write-failed');
  expect(vault.getItem('mingle-account-session')).toContain('example-new-login');
  vault.close();
});

async function identityFixture() {
  let rejectNextUser = false;
  let userRequests = 0;
  let userDelayMs = 0;
  const user = { id: '72000000-0000-4000-8000-000000000001', email: 'example-storage@example.test', email_confirmed_at: '2026-01-01T00:00:00Z', aud: 'authenticated', created_at: '2026-01-01T00:00:00Z', identities: [{ provider: 'google', id: 'example-google' }], app_metadata: { provider: 'google' }, user_metadata: { full_name: 'Example storage test' } };
  let currentUser = user;
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const tokenFor = (userId: string) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600, aud: 'authenticated' })}.${Buffer.alloc(32).toString('base64url')}`;
  let token = tokenFor(user.id);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (url.pathname === '/auth/v1/settings') res.end(JSON.stringify({ external: { google: true } }));
    else if (url.pathname === '/auth/v1/user') {
      userRequests++;
      const respond = () => {
        if (rejectNextUser) { rejectNextUser = false; res.statusCode = 401; res.end(JSON.stringify({ message: 'Example rejected account', code: 'bad_jwt' })); }
        else res.end(JSON.stringify(currentUser));
      };
      if (userDelayMs) setTimeout(respond, userDelayMs);
      else respond();
    }
    else if (url.pathname === '/auth/v1/token') res.end(JSON.stringify({ access_token: token, refresh_token: 'example-refresh-token', token_type: 'bearer', expires_in: 3600, user: currentUser }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address() as { port: number };
  return {
    env: { MINGLE_SUPABASE_URL: `http://127.0.0.1:${address.port}`, MINGLE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_storage_only' },
    user, rejectNextUser: () => { rejectNextUser = true; }, setUserDelay: (value: number) => { userDelayMs = value; }, userRequests: () => userRequests,
    changeAccount: (id: string) => {
      currentUser = { ...user, id, email: 'changed-account@example.test' };
      token = tokenFor(id);
      return token;
    },
  };
}

async function makeService(dir: string, env: NodeJS.ProcessEnv) {
  const service = new AccountService(dir, env, () => {}); services.push(service); await service.ready;
  vi.spyOn(service as unknown as { openBrowser(url: string): Promise<void> }, 'openBrowser').mockResolvedValue(undefined);
  return service;
}
async function finishSignIn(service: AccountService) {
  const oauth = new URL(service.snapshot().authorizationUrl!);
  const callback = oauth.searchParams.get('redirect_to')!;
  expect((await fetch(callback + '?code=example-pkce-code')).status).toBe(200);
  expect(service.snapshot().status).toBe('signed-in');
}

it('upgrades a real SDK sign-in during PKCE, persists it, restores it and removes it on sign-out', async () => {
  const fixture = await identityFixture(), dir = directory(), key = randomBytes(32);
  vi.spyOn(DesktopAccountStorage.prototype, 'request').mockResolvedValueOnce(unavailable()).mockImplementation(async () => available(key));
  const service = await makeService(dir, fixture.env);
  await service.startSignIn();
  const authorizationUrl = service.snapshot().authorizationUrl;
  expect((await service.retryStorage()).sessionStorage).toBe('os-encrypted');
  expect(service.snapshot().authorizationUrl).toBe(authorizationUrl);
  await finishSignIn(service);
  expect(service.snapshot().user?.id).toBe(fixture.user.id);
  await service.close();
  const restarted = await makeService(dir, fixture.env);
  expect(restarted.snapshot()).toMatchObject({ status: 'signed-in', sessionStorage: 'os-encrypted', user: { id: fixture.user.id } });
  await restarted.signOut();
  const afterSignOut = await makeService(dir, fixture.env);
  expect(afterSignOut.snapshot().status).toBe('signed-out');
});

it('restores an existing saved login after an initially locked keyring recovers', async () => {
  const fixture = await identityFixture(), dir = directory(), key = randomBytes(32);
  const request = vi.spyOn(DesktopAccountStorage.prototype, 'request').mockImplementation(async () => available(key));
  const first = await makeService(dir, fixture.env);
  await first.startSignIn(); await finishSignIn(first); await first.close();
  request.mockResolvedValueOnce(unavailable());
  const locked = await makeService(dir, fixture.env);
  expect(locked.snapshot().status).toBe('signed-out');
  expect((await locked.retryStorage()).status).toBe('signed-in');
  expect(locked.snapshot().user?.id).toBe(fixture.user.id);
});

it('keeps a signed-in memory session usable when retry still cannot unlock secure storage', async () => {
  const fixture = await identityFixture(), dir = directory();
  vi.spyOn(DesktopAccountStorage.prototype, 'request').mockImplementation(async () => unavailable());
  const service = await makeService(dir, fixture.env);
  await service.startSignIn(); await finishSignIn(service);
  const before = service.snapshot();
  expect((await service.retryStorage()).sessionStorage).toBe('memory');
  expect(service.snapshot().user).toEqual(before.user);
  expect(await service.withAuthenticatedClient(async (_client, user) => user.id)).toBe(fixture.user.id);
});

it('caches verified users for 60 seconds but leaves sign-in completion freshly verified', async () => {
  const fixture = await identityFixture(), service = await makeService(directory(), fixture.env);
  await service.startSignIn();
  await finishSignIn(service);
  expect(fixture.userRequests()).toBe(1);

  expect(await service.withAuthenticatedClient(async (_client, user) => user.id)).toBe(fixture.user.id);
  expect(fixture.userRequests()).toBe(2);
  await service.withAuthenticatedClient(async (_client, user) => user.id);
  expect(fixture.userRequests()).toBe(2);
});

it('shares a single in-flight user verification between concurrent operations', async () => {
  const fixture = await identityFixture(), service = await makeService(directory(), fixture.env);
  await service.startSignIn();
  await finishSignIn(service);
  await service.cancelSignIn(); // Advances the account generation and clears the just-verified sign-in identity.
  fixture.setUserDelay(25);

  const results = await Promise.all(Array.from({ length: 6 }, () =>
    service.withAuthenticatedClient(async (_client, user) => user.id)));
  expect(results).toEqual(Array(6).fill(fixture.user.id));
  expect(fixture.userRequests()).toBe(2);
});

it('invalidates cached verification after USER_UPDATED and a changed Supabase session identity', async () => {
  const fixture = await identityFixture(), service = await makeService(directory(), fixture.env);
  await service.startSignIn();
  await finishSignIn(service);
  await service.withAuthenticatedClient(async () => undefined);
  const client = (service as unknown as { client: import('@supabase/supabase-js').SupabaseClient }).client;

  await client.auth.updateUser({ data: { full_name: 'Updated storage test' } });
  const beforeUserUpdateVerification = fixture.userRequests();
  await service.withAuthenticatedClient(async () => undefined);
  expect(fixture.userRequests()).toBe(beforeUserUpdateVerification + 1);

  const nextAccountId = '72000000-0000-4000-8000-000000000002';
  const nextAccessToken = fixture.changeAccount(nextAccountId);
  await client.auth.setSession({ access_token: nextAccessToken, refresh_token: 'example-second-account-refresh' });
  const beforeNewAccountVerification = fixture.userRequests();
  await expect(service.withAuthenticatedClient(async (_client, user) => user.id)).resolves.toBe(nextAccountId);
  expect(fixture.userRequests()).toBe(beforeNewAccountVerification + 1);
});

it('invalidates the cached verification after a callback reports a JWT/401 error and after sign-out', async () => {
  const fixture = await identityFixture(), service = await makeService(directory(), fixture.env);
  await service.startSignIn();
  await finishSignIn(service);
  await service.withAuthenticatedClient(async () => undefined);
  const beforeUnauthorizedCallback = fixture.userRequests();

  await service.withAuthenticatedClient(async () => ({ error: { status: 401, message: 'JWT expired' } }));
  await service.withAuthenticatedClient(async () => undefined);
  expect(fixture.userRequests()).toBe(beforeUnauthorizedCallback + 1);

  await expect(service.withAuthenticatedClient(async () => { throw Object.assign(new Error('JWT expired'), { status: 401 }); }))
    .rejects.toMatchObject({ status: 401 });
  await service.withAuthenticatedClient(async () => undefined);
  expect(fixture.userRequests()).toBe(beforeUnauthorizedCallback + 2);

  await service.signOut();
  await service.startSignIn();
  await finishSignIn(service);
  const beforeFirstNewOperation = fixture.userRequests();
  await service.withAuthenticatedClient(async () => undefined);
  expect(fixture.userRequests()).toBe(beforeFirstNewOperation + 1);
});

it('preserves an opaque saved session after denied or unverified OAuth and restores it on recovery', async () => {
  const fixture = await identityFixture(), dir = directory(), key = randomBytes(32);
  const request = vi.spyOn(DesktopAccountStorage.prototype, 'request').mockImplementation(async () => available(key));
  const initial = await makeService(dir, fixture.env);
  await initial.startSignIn(); await finishSignIn(initial); await initial.close();
  const file = join(dir, 'account-session.enc'), original = readFileSync(file);
  request.mockResolvedValueOnce(unavailable());
  const locked = await makeService(dir, fixture.env);
  await locked.startSignIn();
  let oauth = new URL(locked.snapshot().authorizationUrl!);
  expect((await fetch(oauth.searchParams.get('redirect_to')! + '?error=access_denied')).status).toBe(400);
  expect(readFileSync(file)).toEqual(original);
  // A new token exchange may write the SDK storage before user verification fails.
  await locked.startSignIn();
  oauth = new URL(locked.snapshot().authorizationUrl!);
  fixture.rejectNextUser();
  expect((await fetch(oauth.searchParams.get('redirect_to')! + '?code=example-unverified')).status).toBe(400);
  expect(readFileSync(file)).toEqual(original);
  expect((await locked.retryStorage()).status).toBe('signed-in');
  await locked.signOut();
  expect(() => readFileSync(file)).toThrow();
});

it('exposes safe web-runtime status and validates retries at the real HTTP boundary', async () => {
  const t = await startTestApp({ exampleWorkspace: false, env: {} }); cleanup.push(() => t.cleanup());
  const response = await t.api('POST', '/api/account/storage/retry', {});
  expect(response.status).toBe(200);
  expect(response.json).toMatchObject({ sessionStorage: 'memory', storage: { reason: 'web-runtime', retryable: false } });
  expect(response.json).not.toHaveProperty('key');
  expect((await t.api('POST', '/api/account/storage/retry', { key: 'forged-key' })).status).toBe(400);
  expect((await t.api('POST', '/api/account/storage/retry', {}, { origin: 'https://example-attacker.test' })).status).toBe(403);
  expect(t.fake.runs).toHaveLength(0);
});
