import type { ProviderInfo, SessionPlan } from '@mingle/contracts';
import type { GroupService } from './groups/service.ts';
import type { ProviderService } from './provider-service.ts';
import type { SessionRuntime } from './runtime.ts';
import type { Store, SessionResumeEntry } from './store.ts';
import type { Logger } from './types.ts';
import { errorMessage, redactSecrets, truncate } from './util.ts';

const MAX_RESUME_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_RESUMES = 2;
const RESUME_START_STAGGER_MS = 250;
const CONTINUATION_PROMPT = 'Mingle was closed while you were working. Continue the previous task from where you left off. First check the current state of the files and any partial work; do not redo finished steps.';

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class SessionResumeService {
  private started = false;

  constructor(
    private readonly store: Store,
    private readonly runtime: SessionRuntime,
    private readonly providers: ProviderService,
    private readonly groups: GroupService,
    private readonly log: Logger,
  ) {}

  /** Provider discovery and all resume work happen after listen(), outside the startup path. */
  start(signal: AbortSignal): void {
    if (this.started) return;
    this.started = true;
    if (!this.store.queuedSessionResumes().length) return;
    void this.run(signal).catch((error) => this.log('warn', 'Automatic session resume could not be completed', error));
  }

  private async run(signal: AbortSignal): Promise<void> {
    const detected = await this.providers.list();
    if (signal.aborted) return;
    const entries = this.store.queuedSessionResumes();
    let cursor = 0;
    let nextStartAt = Date.now();
    const worker = async () => {
      while (!signal.aborted) {
        const entry = entries[cursor++];
        if (!entry) return;
        const stagger = Math.max(0, nextStartAt - Date.now());
        nextStartAt = Math.max(Date.now(), nextStartAt) + RESUME_START_STAGGER_MS;
        await wait(stagger, signal);
        if (signal.aborted) return;
        await this.resume(entry, detected, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_RESUMES, entries.length) }, worker));
  }

  private async resume(entry: SessionResumeEntry, detected: ProviderInfo[], signal: AbortSignal): Promise<void> {
    const setting = this.store.getSettings().autoResumeOnRestart !== false;
    if (!setting) return this.skip(entry, 'disabled-by-setting');

    const session = this.store.getSession(entry.sessionId, true);
    if (!session || !this.store.getSession(entry.sessionId)) return this.skip(entry, 'session-archived-or-missing');
    const run = this.store.getRun(entry.runId);
    if (!run) return this.skip(entry, 'interrupted-run-missing');
    const startedAt = Date.parse(run.startedAt);
    if (!Number.isFinite(startedAt) || Date.now() - startedAt > MAX_RESUME_AGE_MS) return this.skip(entry, 'interrupted-run-expired');
    if (session.status === 'running' || session.status === 'waiting' || this.runtime.isActive(session.id)) return this.skip(entry, 'session-already-active');
    if (this.store.isTeamProxySession(session.id)) return this.skip(entry, 'team-proxy-owned-by-another-device');
    if (this.groups.forSession(session.id)) return this.skip(entry, 'group-delivery-managed');
    if (!detected.some((provider) => provider.id === session.provider && provider.available)) return this.skip(entry, 'provider-unavailable');
    if (signal.aborted) return;
    if (!this.store.claimSessionResume(entry.runId)) return;

    try {
      const plan = this.interruptedPlan(entry, session.id);
      let resumedRunId: string | null;
      if (plan) {
        if (plan.status !== 'interrupted' || plan.approvedRevision !== plan.revision) {
          return this.finishSkipped(entry, 'interrupted-plan-was-not-approved');
        }
        this.store.updateSessionPlan({ ...plan, status: 'approved', executionRunId: null, updatedAt: new Date().toISOString() });
        const result = await this.runtime.executePlan(plan.id);
        resumedRunId = result.runId;
        if (!resumedRunId) return this.finishSkipped(entry, 'plan-execution-not-started');
      } else {
        const userMessage = this.store.getMessage(run.userMessageId);
        const context = session.providerSessionId ? undefined : this.continuationContext(userMessage?.content ?? '');
        resumedRunId = this.runtime.start(session.id, CONTINUATION_PROMPT, {
          userMessage: { content: CONTINUATION_PROMPT, kind: 'remote-recovery' },
          ...(entry.taskId && this.store.getTask(entry.taskId) ? { taskId: entry.taskId } : {}),
          ...(context ? { context } : {}),
        });
      }
      this.store.finishSessionResume(entry.runId, { resumedRunId });
      this.store.recordEvent({
        projectId: session.projectId, sessionId: session.id, type: 'session.run.resumed',
        summary: `Run resumed after restart: ${session.name}`,
        payload: { interruptedRunId: entry.runId, runId: resumedRunId, taskId: entry.taskId, plan: Boolean(plan) },
      });
      while (!signal.aborted && this.runtime.isActive(session.id)) await wait(250, signal);
    } catch (error) {
      this.finishSkipped(entry, 'resume-start-failed');
      this.log('warn', `Automatic resume failed for ${session.id}: ${truncate(redactSecrets(errorMessage(error)), 300)}`);
    }
  }

  private interruptedPlan(entry: SessionResumeEntry, sessionId: string): SessionPlan | undefined {
    return this.store.listSessionPlans(sessionId).find((plan) => plan.executionRunId === entry.runId && plan.status === 'interrupted');
  }

  private continuationContext(lastRequest: string): string {
    const compactRequest = truncate(redactSecrets(lastRequest.trim()), 10_000);
    return [
      'Mingle continuation context. The native provider conversation was not available, so this is the most recent request saved by Mingle.',
      compactRequest ? `Previous user request:\n${compactRequest}` : 'The interrupted run did not retain a readable user request.',
    ].join('\n\n');
  }

  private skip(entry: SessionResumeEntry, reason: string): void {
    this.store.finishSessionResume(entry.runId, { skippedReason: reason });
    const session = this.store.getSession(entry.sessionId, true);
    this.store.recordEvent({
      projectId: session?.projectId ?? null, sessionId: entry.sessionId, type: 'session.run.resume-skipped',
      summary: `Automatic resume skipped (${reason})`, payload: { interruptedRunId: entry.runId, reason },
    });
  }

  private finishSkipped(entry: SessionResumeEntry, reason: string): void {
    this.skip(entry, reason);
  }
}

export { CONTINUATION_PROMPT };
