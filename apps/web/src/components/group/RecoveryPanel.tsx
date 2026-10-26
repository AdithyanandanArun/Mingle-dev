import { useEffect, useMemo, useRef, useState } from 'react';
import type { GroupRecoveryState, GroupSnapshot, ProviderInfo, Session, SessionRun, Task } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import { activeMembers, isBusy, providerAvailability, providerName, ROLE_LABEL } from '../../lib/groups';
import { ApiError, api, errorMessage, type ApiProviderFailure, type ApiRecoveryActionRequest, type ApiRecoveryCheckpoint, type ApiRecoveryActionResult } from '../../lib/api';
import { shortPath } from '../../lib/format';
import { Button, InlineError } from '../ui';
import { SelectMenu } from '../SelectMenu';
import { AgentIdentity } from './AgentIdentity';
import '../../styles/recovery.css';

const EMPTY_PROVIDERS: ProviderInfo[] = [];

type RecoverySnapshot = { checkpoint: ApiRecoveryCheckpoint | null; failure: ApiProviderFailure | null };

const time = (value: string | null | undefined): number => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};
const when = (value: string | null | undefined): string => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'time not recorded';
  return new Date(value).toLocaleString();
};
const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
};
const failureName: Record<ApiProviderFailure['kind'], string> = {
  context_exhausted: 'Context limit reached', output_truncated: 'Output ended early', quota_exhausted: 'Provider quota exhausted',
  temporary_rate_limit: 'Temporary rate limit', authentication: 'Authentication failed', provider_unavailable: 'Provider unavailable', unknown: 'Failure type unknown',
};
const taskState: Record<Task['status'], string> = { backlog: 'Backlog', ready: 'Ready', running: 'Running', blocked: 'Blocked', review: 'Needs review', done: 'Accepted' };
const recoveryStateLabel: Record<GroupRecoveryState['status'], string> = { healthy: 'Healthy', degraded: 'Degraded', paused: 'Waiting for your decision', recovering: 'Recovery in progress' };

