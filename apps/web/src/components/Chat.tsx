import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, FolderPlus } from 'lucide-react';
import type { Approval, SessionPlan, SessionRun, Task, ToolCall, UserQuestion, WorkspaceEvent } from '@mingle/contracts';
import type { DisplayMessage } from '../lib/conversation';
import type { SubagentRun } from '../lib/subagents';
import { useMingle, useProject, useActiveSession, useActiveGroup } from '../store/store';
import { Button, EmptyState, MingleGlyph, PROVIDER_NAME } from './ui';
import { ApprovalCard, SessionPlanCard, UserQuestionCard } from './ConversationParts';
import { TranscriptList } from './TranscriptList';
import { GroupConversation } from './group/GroupConversation';
import { Composer } from './Composer';
import { GitBar } from './git/GitBar';
import { TeamSessionView } from './team-chat/TeamSessionView';
import { useTeamStructure } from '../lib/team-structure-context';
import { TeamConsentBanner } from './team-orchestration/settings/TeamConsentBanner';
import { createTranscriptDeriver } from '../lib/transcript';
import { useSessionStreamIds, useStableById } from '../lib/transcriptHooks';
import { SubagentChatView } from './subagents/SubagentChatView';
import { SubagentRail } from './subagents/SubagentRail';
import { deriveStatusBarState } from './status-bar/deriveStatusBarState';
import { api, errorMessage } from '../lib/api';
import { useSessionHistory } from '../lib/sessionHistoryHooks';
import { captureReaderAnchor, restoreReaderAnchor, type ReaderAnchor } from '../lib/readerAnchor';
import { SessionHistoryControl } from './SessionHistoryControl';
import { ConversationNavigation } from './ConversationNavigation';
import { loadReaderPosition, saveReaderPosition, type SavedReaderPosition } from '../lib/conversationPersistence';

/** How long after prepending history the reader's row is kept in place while deferred rows settle to their real height. */
const ANCHOR_SETTLE_MS = 800;
/** How long the conversation's live region stays silent while a page of older messages is inserted. */
const QUIET_LIVE_REGION_MS = 500;
const EMPTY_MESSAGES: readonly DisplayMessage[] = [];
const EMPTY_SESSION_RUNS: readonly SessionRun[] = [];
const EMPTY_SESSION_CALLS: readonly ToolCall[] = [];
const EMPTY_SESSION_SUBAGENTS: readonly SubagentRun[] = [];
const EMPTY_PLANS: SessionPlan[] = [];
const EMPTY_QUESTIONS: UserQuestion[] = [];
const EMPTY_TASKS: Task[] = [];
const EMPTY_EVENTS: WorkspaceEvent[] = [];
const EMPTY_APPROVALS: Approval[] = [];

/** A converted session opens as its group's shared conversation; everything else stays a single session. */
export function SessionPane() {
  const group = useActiveGroup();
  const project = useProject();
  const selectedSessionId = useMingle((state) => project ? state.sessionByProject[project.id] : undefined);
  const teamInfo = useMingle((state) => project ? state.teamSessionsByProject[project.id] : undefined);
  const teamStructure = useTeamStructure();
  const remoteTeamSession = teamInfo && !teamInfo.hostIsThisDevice ? teamInfo.teamSession : null;
  if (group) return <GroupConversation key={group.group.id} snapshot={group} />;
  if (project && remoteTeamSession && selectedSessionId === remoteTeamSession.sessionId) {
    return <TeamSessionView key={remoteTeamSession.sessionId} projectId={project.id} teamSession={remoteTeamSession} structure={teamStructure.snapshot} />;
  }
  return <SingleSessionPane />;
}

/** On a teammate's device, sharing consent stays reachable from every session, before any shared team session exists. */
function TeammateConsentBanner({ projectId }: { projectId: string }) {
  const structure = useTeamStructure().snapshot;
  if (structure?.projectId !== projectId || structure.host.isThisDevice) return null;
  return <TeamConsentBanner projectId={projectId} />;
}

