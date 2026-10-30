import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  BrowserActionSchema, BrowserConnectSchema, type AppSettings, type BrowserAction, type BrowserConnect, type BrowserDiscovery, type BrowserSessionState,
  type BrowserSnapshot, type BrowserTab,
} from '@mingle/contracts';
import type { Security } from '../security.ts';
import type { Logger } from '../types.ts';
import type { Actor } from './control.ts';
import { resolveCdpEndpoint } from './endpoint.ts';
import { BrowserError, toBrowserError } from './errors.ts';
import { ChromiumInstaller } from './install.ts';
import { ID_PATTERN } from './limits.ts';
import { resolveManagedExecutable } from './playwright.ts';
import { BrowserSessionRuntime, type ExistingTarget } from './session.ts';
import { captureSnapshot } from './snapshot.ts';
import { discoverSources, readActivePortEndpoint } from './sources.ts';
import { BrowserStreamServer } from './stream-server.ts';
import type { TabEntry } from './tab.ts';
import { TargetRegistry } from './targets.ts';

export interface BrowserServiceOptions {
  dataDir: string;
  getSettings: () => AppSettings;
  /** Called (coalesced) whenever browser state changed; wire it to state.changed. */
  onChange: () => void;
  /** Lets the stream endpoint reject unknown or archived sessions. */
  sessionExists?: (sessionId: string) => boolean;
  log?: Logger;
}

const NOTIFY_DELAY_MS = 50;

function assertSessionId(sessionId: string): void {
  if (!ID_PATTERN.test(sessionId)) throw new BrowserError(400, 'That session id is not valid.');
}

function assertTabId(tabId: string): void {
  if (!ID_PATTERN.test(tabId)) throw new BrowserError(400, 'That tab id is not valid.');
}