/** Actionable status is shown only when the scheduler reports a recovery state or the latest request has an unfinished failed turn. */
export function RecoveryPanel({ snapshot, sessions, runs, tasks }: {
  snapshot: GroupSnapshot; sessions: readonly Session[]; runs: readonly SessionRun[]; tasks: readonly Task[];
}) {
  const connection = useMingle((state) => state.connection);
  const providers = useMingle((state) => state.boot?.providers ?? EMPTY_PROVIDERS);
  const globalAction = useMingle((state) => state.groupActionBusyId);
  const group = snapshot.group;
  const resilientMembers = snapshot.members;
  const requests = [...snapshot.requests].sort((a, b) => time(b.createdAt) - time(a.createdAt));
  const request = (group.recoveryState?.activeRequestId ? snapshot.requests.find((item) => item.id === group.recoveryState?.activeRequestId) : undefined)
    ?? requests.find((item) => item.status === 'active' || item.status === 'paused') ?? requests[0];
  const requestDeliveries = snapshot.deliveries.filter((delivery) => !request || delivery.requestId === request.id);
  const candidateDelivery = [...requestDeliveries]
    .filter((delivery) => !delivery.recoveredByDeliveryId)
    .filter((delivery) => delivery.failure || delivery.status === 'failed' || delivery.status === 'interrupted')
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt))[0];
  const authoritativeHealthy = group.recoveryState?.status === 'healthy';
  const groupNeedsAttention = Boolean(group.recoveryState && group.recoveryState.status !== 'healthy');
  const affectedDelivery = authoritativeHealthy ? undefined : candidateDelivery;
  const members = activeMembers(snapshot);
  const latestMemberFailure = [...resilientMembers]
    .filter((member) => !authoritativeHealthy && member.failure && (groupNeedsAttention || Boolean(affectedDelivery && (!affectedDelivery.runId || !member.failure.runId || member.failure.runId === affectedDelivery.runId))))
    .sort((a, b) => time(b.failure?.occurredAt) - time(a.failure?.occurredAt))[0];
  const member = resilientMembers.find((item) => item.id === affectedDelivery?.memberId)
    ?? resilientMembers.find((item) => item.sessionId === latestMemberFailure?.sessionId)
    ?? resilientMembers.find((item) => item.id === request?.plannerMemberId)
    ?? resilientMembers.find((item) => item.id === group.orchestratorMemberId);
  const session = member ? sessions.find((item) => item.id === member.sessionId) : undefined;
  const relevantFailure = affectedDelivery?.failure ?? (groupNeedsAttention || affectedDelivery ? latestMemberFailure?.failure ?? member?.failure : undefined);
  const needsAttention = Boolean(
    groupNeedsAttention
    || (!authoritativeHealthy && affectedDelivery)
    || group.recoveryState?.pendingCheckpointId,
  );
  const hasLeadFailure = Boolean(relevantFailure?.actor === 'lead'
    || (member && (member.id === group.orchestratorMemberId || member.id === request?.plannerMemberId)));
  const groupRunIds = useMemo(() => new Set(requestDeliveries.flatMap((delivery) => delivery.runId ? [delivery.runId] : [])), [requestDeliveries]);
  const recordedRuns = runs.filter((run) => groupRunIds.has(run.id));
  const recordedDurationRuns = recordedRuns.filter((run) => run.durationMs !== null);
  const knownRunDuration = recordedDurationRuns.reduce((sum, run) => sum + (run.durationMs ?? 0), 0);
  const requestElapsedMs = request && (request.status === 'active' || request.status === 'paused') ? Date.now() - Date.parse(request.createdAt) : NaN;
  const requestElapsedLabel = Number.isFinite(requestElapsedMs) ? `${formatDuration(requestElapsedMs)} since request start (includes queued and waiting time)` : 'not recorded';
  const savedPolicy = group.recoveryPolicy;
  const initialReplacement = hasLeadFailure ? savedPolicy?.leadFallbackMemberId : member ? savedPolicy?.workerFallbacks?.[member.id] : undefined;
  const [replacementMemberId, setReplacementMemberId] = useState(initialReplacement ?? 'none');
  const [recovery, setRecovery] = useState<RecoverySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const inFlight = useRef(false);
  const pendingActions = useRef(new Map<string, { idempotencyKey: string; request: ApiRecoveryActionRequest }>());
  const completedAction = useRef<string | null>(null);

  useEffect(() => {
    setReplacementMemberId(initialReplacement ?? 'none');
    setRecovery(null);
    setLoadError(null);
    setActionError(null);
    setActionMessage(null);
  }, [snapshot.group.id, member?.id, initialReplacement]);

  useEffect(() => {
    if (!needsAttention || !session || connection !== 'online') return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void api.sessionRecovery(session.id, controller.signal).then((value) => {
      if (!controller.signal.aborted) setRecovery(value);
    }).catch((cause) => {
      if (!controller.signal.aborted) setLoadError(errorMessage(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [needsAttention, session?.id, connection, reload]);

  const checkpoint = recovery?.checkpoint ?? null;
  const failure = relevantFailure ?? recovery?.failure ?? null;
  const failureSession = failure ? sessions.find((item) => item.id === failure.sessionId) : session;
  const failureRunMatches = !affectedDelivery?.runId || !failure?.runId || failure.runId === affectedDelivery.runId;
  const visibleFailure = failureRunMatches ? failure : relevantFailure;
  const relatedTasks = affectedDelivery
    ? snapshot.assignments.filter((assignment) => assignment.deliveryId === affectedDelivery.id).map((assignment) => tasks.find((task) => task.id === assignment.taskId)).filter((task): task is Task => Boolean(task))
    : [];
  const remainingTasks = checkpoint?.tasks.length
    ? checkpoint.tasks.filter((task) => task.status !== 'done').map((task) => ({ id: task.id, title: task.title, state: taskState[task.status] }))
    : relatedTasks.filter((task) => task.status !== 'done').map((task) => ({ id: task.id, title: task.title, state: taskState[task.status] }));
  const pendingCheckpointId = group.recoveryState?.pendingCheckpointId;
  const acknowledgedGroupCheckpointId = request && group.recoveryState?.activeRequestId === request.id
    ? group.recoveryState.acknowledgedCheckpointId : undefined;
  const failureRequiresGroupCheckpoint = Boolean(visibleFailure && (
    visibleFailure.outcomeUnknown || visibleFailure.dispatchState === 'unknown' || visibleFailure.continuationSafety !== 'safe'
  ));
  const replacementMember = members.find((candidate) => candidate.id === replacementMemberId);
  const replacementSession = replacementMember ? sessions.find((item) => item.id === replacementMember.sessionId) : undefined;
  const reassignmentCrossesWorktrees = replacementMemberId !== 'none' && (
    !session || !replacementSession || session.worktreePath !== replacementSession.worktreePath
  );
  const reassignRequiresGroupCheckpoint = failureRequiresGroupCheckpoint || reassignmentCrossesWorktrees;
  const acknowledgedForDelivery = !affectedDelivery || Boolean(group.recoveryState?.acknowledgedDeliveryIds?.includes(affectedDelivery.id));
  const acknowledgedForCurrentScope = Boolean(
    request && group.recoveryState?.activeRequestId === request.id
    && acknowledgedGroupCheckpointId && acknowledgedForDelivery
    && (!pendingCheckpointId || pendingCheckpointId === acknowledgedGroupCheckpointId),
  );
  const retryCheckpointAcknowledgementRequired = failureRequiresGroupCheckpoint && !acknowledgedForCurrentScope;
  const reassignCheckpointAcknowledgementRequired = reassignRequiresGroupCheckpoint && !acknowledgedForCurrentScope;
  const retryCheckpointId = failureRequiresGroupCheckpoint && !retryCheckpointAcknowledgementRequired
    ? acknowledgedGroupCheckpointId : undefined;
  const reassignCheckpointId = reassignRequiresGroupCheckpoint && !reassignCheckpointAcknowledgementRequired
    ? acknowledgedGroupCheckpointId : undefined;
  const outcomeMayBeUnknown = Boolean(visibleFailure?.outcomeUnknown || visibleFailure?.dispatchState === 'unknown');
  const failureNeedsHumanReview = Boolean(outcomeMayBeUnknown || (visibleFailure && visibleFailure.continuationSafety !== 'safe'));
  const currentRun = affectedDelivery?.runId ? recordedRuns.find((run) => run.id === affectedDelivery.runId) : undefined;
  const assignmentEvidence = snapshot.assignments
    .filter((assignment) => !affectedDelivery || assignment.deliveryId === affectedDelivery.id)
    .flatMap((assignment) => assignment.milestones ?? []);
  const replacementChoices = members.filter((candidate) => candidate.id !== member?.id).map((candidate) => {
    const candidateSession = sessions.find((item) => item.id === candidate.sessionId);
    const availability = candidateSession ? providerAvailability(providers, candidateSession.provider) : null;
    const isBusyMember = isBusy(candidateSession);
    const unavailable = candidate.held ? 'Paused in this group'
      : !candidateSession ? 'Session unavailable'
        : isBusyMember ? 'Busy with another run or queued work'
        : availability && !availability.available ? `Provider unavailable: ${availability.reason}` : undefined;
    const configuration = candidateSession
      ? `${providerName(candidateSession.provider)} · ${candidateSession.model} · ${candidateSession.effort} effort · ${candidateSession.policy} permissions · ${candidateSession.isolated ? `isolated worktree${candidateSession.branch ? ` (${candidateSession.branch})` : ''}` : 'project folder'} · existing conversation`
      : 'Session configuration unavailable';
    return { value: candidate.id, label: `@${candidate.handle}`, description: `${ROLE_LABEL[candidate.role]} · ${configuration}${unavailable ? ` · ${unavailable}` : ''}`, disabled: Boolean(unavailable) };
  });
  const replacementAllowed = replacementChoices.some((option) => option.value === replacementMemberId && !option.disabled);
  const deliveryBusy = affectedDelivery?.status === 'queued' || affectedDelivery?.status === 'running';
  const affectedBusy = isBusy(session);
  const plannerRequest = affectedDelivery
    ? snapshot.requests.find((item) => item.id === affectedDelivery.requestId)
    : request;
  const plannerRequestAvailable = !hasLeadFailure || group.mode !== 'cowork' || Boolean(plannerRequest && (plannerRequest.status === 'active' || plannerRequest.status === 'paused'));
  const online = connection === 'online';
  const actionLocked = busyAction !== null || globalAction !== null || inFlight.current;
  const failureKey = visibleFailure?.id ?? affectedDelivery?.id ?? 'group-state';
  const retryScope = `retry:${affectedDelivery?.id ?? 'none'}:${failureKey}`;
  const reassignScope = `reassign:${affectedDelivery?.id ?? member?.id ?? 'none'}:${replacementMemberId}:${failureKey}`;
  const askScope = `ask:${request?.id ?? group.id}`;
  const ackScope = `ack:${request?.id ?? group.id}:${affectedDelivery?.id ?? 'request'}:${pendingCheckpointId ?? 'none'}`;
  const canRetry = Boolean(affectedDelivery && !deliveryBusy && !affectedBusy && !retryCheckpointAcknowledgementRequired);
  const canReassign = Boolean(replacementAllowed && !deliveryBusy && !affectedBusy && plannerRequestAvailable && !reassignCheckpointAcknowledgementRequired && (affectedDelivery || hasLeadFailure));
  const reassignLabel = hasLeadFailure
    ? group.mode === 'cowork' ? 'Replace planner' : group.mode === 'current-leads' ? 'Replace lead · switch to Orchestrated' : 'Replace coordinator'
    : 'Reassign';
  const state = group.recoveryState?.status;
  const title = state === 'recovering' ? 'Recovery in progress' : state === 'degraded' ? 'Coordination needs attention' : state === 'paused' ? 'Waiting for your decision' : 'A turn needs attention';
  const detail = group.recoveryState?.reason || visibleFailure?.message || affectedDelivery?.error || 'A recorded group turn needs review.';

  const performAction = async (scope: string, makeAction: (idempotencyKey: string) => ApiRecoveryActionRequest): Promise<ApiRecoveryActionResult | null> => {
    if (!online || actionLocked || inFlight.current) {
      setActionError(!online ? 'Reconnect to Mingle before changing recovery state.' : 'Another group action is already in progress.');
      return null;
    }
    if (completedAction.current === scope) return null;
    inFlight.current = true;
    setBusyAction(scope);
    setActionError(null);
    setActionMessage(null);
    const pending = pendingActions.current.get(scope);
    const idempotencyKey = pending?.idempotencyKey ?? crypto.randomUUID();
    const action = pending?.request ?? makeAction(idempotencyKey);
    pendingActions.current.set(scope, { idempotencyKey, request: action });
    useMingle.getState().setGroupActionBusy(group.id);
    try {
      const result = await api.recoverGroup(group.id, action);
      pendingActions.current.delete(scope);
      completedAction.current = scope;
      setActionMessage(result.status === 'already-applied' ? 'This recovery action was already recorded.' : 'Recovery action recorded. No new work starts until the scheduler accepts it.');
      await useMingle.getState().refreshNow();
      return result;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.status !== 429) pendingActions.current.delete(scope);
      setActionError(errorMessage(cause));
      return null;
    } finally {
      inFlight.current = false;
      setBusyAction(null);
      if (useMingle.getState().groupActionBusyId === group.id) useMingle.getState().setGroupActionBusy(null);
    }
  };

  const createCheckpoint = async () => {
    if (!online || !session || affectedBusy || actionLocked || inFlight.current) {
      setActionError(!online ? 'Reconnect to Mingle before saving a checkpoint.' : affectedBusy ? 'Wait for this member’s run and cleanup to finish before capturing a checkpoint.' : 'Another group action is already in progress.');
      return;
    }
    inFlight.current = true;
    setBusyAction('checkpoint');
    setActionError(null);
    setActionMessage(null);
    useMingle.getState().setGroupActionBusy(group.id);
    try {
      const created = await api.createCheckpoint(session.id, 'group recovery review', affectedDelivery?.runId ?? undefined);
      setRecovery((current) => ({ checkpoint: created, failure: current?.failure ?? null }));
      setActionMessage('Recovery checkpoint saved. It records references and status; it does not certify task acceptance.');
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setBusyAction(null);
      if (useMingle.getState().groupActionBusyId === group.id) useMingle.getState().setGroupActionBusy(null);
    }
  };

  if (!needsAttention) return null;

  const failureClass = visibleFailure ? failureName[visibleFailure.kind] : null;
  const retryAt = visibleFailure?.retryAt && Number.isFinite(Date.parse(visibleFailure.retryAt)) ? when(visibleFailure.retryAt) : null;
  const actionWhy = !online ? 'Reconnect to Mingle first.' : actionLocked ? 'Another group action is in progress.' : undefined;
  const checkpointScopeLabel = affectedDelivery ? 'request and delivery’s group checkpoint' : 'request’s group checkpoint';
  const retryCheckpointReviewWhy = retryCheckpointAcknowledgementRequired ? `Ask me, then acknowledge this ${checkpointScopeLabel} before retrying.` : undefined;
  const reassignCheckpointReviewWhy = reassignCheckpointAcknowledgementRequired
    ? reassignmentCrossesWorktrees
      ? `This reassignment crosses worktrees. Ask me, then acknowledge this ${checkpointScopeLabel} before reassigning.`
      : `Ask me, then acknowledge this ${checkpointScopeLabel} before reassigning.`
    : undefined;
  const checkpointGuidance = retryCheckpointReviewWhy && reassignCheckpointReviewWhy
    ? `Acknowledge this ${checkpointScopeLabel} before retrying or reassigning.`
    : retryCheckpointReviewWhy ?? reassignCheckpointReviewWhy;
  const sessionBusyWhy = affectedBusy || deliveryBusy ? 'Wait for the affected member’s run or queued delivery to settle.' : undefined;
  const detailRows = checkpoint ? [
    ...checkpoint.pendingApprovals.map((approval) => `Approval pending: ${approval.tool} — ${approval.description}`),
    ...checkpoint.errors.map((item) => `Recorded error: ${item.message}`),
    ...checkpoint.uncertainTools.map((tool) => `Tool result needs review: ${tool.name} · ${tool.status}${tool.summary ? ` — ${tool.summary}` : ''}`),
  ] : [];

  return (
    <section className="recovery-panel" aria-label="Group recovery" aria-busy={loading || busyAction !== null}>
      <header className="recovery-panel__head">
        <div className="recovery-panel__heading"><span className="recovery-panel__eyebrow">Recovery</span><strong>{title}</strong></div>
        {member ? <AgentIdentity handle={member.handle} identityKey={member.sessionId} provider={session?.provider} role={hasLeadFailure ? 'Lead' : undefined} removed={Boolean(member.removedAt)} /> : <span className="recovery-panel__muted">Affected member unavailable</span>}
        {group.recoveryState ? <span className="recovery-panel__state">{recoveryStateLabel[group.recoveryState.status]}</span> : null}
      </header>
      <p className="recovery-panel__reason">{detail}</p>
      {visibleFailure ? <div className="recovery-panel__failure" aria-label="Provider failure details">
        <span>{failureClass}</span>
        {visibleFailure.providerCode ? <code>{visibleFailure.providerCode}</code> : null}
        {outcomeMayBeUnknown ? <strong>Operation result unknown — review the workspace before repeating it.</strong> : null}
        {visibleFailure.safeToRetry === true ? <small>Provider marked this attempt safe to retry.</small> : visibleFailure.safeToRetry === false ? <small>Provider marked replay unsafe.</small> : <small>Retry safety was not reported.</small>}
        {retryAt ? <small>Provider retry time: {retryAt}</small> : null}
        {visibleFailure.quotaPool ? <small>Reported quota pool: {visibleFailure.quotaPool}</small> : null}
      </div> : null}
      <div className="recovery-panel__summary">
        <div><span>Latest checkpoint</span><strong>{loading ? 'Checking…' : checkpoint ? `${checkpoint.reason} · ${when(checkpoint.capturedAt)}` : 'Not recorded'}</strong></div>
      </div>
      {pendingCheckpointId ? <p className="recovery-panel__checkpoint" role="status">A batch checkpoint is waiting for acknowledgement: <code>{pendingCheckpointId}</code></p> : null}
      {checkpoint || request || relatedTasks.length || assignmentEvidence.length ? <details className="recovery-panel__details">
        <summary>Checkpoint details and recorded evidence</summary>
        <div className="recovery-panel__summary">
          {checkpoint?.objective ? <div><span>Objective</span><p>{checkpoint.objective}</p></div> : null}
          <div><span>Workspace</span><strong>{checkpoint ? checkpoint.worktree.statusKnown !== true ? 'Status unknown' : checkpoint.worktree.isRepository ? 'Repository status recorded' : 'Not a Git repository' : 'Checkpoint unavailable'}</strong>
            {checkpoint?.worktree.path ? <small title={checkpoint.worktree.path}>{shortPath(checkpoint.worktree.path, 4)}{checkpoint.worktree.branch ? ` · ${checkpoint.worktree.branch}` : ''}{checkpoint.worktree.head ? ` · ${checkpoint.worktree.head.slice(0, 8)}` : ''}</small> : null}
            {checkpoint?.worktree.statusKnown === true ? <small>{checkpoint.worktree.dirtyPaths.length}{checkpoint.worktree.dirtyPathsTruncated ? '+' : ''} changed path{checkpoint.worktree.dirtyPaths.length === 1 ? '' : 's'} recorded</small> : null}
          </div>
          <div><span>Remaining work</span>{remainingTasks.length ? <ul className="recovery-panel__tasks">{remainingTasks.slice(0, 5).map((task) => <li key={task.id}><strong>{task.title}</strong><small>{task.state}</small></li>)}</ul> : <p>{checkpoint ? 'No unfinished task state is listed in this checkpoint.' : relatedTasks.length ? 'No unfinished assigned task state is recorded.' : 'Remaining tasks are not recorded.'}</p>}</div>
          <div className="recovery-panel__usage"><span>Request elapsed time</span>
            <strong>{requestElapsedLabel}</strong>
            <small>Recorded request usage: {request ? `${request.turnsUsed} durable turns` : 'turn count not recorded'} · {groupRunIds.size} run IDs linked to deliveries</small>
            <small>{recordedRuns.length} run records available{recordedRuns.length < groupRunIds.size ? ' · partial snapshot' : ''} · summed final run duration: {recordedDurationRuns.length ? `${formatDuration(knownRunDuration)} across ${recordedDurationRuns.length} recorded durations` : 'not recorded'}</small>
            <small>Group cost is unknown; provider costs are not reported as a group total.</small>
          </div>
        </div>
        {checkpoint ? <>
          {checkpoint.worktree.statusKnown === true && checkpoint.worktree.dirtyPaths.length ? <div><strong>Changed paths recorded</strong><ul>{checkpoint.worktree.dirtyPaths.slice(0, 6).map((path) => <li key={path}><code>{path}</code></li>)}</ul>{checkpoint.worktree.dirtyPathsTruncated ? <small>Path list truncated.</small> : null}</div> : null}
          {checkpoint.artifacts.length ? <div><strong>Artifacts referenced</strong><ul>{checkpoint.artifacts.slice(0, 6).map((artifact) => <li key={artifact.id}><code>{artifact.path}</code> · <code>{artifact.revision.slice(0, 12)}</code></li>)}</ul></div> : null}
          {detailRows.length ? <ul>{detailRows.slice(0, 12).map((row) => <li key={row}>{row}</li>)}</ul> : null}
          {checkpoint.notices?.map((notice) => <p key={notice}>{notice}</p>)}
        </> : null}
        {assignmentEvidence.length ? <div><strong>Assignment milestones · recorded, not acceptance</strong><ul>{assignmentEvidence.map((item) => <li key={item.id}>{item.label} · {item.status} · {item.acceptanceProvenance} criteria{item.evidence ? ` — ${item.evidence}` : ''}</li>)}</ul></div> : null}
        <p className="recovery-panel__caveat">Task and milestone states are Mingle records. Checks stated only in agent messages are reported, not verified; this checkpoint does not accept work.</p>
      </details> : null}
      {loadError ? <InlineError onRetry={() => setReload((value) => value + 1)}>Could not load the latest recovery checkpoint: {loadError}</InlineError> : null}
      {!checkpoint && !loading && session ? <Button size="sm" variant="ghost" disabled={!online || affectedBusy || actionLocked} why={actionWhy ?? sessionBusyWhy ?? 'The server is offline.'} busy={busyAction === 'checkpoint'} onClick={() => void createCheckpoint()}>Save checkpoint</Button> : null}
      <div className="recovery-panel__actions">
        {affectedDelivery ? <Button size="sm" disabled={!canRetry || actionLocked || !online || completedAction.current === retryScope} why={retryCheckpointReviewWhy ?? sessionBusyWhy ?? actionWhy ?? 'No failed or interrupted delivery to retry.'} busy={busyAction === retryScope} onClick={() => void performAction(retryScope, (idempotencyKey) => ({
          action: 'retry-delivery', deliveryId: affectedDelivery.id, ...(retryCheckpointId ? { checkpointId: retryCheckpointId } : {}),
          approachNote: 'Use a different approach. Inspect the current workspace and saved checkpoint, preserve completed work, and continue only what remains.', idempotencyKey,
        }))}>Retry with new approach</Button> : null}
        {(affectedDelivery || hasLeadFailure) ? <div className="recovery-panel__reassign">
          <SelectMenu label="Reassign to member" value={replacementMemberId} displayValue={replacementMemberId === 'none' ? 'Choose member' : undefined} disabled={actionLocked || !online || replacementChoices.length === 0} options={[{ value: 'none', label: 'Choose member', disabled: true }, ...replacementChoices]} onChange={(value) => { setReplacementMemberId(value); setActionError(null); setActionMessage(null); }} />
          <div className="recovery-panel__reassign-guidance">
            <small className="recovery-panel__muted">The selected member’s existing conversation and workspace are used; source partial edits remain intact and checkpoint/dirty-path references are retained. No files are copied or merged, and permissions do not change.</small>
            {hasLeadFailure && group.mode === 'cowork' ? <small className="recovery-panel__muted">Only this request’s planner is replaced; the other Cowork peers remain.</small> : null}
            {hasLeadFailure && group.mode === 'current-leads' ? <small className="recovery-panel__muted">This switches the group to Orchestrated mode; the original anchor and history remain.</small> : null}
          </div>
          <Button size="sm" disabled={!canReassign || actionLocked || !online || completedAction.current === reassignScope} why={reassignCheckpointReviewWhy ?? sessionBusyWhy ?? actionWhy ?? (!plannerRequestAvailable ? 'The active Cowork request is unavailable, so its planner cannot be replaced safely.' : replacementChoices.length ? 'Choose an available existing member.' : 'No eligible existing member is available.')} busy={busyAction === reassignScope} onClick={() => void performAction(reassignScope, (idempotencyKey) => {
            if (!hasLeadFailure) return { action: 'fallback-delivery', deliveryId: affectedDelivery!.id, replacementMemberId, ...(reassignCheckpointId ? { checkpointId: reassignCheckpointId } : {}), idempotencyKey };
            const action: Extract<ApiRecoveryActionRequest, { action: 'replace-coordinator' }> = {
              action: 'replace-coordinator', replacementMemberId,
              ...(group.mode === 'cowork' && plannerRequest ? { requestId: plannerRequest.id } : {}),
              ...(reassignCheckpointId ? { checkpointId: reassignCheckpointId } : {}), idempotencyKey,
            };
            return action;
          })}>{reassignLabel}</Button>
        </div> : null}
        <Button size="sm" variant="ghost" disabled={!online || actionLocked || completedAction.current === askScope} why={actionWhy ?? undefined} busy={busyAction === askScope} onClick={() => void performAction(askScope, (idempotencyKey) => ({
          action: 'pause-for-human', ...(affectedDelivery ? { deliveryId: affectedDelivery.id } : {}), reason: group.recoveryState?.reason || visibleFailure?.message || 'Human review requested from the recovery panel.', idempotencyKey,
        }))}>Ask me</Button>
        {pendingCheckpointId ? <Button size="sm" variant="secondary" disabled={!online || actionLocked || completedAction.current === ackScope} why={actionWhy ?? undefined} busy={busyAction === ackScope} onClick={() => void performAction(ackScope, (idempotencyKey) => ({ action: 'acknowledge-checkpoint', checkpointId: pendingCheckpointId, idempotencyKey }))}>Acknowledge checkpoint</Button> : null}
      </div>
      {checkpointGuidance ? <p className="recovery-panel__checkpoint-review" role="note">{checkpointGuidance}</p> : null}
      {failureNeedsHumanReview ? <p className="recovery-panel__risk" role="note">{outcomeMayBeUnknown
        ? 'The result of the last operation is unknown. Inspect the current workspace before retrying or reassigning.'
        : !acknowledgedForCurrentScope
          ? `Provider continuation safety is ${visibleFailure?.continuationSafety}. Acknowledge the request’s group checkpoint before retrying or reassigning.`
          : 'Checkpoint acknowledged; choose how to continue.'}</p> : null}
      {!online ? <p className="recovery-panel__muted" role="status">Reconnect to Mingle before taking a recovery action.</p> : null}
      {actionError ? <InlineError>{actionError}</InlineError> : null}
      {actionMessage ? <p className="recovery-panel__success" role="status">{actionMessage}</p> : null}
      {currentRun?.status === 'running' ? <p className="recovery-panel__muted">The affected member still has an active recorded run.</p> : null}
      {failureSession && failureSession.id !== session?.id ? <small className="recovery-panel__muted">Failure recorded for {failureSession.name} · {providerName(failureSession.provider)}.</small> : null}
    </section>
  );
}