function SingleSessionPane() {
  const project = useProject();
  const session = useActiveSession();
  const contextOpen = useMingle((state) => state.contextOpen);
  const hasSessions = useMingle((s) => s.boot?.sessions.some((x) => x.projectId === s.activeProjectId) ?? false);
  const sessionId = session?.id;
  // Token deltas are followed by the one streaming row, not here: this pane only sees which buffers exist.
  const streamIds = useSessionStreamIds(sessionId);
  const bootstrapMessages = useMingle((s) => s.boot?.messages);
  // Older history is paged on demand over the bootstrap's recent window; until some is loaded this is the bootstrap array itself.
  const { history, messages: allMessages, loadOlder } = useSessionHistory(sessionId, bootstrapMessages);
  const allRuns = useMingle((s) => s.boot?.runs);
  const allToolCalls = useMingle((s) => s.boot?.toolCalls);
  const reviewTasks = useMingle((s) => s.boot?.tasks);
  const reviewWorkflows = useMingle((s) => s.boot?.workflows);
  const deriveTranscript = useRef<ReturnType<typeof createTranscriptDeriver>>(undefined);
  deriveTranscript.current ??= createTranscriptDeriver();
  const transcript = useMemo(() => session ? deriveTranscript.current!({
    sessionId: session.id, provider: session.provider, model: session.model, running: session.status === 'running',
    messages: allMessages, runs: allRuns, toolCalls: allToolCalls, streamIds, tasks: reviewTasks, workflows: reviewWorkflows,
  }) : null, [session?.id, session?.provider, session?.model, session?.status, allMessages, allRuns, allToolCalls, streamIds, reviewTasks, reviewWorkflows]);
  const messages = transcript?.messages ?? EMPTY_MESSAGES;
  const runs = transcript?.runs ?? EMPTY_SESSION_RUNS;
  const sessionToolCalls = transcript?.toolCalls ?? EMPTY_SESSION_CALLS;
  const subagents = transcript?.subagents ?? EMPTY_SESSION_SUBAGENTS;
  // Select the stable store array, then filter: a selector that returns a new array each time re-renders forever.
  const allDelegatedSubagents = useMingle((s) => s.boot?.delegatedSubagents);
  const delegatedSubagents = useStableById(useMemo(() => (allDelegatedSubagents ?? []).filter((item) => item.parentSessionId === sessionId), [allDelegatedSubagents, sessionId]));
  const allPlans = useMingle((s) => s.boot?.plans ?? EMPTY_PLANS);
  const allQuestions = useMingle((s) => s.boot?.questions ?? EMPTY_QUESTIONS);
  const allTasks = useMingle((s) => s.boot?.tasks ?? EMPTY_TASKS);
  const allEvents = useMingle((s) => s.boot?.events ?? EMPTY_EVENTS);
  const allApprovals = useMingle((s) => s.boot?.approvals ?? EMPTY_APPROVALS);
  const pending = useStableById(useMemo(() => allApprovals.filter((a) => a.sessionId === sessionId && a.status === 'pending'), [allApprovals, sessionId]));
  const statusBarState = useMemo(() => session ? deriveStatusBarState({
    session, runs, toolCalls: sessionToolCalls, tasks: allTasks, events: allEvents, approvals: allApprovals, questions: allQuestions,
    delegatedSubagents,
  }) : null, [session, runs, sessionToolCalls, allTasks, allEvents, allApprovals, allQuestions, delegatedSubagents]);
  const plans = useStableById(useMemo(() => {
    const rows = allPlans.filter((plan) => plan.sessionId === sessionId);
    const completed = rows.filter((plan) => plan.status === 'completed').at(-1);
    return [...rows.filter((plan) => plan.status !== 'completed'), ...(completed ? [completed] : [])];
  }, [allPlans, sessionId]));
  const questions = useStableById(useMemo(() => {
    const rows = allQuestions.filter((question) => question.sessionId === sessionId);
    const pendingRows = rows.filter((question) => question.status === 'pending');
    return [...rows.filter((question) => question.status !== 'pending').slice(-2), ...pendingRows];
  }, [allQuestions, sessionId]));
  const completedRunIds = useMemo(() => new Set(runs.filter((run) => run.status === 'completed').map((run) => run.id)), [runs]);
  const hasRunningRun = useMemo(() => runs.some((run) => run.status === 'running'), [runs]);
  const hasConversation = useMemo(() => messages.some((message) => message.role === 'user' || message.role === 'assistant'), [messages]);
  const { openDialog } = useMingle.getState();
  const creatingSession = useMingle((s) => s.creatingSession);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
  const selectedSubagent = subagents.find((subagent) => subagent.id === selectedSubagentId);
  const closeSubagent = useCallback(() => setSelectedSubagentId(null), []);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const [readerNotice, setReaderNotice] = useState(false);
  const restoredSession = useRef<string | null>(null);
  const pendingReaderRestore = useRef<SavedReaderPosition | null>(null);
  const pendingReaderSave = useRef<SavedReaderPosition | null>(null);
  const userScrollDeadline = useRef(0);
  const persistTimer = useRef<number | null>(null);
  const last = messages[messages.length - 1];
  const activitySig = useMemo(() => runs.map(run => `${run.id}:${run.status}:${run.toolCount}:${run.changes?.status ?? 'unknown'}:${run.changes?.fileCount ?? ''}:${run.changes?.additions ?? ''}:${run.changes?.deletions ?? ''}`).join('|'), [runs]);
  const planningSig = useMemo(() => `${plans.map((plan) => `${plan.id}:${plan.revision}:${plan.status}`).join(',')}|${questions.map((question) => `${question.id}:${question.status}`).join(',')}`, [plans, questions]);
  // Prepended history is not new output: it must neither pin the view to the bottom nor count as growth.
  const sig = `${session?.id}|${messages.length - history.older.length}|${last?.id}|${last?.content.length ?? 0}|${pending.length}|${activitySig}|${allToolCalls?.length ?? 0}|${planningSig}`;
  /** Streamed text grows inside its own row, which asks to stay pinned to the latest output when the reader has not scrolled away. */
  const pinToBottom = useCallback(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);
  const markScrollIntent = useCallback(() => { userScrollDeadline.current = Date.now() + 1_000; pendingReaderRestore.current = null; }, []);

  /**
   * Deferred offscreen rows take their real height as they near the viewport, which grows the column after the view
   * was pinned. While pinned, follow that growth (the observer runs before the scroll event the shift causes).
   */
  const columnObserver = useRef<ResizeObserver | undefined>(undefined);
  const observeColumn = useCallback((node: HTMLDivElement | null) => {
    columnObserver.current?.disconnect();
    columnObserver.current = undefined;
    if (!node || typeof ResizeObserver === 'undefined') return;
    columnObserver.current = new ResizeObserver(() => {
      pinToBottom();
      // Rows near the viewport take their real height for a moment after history was prepended: keep the reader's row put.
      const settling = settleAnchor.current;
      const el = scroller.current;
      if (!settling || !el) return;
      if (performance.now() > settling.until) settleAnchor.current = null;
      else restoreReaderAnchor(el, settling.anchor);
    });
    columnObserver.current.observe(node);
  }, [pinToBottom]);
  const readerAnchor = useRef<ReaderAnchor | null>(null);
  const settleAnchor = useRef<{ anchor: ReaderAnchor; until: number } | null>(null);
  const stopSettling = useCallback(() => { settleAnchor.current = null; }, []);
  useEffect(() => {
    const flushReaderPosition = () => {
      const pending = pendingReaderSave.current;
      if (!pending || !session?.id) return;
      try { saveReaderPosition(session.id, pending); } catch { /* Browser storage is best effort. */ }
    };
    window.addEventListener('pagehide', flushReaderPosition);
    return () => window.removeEventListener('pagehide', flushReaderPosition);
  }, [session?.id]);
  const loadOlderMessages = useCallback(() => loadOlder({
    beforeApply: () => {
      const el = scroller.current;
      readerAnchor.current = captureReaderAnchor(el);
      // Older messages are history, not new output: keep assistive technology from reading out every prepended row.
      if (el) { el.setAttribute('aria-live', 'off'); window.setTimeout(() => el.setAttribute('aria-live', 'polite'), QUIET_LIVE_REGION_MS); }
    },
  }), [loadOlder]);

  useLayoutEffect(() => {
    const id = session?.id;
    if (!id || restoredSession.current === id) return;
    const previousId = restoredSession.current;
    if (previousId) {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
      const pending = pendingReaderSave.current;
      if (pending) try { saveReaderPosition(previousId, pending); } catch { /* Browser cache is best effort. */ }
    }
    pendingReaderSave.current = null;
    pendingReaderRestore.current = null;
    restoredSession.current = id;
    readerAnchor.current = null;
    let saved = null;
    try { saved = loadReaderPosition(id); } catch { /* A disabled browser cache simply starts at the newest turn. */ }
    const scrollerNode = scroller.current;
    if (!scrollerNode || !saved) {
      stick.current = true; setAway(false); setReaderNotice(false);
      return;
    }
    if (saved.pinned) {
      pendingReaderRestore.current = null;
      stick.current = true; setAway(false); setReaderNotice(false); pinToBottom();
      return;
    }
    stick.current = false; setAway(true);
    pendingReaderRestore.current = saved;
    const selector = saved.messageId ? `[data-message-id="${CSS.escape(saved.messageId)}"]` : saved.runId ? `[data-run-id="${CSS.escape(saved.runId)}"]` : null;
    const target = selector ? scrollerNode.querySelector<HTMLElement>(selector) : null;
    if (!target) { setReaderNotice(true); return; }
    pendingReaderRestore.current = null;
    setReaderNotice(false);
    if (saved.offset !== undefined) {
      const delta = target.getBoundingClientRect().top - scrollerNode.getBoundingClientRect().top - saved.offset;
      scrollerNode.scrollTop += delta;
      settleAnchor.current = { anchor: { node: target, top: saved.offset }, until: performance.now() + ANCHOR_SETTLE_MS };
    }
  }, [session?.id, pinToBottom]);
  useEffect(() => { setSelectedSubagentId(null); }, [session?.id]);
  useLayoutEffect(() => { if (restoredSession.current === session?.id && stick.current) pinToBottom(); }, [sig, pinToBottom, session?.id]);
  // After older messages are prepended, keep the reader on the same content they were looking at.
  useLayoutEffect(() => {
    const anchor = readerAnchor.current;
    const el = scroller.current;
    if (!el) return;
    if (anchor) {
      readerAnchor.current = null;
      restoreReaderAnchor(el, anchor);
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      settleAnchor.current = near ? null : { anchor, until: performance.now() + ANCHOR_SETTLE_MS };
      stick.current = near;
      setAway(!near);
    }
    const pending = pendingReaderRestore.current;
    if (pending && Date.now() > userScrollDeadline.current) {
      const selector = pending.messageId ? `[data-message-id="${CSS.escape(pending.messageId)}"]` : pending.runId ? `[data-run-id="${CSS.escape(pending.runId)}"]` : null;
      const target = selector ? el.querySelector<HTMLElement>(selector) : null;
      if (target) {
        if (pending.offset !== undefined) {
          el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - pending.offset;
          settleAnchor.current = { anchor: { node: target, top: pending.offset }, until: performance.now() + ANCHOR_SETTLE_MS };
        }
        pendingReaderRestore.current = null;
        setReaderNotice(false);
        stick.current = false;
        setAway(true);
      }
    }
  }, [history.older]);

  if (!project) {
    return (
      <EmptyState icon={<FolderPlus size={20} />} title="Open a project to begin" action={<Button variant="primary" onClick={() => openDialog({ kind: 'project' })}>Open project…</Button>}>
        Mingle works inside a local folder. Add one to start isolated agent sessions.
      </EmptyState>
    );
  }
  if (!session) {
    return (
      <div className="chat chat--projectonly">
        {project ? <TeammateConsentBanner projectId={project.id} /> : null}
        <EmptyState title={hasSessions ? 'Select a session' : 'No sessions yet'} action={<Button variant="primary" busy={creatingSession} disabled={creatingSession} onClick={() => void useMingle.getState().createSession()}>New session</Button>}>
          {hasSessions ? 'Choose a session from the sidebar.' : 'Start a session to work in this project.'}
        </EmptyState>
        <div className="composer-wrap"><GitBar project={project} session={null} /></div>
      </div>
    );
  }

  return (
    <div className="chat">
      {project ? <TeammateConsentBanner projectId={project.id} /> : null}
      <SubagentRail hidden={contextOpen} subagents={subagents} delegated={delegatedSubagents} provider={session.provider} onOpen={setSelectedSubagentId}
        onOpenDelegated={(item) => useMingle.getState().selectSession(item.childSessionId)}
        onCancel={(item) => void api.cancelSubagent(item.id).then(() => useMingle.getState().refreshNow()).catch((error) => useMingle.getState().toast('error', errorMessage(error)))} />
      {selectedSubagent ? <>
        <SubagentChatView key={selectedSubagent.id} subagent={selectedSubagent} provider={session.provider} calls={sessionToolCalls} onBack={closeSubagent} />
      </> : <>
      <div className="chat__history">
      <ConversationNavigation key={`${project.id}:${session.id}`} projectId={project.id} sessionId={session.id} messages={allMessages?.filter((message) => message.sessionId === session.id && message.kind !== 'subagent-result') ?? []} runs={runs} calls={sessionToolCalls} hasOlder={history.hasMore} onLoadOlder={loadOlderMessages} />
      <div
        className="chat__scroll" ref={scroller} onWheel={() => { stopSettling(); markScrollIntent(); }} onTouchStart={() => { stopSettling(); markScrollIntent(); }} onPointerDown={() => { stopSettling(); markScrollIntent(); }} onKeyDown={() => { stopSettling(); markScrollIntent(); }} role="log" aria-live="polite" aria-label={`Conversation with ${session.name}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          setAway(!near);
          if (userScrollDeadline.current > Date.now()) {
            if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
            const candidates = [...el.querySelectorAll<HTMLElement>('[data-message-id], [data-run-id]')];
            const visible = candidates.find((node) => { const rect = node.getBoundingClientRect(); return rect.bottom > el.getBoundingClientRect().top + 1 && rect.top < el.getBoundingClientRect().bottom; });
            const message = visible?.closest<HTMLElement>('[data-message-id]');
            const run = visible?.closest<HTMLElement>('[data-run-id]');
            pendingReaderSave.current = {
              pinned: near,
              ...(message?.dataset.messageId ? { messageId: message.dataset.messageId } : run?.dataset.runId ? { runId: run.dataset.runId } : {}),
              ...(visible ? { offset: visible.getBoundingClientRect().top - el.getBoundingClientRect().top } : {}),
            };
            persistTimer.current = window.setTimeout(() => {
              persistTimer.current = null;
              const pending = pendingReaderSave.current;
              if (pending) try { saveReaderPosition(session.id, pending); }
              catch { /* Scrolling remains available if browser storage is unavailable. */ }
            }, 450);
          }
        }}
      >
        <div className="chat__inner chat__inner--history" ref={observeColumn}>
          {hasConversation ? <SessionHistoryControl history={history} onLoad={loadOlderMessages} /> : null}
          {!hasConversation ? (
            <div className="chat__empty">
              <span className="chat__welcome-mark" aria-hidden="true"><MingleGlyph size={28} /></span>
              <span className="chat__eyebrow">YOUR WORKSPACE, READY</span>
              <h3>What are we building?</h3>
              <p>Work through an idea, explore your code, or make your next change with {PROVIDER_NAME[session.provider]}.</p>
              <div className="chat__welcome-hints"><span><kbd>@</kbd> Add files and context</span><span><kbd>/</kbd> Explore commands</span></div>
            </div>
          ) : null}
          <TranscriptList layout={transcript!.layout} sessionId={session.id} provider={session.provider} onOpenSubagent={setSelectedSubagentId} onGrow={pinToBottom} />
          {session.status === 'running' && !hasRunningRun ? (
            <div className="working" role="status"><span className="activity-shimmer">{PROVIDER_NAME[session.provider]} is working…</span></div>
          ) : null}
          {session.error && session.status === 'error' ? <div className="chat__error" role="alert"><strong>Session error</strong><span>{session.error}</span></div> : null}
          {pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}
          {plans.map((plan) => <SessionPlanCard key={plan.id} plan={plan} reviewReady={completedRunIds.has(plan.runId)} />)}
          {questions.filter((question) => question.status !== 'pending').map((question) => <UserQuestionCard key={question.id} question={question} />)}
        </div>
      </div>
      {readerNotice ? <p className="chat__reader-notice" role="status">The saved reading position is outside the loaded history.{history.hasMore ? <> <button type="button" onClick={loadOlderMessages}>Load older messages</button> to look for it.</> : ' It is not available in this session history.'}</p> : null}
      {away ? (
        <button type="button" className="jump" onClick={() => { stopSettling(); stick.current = true; pinToBottom(); }}>
          <ArrowDown size={13} /> Latest
        </button>
      ) : null}
      </div>
      <Composer key={session.id} session={session} progressState={statusBarState}
        helperCount={subagents.filter((item) => item.status === 'running').length + delegatedSubagents.filter((item) => item.status === 'running').length} />
      </>}
    </div>
  );
}
