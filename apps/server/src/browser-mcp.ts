import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { BrowserActionSchema } from '@mingle/contracts';
import type { BrowserAction, BrowserMcpConnection, BrowserSessionState, BrowserSnapshot, BrowserTab, Session } from '@mingle/contracts';
import type { Store } from './store.ts';
import { errorMessage, truncate } from './util.ts';
import { redactSecrets } from './providers/common.ts';

interface BrowserAutomation {
  status(sessionId: string): BrowserSessionState;
  open(sessionId: string, url?: string): Promise<BrowserTab>;
  snapshot(sessionId: string, tabId: string, image?: boolean): Promise<BrowserSnapshot>;
  act(sessionId: string, tabId: string, action: BrowserAction, actor: { kind: 'agent' | 'human'; id: string }): Promise<unknown>;
}
type ApprovalRequest = { tool: string; description: string; input: Record<string, unknown> };
interface Binding {
  runId: string; session: Session; signal: AbortSignal;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  approval?: Promise<boolean>; shown: boolean; revoked: boolean;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tabId = z.string().min(1).max(100).optional();
const target = { selector: z.string().min(1).max(2000).optional(), ref: z.string().min(1).max(100).optional(), role: z.string().min(1).max(80).optional(), name: z.string().max(500).optional() };

/** Authenticated, run-scoped MCP access to the same browser tabs the user sees. */
export class BrowserMcpBridge {
  private bindings = new Map<string, Binding>();
  constructor(private browser: BrowserAutomation, private store: Store, private getPort: () => number,
    private onOpen: (sessionId: string, tabId: string) => void, private getHost: () => string = () => '127.0.0.1') {}

  create(runId: string, session: Session, signal: AbortSignal, requestApproval: Binding['requestApproval']): BrowserMcpConnection {
    if (this.bindings.size >= 64) throw new Error('Too many active browser tool connections');
    const token = randomBytes(32).toString('base64url');
    this.bindings.set(hash(token), { runId, session, signal, requestApproval, shown: false, revoked: false });
    const host = this.getHost();
    return { url: `http://${host.includes(':') ? `[${host}]` : host}:${this.getPort()}/api/browser/mcp`, token };
  }

  revoke(runId: string): void {
    for (const [key, binding] of this.bindings) if (binding.runId === runId) { binding.revoked = true; this.bindings.delete(key); }
  }
  close(): void { for (const binding of this.bindings.values()) binding.revoked = true; this.bindings.clear(); }

  private ensure(binding: Binding): void {
    if (binding.revoked || binding.signal.aborted || !this.store.getSession(binding.session.id)) throw new Error('This browser tool connection has expired');
    if (this.store.getSettings().browserAgentEnabled === false) throw new Error('Agent browser access is disabled in Settings → Browser');
  }

  private async permit(binding: Binding, requestSignal: AbortSignal): Promise<void> {
    if (requestSignal.aborted) throw new Error('This browser request was cancelled');
    this.ensure(binding);
    if (binding.session.policy === 'supervised' || binding.session.policy === 'balanced') {
      binding.approval ??= binding.requestApproval({
        tool: 'Browser control', description: 'Allow this run to control the shared browser, including any logged-in tabs you connected?',
        input: { sessionId: binding.session.id, mode: this.browser.status(binding.session.id).mode },
      });
      if (!await binding.approval) throw new Error('Browser control was not approved for this run');
    }
    this.ensure(binding);
    if (requestSignal.aborted) throw new Error('This browser request was cancelled');
  }

  private show(binding: Binding, id: string): void {
    if (!binding.shown) { binding.shown = true; this.onOpen(binding.session.id, id); }
  }

  private current(binding: Binding, requested?: string): string {
    const state = this.browser.status(binding.session.id);
    const id = requested ?? state.activeTabId;
    if (!id || !state.tabs.some((row) => row.id === id)) throw new Error('No shared tab is selected. Call browser_status, then browser_open or choose an available tab.');
    return id;
  }