/** Shared browser backend: per-session Chromium (managed) or a user-approved attachment to an existing browser. */
export class BrowserService {
  private readonly runtimes = new Map<string, BrowserSessionRuntime>();
  private readonly targets = new TargetRegistry();
  private readonly leaving = new Map<string, Promise<void>>();
  private readonly installer: ChromiumInstaller;
  private readonly stream: BrowserStreamServer;
  private readonly log: Logger;
  private notifyTimer: NodeJS.Timeout | null = null;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: BrowserServiceOptions) {
    this.log = options.log ?? (() => undefined);
    this.installer = new ChromiumInstaller(() => this.notify());
    this.stream = new BrowserStreamServer({
      sessionExists: (sessionId) => (options.sessionExists ? options.sessionExists(sessionId) : true),
      tab: (sessionId, tabId) => this.runtimes.get(sessionId)?.tab(tabId) ?? null,
      act: (sessionId, tabId, action, actor) => this.act(sessionId, tabId, action, actor),
      control: (sessionId, tabId, owner, clientId) => this.control(sessionId, tabId, owner, clientId),
      dropClient: async (sessionId, tabId, clientId) => { await this.runtimes.get(sessionId)?.dropClient(tabId, clientId); },
    }, this.log);
  }

  /** What can be used right now. Never downloads or launches anything and never opens profile data. */
  async discovery(): Promise<BrowserDiscovery> {
    const [sources, executable] = await Promise.all([discoverSources(), resolveManagedExecutable(this.options.getSettings().browserExecutable)]);
    const notices: string[] = [];
    if (executable.problem) notices.push(executable.problem);
    else if (!executable.path) notices.push('No Chromium is installed for Mingle yet. Install it to get a private, sandboxed browser, or set a browser executable in settings.');
    if (this.installer.lastError) notices.push(this.installer.lastError);
    if (sources.length > 0 && !sources.some((source) => source.debuggingAvailable)) {
      notices.push('To share an existing browser, open chrome://inspect/#remote-debugging in it and turn remote debugging on. Mingle only attaches after you approve.');
    }
    return { sources, managedAvailable: executable.path !== null, managedExecutable: executable.path, installing: this.installer.installing, notices, sandbox: null, systemBrowsers: [] };
  }

  /** Downloads Playwright's pinned Chromium. Only runs on explicit request; concurrent calls share one download. */
  async install(): Promise<BrowserDiscovery> {
    this.assertOpen();
    await this.installer.start().catch(() => undefined);
    return this.discovery();
  }

  status(sessionId: string): BrowserSessionState {
    assertSessionId(sessionId);
    return this.runtimes.get(sessionId)?.state() ?? { sessionId, status: 'disconnected', mode: null, tabs: [], activeTabId: null, error: null, notices: [] };
  }

  async connect(sessionId: string, input: BrowserConnect): Promise<BrowserSessionState> {
    this.assertOpen();
    assertSessionId(sessionId);
    await this.leaving.get(sessionId);
    const parsed = BrowserConnectSchema.safeParse(input);
    if (!parsed.success) throw new BrowserError(400, parsed.error.issues[0]?.message ?? 'Invalid browser connection request.');
    const request = parsed.data;
    const runtime = this.runtime(sessionId);
    try {
      await runtime.connect(request.mode, () => (request.mode === 'managed' ? Promise.resolve(null) : this.resolveExisting(request)));
    } catch (error) {
      // The failure stays visible in status(); the caller also gets the real status and a public message.
      throw toBrowserError(error);
    }
    return runtime.state();
  }

  async disconnect(sessionId: string): Promise<BrowserSessionState> {
    assertSessionId(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      const leaving = this.leaving.get(sessionId) ?? runtime.disconnect().finally(() => {
        this.runtimes.delete(sessionId);
        this.leaving.delete(sessionId);
      });
      this.leaving.set(sessionId, leaving);
      await leaving;
    }
    return this.status(sessionId);
  }

  async open(sessionId: string, url?: string): Promise<BrowserTab> {
    this.assertOpen();
    assertSessionId(sessionId);
    await this.leaving.get(sessionId);
    const runtime = this.runtime(sessionId);
    if (!runtime.isConnected) {
      if (this.options.getSettings().browserDefaultMode === 'existing') {
        throw new BrowserError(409, 'Connect to your existing browser first. Choose it in the Browser panel and approve the connection.');
      }
      try {
        await runtime.connect('managed', () => Promise.resolve(null));
      } catch (error) {
        throw toBrowserError(error);
      }
    }
    return runtime.open(url);
  }

  async snapshot(sessionId: string, tabId: string, includeImage = false): Promise<BrowserSnapshot> {
    const { runtime, entry } = this.locate(sessionId, tabId);
    runtime.requireConnected();
    runtime.assertShareable(entry);
    try {
      const body = await captureSnapshot(entry, includeImage);
      runtime.markActive(entry);
      return { tab: entry.describe(), ...body };
    } catch (error) {
      throw toBrowserError(error);
    }
  }

  act(sessionId: string, tabId: string, action: BrowserAction, actor: Actor): Promise<unknown> {
    try {
      const { runtime, entry } = this.locate(sessionId, tabId);
      const parsed = BrowserActionSchema.safeParse(action);
      if (!parsed.success) throw new BrowserError(400, parsed.error.issues[0]?.message ?? 'Invalid browser action.');
      if ((actor.kind !== 'agent' && actor.kind !== 'human') || !actor.id || actor.id.length > 200) throw new BrowserError(400, 'Invalid actor.');
      if (actor.kind === 'human' && !this.stream.hasViewer(sessionId, tabId, actor.id)) {
        throw new BrowserError(403, 'Open the live view of this tab first; only a connected viewer can send input.');
      }
      return runtime.act(entry, parsed.data, { kind: actor.kind, id: actor.id });
    } catch (error) {
      return Promise.reject(toBrowserError(error));
    }
  }

  async control(sessionId: string, tabId: string, owner: 'agent' | 'human', clientId: string): Promise<BrowserTab> {
    const { runtime, entry } = this.locate(sessionId, tabId);
    if (!clientId || clientId.length > 200) throw new BrowserError(400, 'Invalid client id.');
    // Only a connected viewer of this very tab may take control. Releasing stays possible for the holder so a stale lock can always be cleared.
    if (owner === 'human' && !this.stream.hasViewer(sessionId, tabId, clientId)) {
      throw new BrowserError(403, 'Open the live view of this tab first; only a connected viewer can take control.');
    }
    try {
      if (owner === 'human') await runtime.takeControl(entry, clientId);
      else await runtime.releaseControl(entry, clientId);
    } catch (error) {
      throw toBrowserError(error);
    }
    return entry.describe();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, security: Security): void {
    if (this.closing) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.stream.handleUpgrade(req, socket, head, security);
  }

  /** Idempotent shutdown: stops streams, closes Mingle-launched browsers and detaches from user browsers without closing them. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.installer.abort();
      await this.stream.close();
      await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.disconnect()));
      this.runtimes.clear();
    })();
    return this.closing;
  }

  // --- internals -----------------------------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closing) throw new BrowserError(503, 'The browser service is shutting down.');
  }

  private runtime(sessionId: string): BrowserSessionRuntime {
    let runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      runtime = new BrowserSessionRuntime({
        sessionId,
        dataDir: this.options.dataDir,
        getSettings: this.options.getSettings,
        notify: () => this.notify(),
        targets: this.targets,
        totalTabs: () => [...this.runtimes.values()].reduce((sum, item) => sum + item.tabCount, 0),
        log: this.log,
      });
      this.runtimes.set(sessionId, runtime);
    }
    return runtime;
  }

  private locate(sessionId: string, tabId: string): { runtime: BrowserSessionRuntime; entry: TabEntry } {
    assertSessionId(sessionId);
    assertTabId(tabId);
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw new BrowserError(409, 'No browser is connected for this session.');
    return { runtime, entry: runtime.requireTab(tabId) };
  }

  /** Turns a source id or loopback endpoint (or the saved settings) into a validated ws:// endpoint. Human-approved connects only. */
  private async resolveExisting(request: Extract<BrowserConnect, { mode: 'existing' }>): Promise<ExistingTarget> {
    const settings = this.options.getSettings();
    if (request.sourceId && request.endpoint) throw new BrowserError(400, 'Choose either a detected browser or a debugging endpoint, not both.');
    const endpoint = request.endpoint ?? (request.sourceId ? undefined : settings.browserCdpEndpoint?.trim() || undefined);
    if (endpoint) {
      const resolved = await resolveCdpEndpoint(endpoint);
      return { wsUrl: resolved.wsUrl, kind: 'endpoint', label: 'your browser' };
    }
    const sourceId = request.sourceId ?? settings.browserExistingSourceId?.trim();
    if (!sourceId) throw new BrowserError(400, 'Choose a detected browser or enter a loopback debugging endpoint.');
    const source = (await discoverSources()).find((candidate) => candidate.id === sourceId);
    if (!source) throw new BrowserError(404, 'That browser was not found on this computer.');
    const resolved = await readActivePortEndpoint(source);
    return { wsUrl: resolved.wsUrl, kind: 'source', label: source.name };
  }

  private notify(): void {
    if (this.notifyTimer || this.closing) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      try { this.options.onChange(); } catch (error) { this.log('warn', 'Browser change listener failed', error); }
    }, NOTIFY_DELAY_MS);
    this.notifyTimer.unref();
  }
}
