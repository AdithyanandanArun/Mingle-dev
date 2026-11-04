import { tmpdir } from 'node:os';
import type { AccountUsageProvider, AgentAdapter, AppSettings, ConversationListOptions, ExternalConversationDetails, ExternalConversationList, Provider, ProviderAccountUsageSnapshot, ProviderCatalog, ProviderInfo, ProviderResetResult, ProviderUsage, RedeemProviderResetInput, Session } from '@mingle/contracts';
import { createClaudeAdapter } from './claude/adapter.js';
import { createCodexAdapter } from './codex/adapter.js';
import { detectProviders as detect } from './detect.js';
import { getCodexCatalog } from './codex/catalog.js';
import { getClaudeCatalog } from './claude/catalog.js';
import { getCodexUsage } from './codex/usage.js';
import { getClaudeUsage } from './claude/usage.js';
import { listCodexConversations, readCodexConversation } from './codex/history.js';
import { listClaudeConversations, readClaudeConversation } from './claude/history.js';
import { createAntigravityAdapter } from './antigravity/adapter.js';
import { getAntigravityCatalog } from './antigravity/catalog.js';
import { getAntigravityUsage } from './antigravity/usage.js';
import { authenticateAntigravity, probeAuthenticatedAntigravity } from './antigravity/auth.js';
import { createOpencodeAdapter } from './opencode/adapter.js';
import { getOpencodeCatalog } from './opencode/catalog.js';
import { getOpencodeUsage } from './opencode/usage.js';
import { CodexAccountUsage } from './codex/account-usage.js';
import { ProviderError } from './common.js';
import { HttpError } from '../util.ts';

export type { AdapterEvent, AgentAdapter, RunOptions } from '@mingle/contracts';
export { CLAUDE_DEFAULT_MODEL, CODEX_DEFAULT_MODEL } from './detect.js';
export { ProviderError, isAbortError } from './common.js';

const codexAccountUsage = new CodexAccountUsage();

/** Returns the adapter for a provider. Adapters hold no state between runs. */
export function createAdapter(provider: Provider): AgentAdapter {
  switch (provider) {
    case 'codex': return createCodexAdapter();
    case 'claude': return createClaudeAdapter();
    case 'antigravity': return createAntigravityAdapter();
    case 'opencode': return createOpencodeAdapter();
    default: throw new Error(`Unknown provider: ${String(provider)}`);
  }
}

/** Probes installed harnesses without running inference. See docs/provider-research.md for semantics. */
export function detectProviders(settings: AppSettings): Promise<ProviderInfo[]> {
  return detect(settings);
}
export { authenticateAntigravity, probeAuthenticatedAntigravity };
import { closeAllAntigravity } from './antigravity/runtime.js';
import { closeAllOpencode } from './opencode/runtime.js';
/** Runs after all session runs are stopped; ends leftover metadata probe children. */
export async function close(): Promise<void> { await Promise.all([closeAllAntigravity(), closeAllOpencode()]); }
const OPENCODE_IMPORT_NOTICE = 'OpenCode native conversation import is not supported by Mingle. ACP can list sessions, but Mingle has no verified bounded reader for their history; continue a Mingle OpenCode session to resume its native conversation.';

/** Native catalog metadata only: no prompt or model turn is submitted. */
export function getCatalog(session: Session, settings: AppSettings): Promise<ProviderCatalog> {
  switch (session.provider) {
    case 'codex': return getCodexCatalog(session, settings);
    case 'claude': return getClaudeCatalog(session, settings);
    case 'antigravity': return getAntigravityCatalog(session, settings);
    case 'opencode': return getOpencodeCatalog(session, settings);
  }
}

/** Read account quota metadata without inference, credential extraction, or spending reset credits. */
export function getUsage(session: Session, settings: AppSettings): Promise<ProviderUsage> {
  switch (session.provider) {
    case 'codex': return getCodexUsage(session, settings);
    case 'claude': return getClaudeUsage(session, settings);
    case 'antigravity': return getAntigravityUsage(session, settings);
    case 'opencode': return getOpencodeUsage(session, settings);
  }
}

/** Read account limits without a stored session, project cwd, prompt or reset mutation. */
export function getAccountUsage(provider: AccountUsageProvider, settings: AppSettings): Promise<ProviderAccountUsageSnapshot> {
  if (provider === 'codex') return codexAccountUsage.read(settings);
  const session = { id: 'account-usage', projectId: '', name: 'Account usage', provider: 'claude', model: settings.defaultClaudeModel,
    effort: settings.defaultEffort, status: 'idle', policy: settings.defaultPolicy, isolated: false, worktreePath: tmpdir(), branch: null,
    providerSessionId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null,
    inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false } satisfies Session;
  return getClaudeUsage(session, settings).then((usage) => ({ provider: 'claude', usage, reset: { mode: 'external', snapshotToken: null,
    externalUrl: 'https://claude.ai/settings/usage', reason: 'Claude exposes usage limits but does not provide a native reset redemption action in Claude Code.' } }));
}

export function redeemAccountUsageReset(provider: AccountUsageProvider, settings: AppSettings, snapshotToken: string, input: RedeemProviderResetInput): Promise<ProviderResetResult> {
  if (provider === 'codex') return codexAccountUsage.redeem(settings, snapshotToken, input);
  return Promise.reject(new HttpError(501, 'Claude reset actions are available only in Claude settings.'));
}

export function invalidateAccountUsage(): void { codexAccountUsage.invalidate(); }

export function listConversations(provider: Provider, settings: AppSettings, options: ConversationListOptions): Promise<ExternalConversationList> {
  switch (provider) {
    case 'codex': return listCodexConversations(settings, options);
    case 'claude': return listClaudeConversations(settings, options);
    case 'antigravity': return Promise.resolve({ conversations: [], nextCursor: null, notices: ['Antigravity native conversation import is not supported by Mingle.'] });
    case 'opencode': return Promise.resolve({ conversations: [], nextCursor: null, notices: [OPENCODE_IMPORT_NOTICE] });
  }
}

export function readConversation(provider: Provider, settings: AppSettings, id: string): Promise<ExternalConversationDetails> {
  switch (provider) {
    case 'codex': return readCodexConversation(settings, id);
    case 'claude': return readClaudeConversation(settings, id);
    case 'antigravity': return Promise.reject(new ProviderError('Antigravity native conversation import is not supported by Mingle.', { code: 'history_unsupported' }));
    case 'opencode': return Promise.reject(new ProviderError(OPENCODE_IMPORT_NOTICE, { code: 'history_unsupported' }));
  }
}
