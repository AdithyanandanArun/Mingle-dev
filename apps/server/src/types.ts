import type { AccountUsageProvider, AgentAdapter, AppSettings, ConversationListOptions, ExternalConversationDetails, ExternalConversationList, Provider, ProviderAccountUsageSnapshot, ProviderCatalog, ProviderFailure, ProviderInfo, ProviderResetResult, ProviderUsage, RecoveryCheckpoint, RedeemProviderResetInput, Session } from '@mingle/contracts';

/** Runtime dependency implemented by RecoveryService; setup owns its construction and wiring. */
export interface RecoveryRuntime {
  capture(sessionId: string, reason: string, runId?: string): Promise<RecoveryCheckpoint>;
  recordFailure(sessionId: string, runId: string, failure: ProviderFailure): void;
}

/** The provider module surface (apps/server/src/providers/index.ts) as consumed by the runtime. */
export interface ProviderRuntime {
  createAdapter(provider: Provider): AgentAdapter;
  detectProviders(settings: AppSettings): Promise<ProviderInfo[]>;
  getCatalog?(session: Session, settings: AppSettings): Promise<ProviderCatalog>;
  getUsage?(session: Session, settings: AppSettings): Promise<ProviderUsage>;
  getAccountUsage?(provider: AccountUsageProvider, settings: AppSettings): Promise<ProviderAccountUsageSnapshot>;
  redeemAccountUsageReset?(provider: AccountUsageProvider, settings: AppSettings, snapshotToken: string, input: RedeemProviderResetInput): Promise<ProviderResetResult>;
  invalidateAccountUsage?(): void;
  listConversations?(provider: Provider, settings: AppSettings, options: ConversationListOptions): Promise<ExternalConversationList>;
  readConversation?(provider: Provider, settings: AppSettings, id: string): Promise<ExternalConversationDetails>;
  /** Stops any provider helper processes still alive after runs are finished, such as metadata probes. */
  close?(): Promise<void>;
}

export type Logger = (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