  private tools(binding: Binding, requestSignal: AbortSignal): McpServer {
    const ensureRequest = () => { this.ensure(binding); if (requestSignal.aborted) throw new Error('This browser request was cancelled'); };
    const server = new McpServer({ name: 'mingle-browser', version: '0.0.1' }, {
      instructions: 'These tools operate Mingle’s collaborative browser. The user sees the same tabs and may step in at any time by clicking or typing. Start with browser_status, then browser_open or browser_snapshot. Use snapshot refs or role/name targets; ambiguous targets fail. If a person steps in, wait for touch control to return, then take a fresh snapshot before retrying; a held lease requires them to hand control back. Existing-browser connections are made by the user in Mingle. Never extract cookies or credentials. Use browser_evaluate only for page JavaScript. Browser actions must follow the user’s task and authorization.',
    });
    const output = (value: unknown) => ({ content: [{ type: 'text' as const, text: truncate(redactSecrets(JSON.stringify(value) ?? 'null'), 64_000) }] });
    const register = (name: string, description: string, shape: z.ZodRawShape, readOnly: boolean, operation: (args: Record<string, unknown>) => Promise<unknown> | unknown) => {
      server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true } }, async (args) => {
        try { ensureRequest(); const result = await operation(args); ensureRequest(); return output(result); }
        catch (error) { return { content: [{ type: 'text' as const, text: truncate(redactSecrets(errorMessage(error)), 1000) }], isError: true }; }
      });
    };
    const act = async (args: Record<string, unknown>, type: BrowserAction['type']) => {
      await this.permit(binding, requestSignal);
      const { tabId: requested, ...input } = args;
      const id = this.current(binding, requested as string | undefined);
      const action = BrowserActionSchema.parse({ ...input, type });
      let result: unknown;
      try { result = await this.browser.act(binding.session.id, id, action, { kind: 'agent', id: binding.runId }); }
      catch (error) {
        if (!errorMessage(error).startsWith('A person is using this tab right now.')) throw error;
        const until = Date.now() + 20_000;
        while (Date.now() < until) {
          ensureRequest();
          const currentTab = this.browser.status(binding.session.id).tabs.find((row) => row.id === id);
          if (!currentTab?.control.holderId) throw new Error('A person just used the page. Take a fresh snapshot before retrying the action.');
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw error;
      }
      this.show(binding, id);
      return result ?? { ok: true, tabId: id };
    };
    register('browser_status', 'Report browser connection, shared tabs and human control. No browser is launched.', {}, true, () => this.browser.status(binding.session.id));
    register('browser_tabs', 'List tabs shared with this session; other sessions’ tabs are excluded.', {}, true, () => this.browser.status(binding.session.id).tabs);
    register('browser_open', 'Open a new shared tab. A managed browser can start on demand; an existing personal browser must first be connected by the user in Mingle.', { url: z.string().max(4096).optional() }, false, async (args) => {
      await this.permit(binding, requestSignal);
      const tab = await this.browser.open(binding.session.id, args.url as string | undefined);
      this.show(binding, tab.id);
      return tab;
    });
    server.registerTool('browser_snapshot', {
      description: 'Inspect the shared tab’s accessibility tree, public page text and optional screenshot. Refresh the snapshot after navigation or stale-ref errors. Form password values are excluded.',
      inputSchema: { tabId, includeImage: z.boolean().optional() }, annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ tabId: requested, includeImage }) => {
      try {
        ensureRequest();
        const id = this.current(binding, requested);
        const snapshot = await this.browser.snapshot(binding.session.id, id, includeImage !== false);
        ensureRequest();
        const { screenshot, ...text } = snapshot;
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: truncate(redactSecrets(JSON.stringify(text)), 64_000) }];
        if (screenshot) content.push({ type: 'image', data: screenshot.data, mimeType: screenshot.mimeType });
        this.show(binding, id);
        return { content };
      } catch (error) { return { content: [{ type: 'text', text: truncate(redactSecrets(errorMessage(error)), 1000) }], isError: true }; }
    });
    register('browser_navigate', 'Navigate a shared tab to an HTTP(S) URL; internal browser and file URLs are refused.', { tabId, url: z.string().min(1).max(4096) }, false, (args) => act(args, 'navigate'));
    register('browser_click', 'Click one target using a snapshot ref, role/name, strict Playwright selector, or viewport x/y coordinates. Prefer semantic targets. A person may step in at any time.', { tabId, ...target, x: z.number().optional(), y: z.number().optional(), button: z.enum(['left', 'middle', 'right']).optional() }, false, (args) => act(args, 'click'));
    register('browser_type', 'Enter text in one form target. A person may step in at any time. clear=true replaces its contents; do not include credentials unless the user explicitly requested it.', { tabId, ...target, text: z.string().max(10000), clear: z.boolean().optional() }, false, (args) => act(args, 'type'));
    register('browser_hover', 'Hover over one semantic target or strict selector.', { tabId, ...target }, false, (args) => act(args, 'hover'));
    register('browser_select', 'Select option values in one native select element.', { tabId, ...target, values: z.array(z.string().max(500)).min(1).max(30) }, false, (args) => act(args, 'select'));
    register('browser_press', 'Press a browser key, e.g. Enter, ArrowDown, Control+A, Meta+A or Escape.', { tabId, key: z.string().min(1).max(100) }, false, (args) => act(args, 'press'));
    register('browser_scroll', 'Scroll the tab by viewport CSS-pixel deltas, optionally at x/y.', { tabId, deltaY: z.number(), deltaX: z.number().optional(), x: z.number().optional(), y: z.number().optional() }, false, (args) => act(args, 'scroll'));
    register('browser_resize', 'Explicitly resize the tab viewport; this also affects an attached browser tab.', { tabId, width: z.number().int(), height: z.number().int() }, false, (args) => act(args, 'resize'));
    register('browser_evaluate', 'Evaluate a JavaScript expression or () => { ... } function in the page, never Node. Results are bounded. This can change the page and follows the same control permissions as clicks.', { tabId, expression: z.string().min(1).max(20000) }, false, (args) => act(args, 'evaluate'));
    register('browser_wait_for', 'Wait up to 10 seconds for a selector, semantic target or public text. Supply a condition.', { tabId, ...target, text: z.string().max(500).optional(), timeoutMs: z.number().int().min(1).max(10000).optional() }, true, async (args) => {
      const { tabId: requested, ...input } = args;
      return this.browser.act(binding.session.id, this.current(binding, requested as string | undefined), BrowserActionSchema.parse({ ...input, type: 'wait' }), { kind: 'agent', id: binding.runId });
    });
    register('browser_dialog', 'Accept or dismiss a JavaScript dialog only when authorized by the user’s task.', { tabId, accept: z.boolean(), promptText: z.string().max(10000).optional() }, false, (args) => act(args, 'dialog'));
    for (const type of ['back', 'forward', 'reload', 'close'] as const) register(`browser_${type}`, type === 'close' ? 'Close this shared tab. For an existing browser this closes the actual user tab; do so only when requested.' : `${type} the shared tab.`, { tabId }, false, (args) => act(args, type));
    return server;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const binding = token ? this.bindings.get(hash(token)) : undefined;
    res.setHeader('Cache-Control', 'no-store');
    if (!binding || binding.signal.aborted || !this.store.getSession(binding.session.id) || this.store.getSettings().browserAgentEnabled === false) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Browser tool connection is unavailable or expired' })); return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    const requestController = new AbortController();
    const server = this.tools(binding, requestController.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { if (!res.writableFinished) requestController.abort(); void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Browser tool request failed' })); }
      else res.destroy();
      await transport.close(); await server.close();
    }
  }
}
