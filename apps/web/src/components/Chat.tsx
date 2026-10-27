import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, FolderPlus } from 'lucide-react';
import type { Session, SessionPlan, SessionRun, ToolCall, UserQuestion } from '@mingle/contracts';
import { useMingle, useProject, useActiveSession, useActiveGroup } from '../store/store';
import type { DisplayMessage } from '../lib/conversation';
import { Button, EmptyState, MingleGlyph, PROVIDER_NAME } from './ui';
import { ApprovalCard, InternalDeliveryDisclosure, LegacyToolGroup, MessageRow, SessionPlanCard, UserQuestionCard } from './ConversationParts';
import { GroupConversation } from './group/GroupConversation';
import { Composer } from './Composer';
import { RunActivity } from './RunActivity';
import { RunChanges } from './RunChanges';
import { GitBar } from './git/GitBar';
import { appendContextReference } from './MessageContextControls';
import { TeamSessionView } from './team-chat/TeamSessionView';
import { useTeamStructure } from '../lib/team-structure-context';
import { TeamConsentBanner } from './team-orchestration/settings/TeamConsentBanner';

const EMPTY_RUNS: SessionRun[] = [];
const EMPTY_TOOL_CALLS: ToolCall[] = [];
const EMPTY_PLANS: SessionPlan[] = [];
const EMPTY_QUESTIONS: UserQuestion[] = [];

function useSessionMessages(session: Session | undefined): DisplayMessage[] {
  const all = useMingle((s) => s.boot?.messages);
  const streams = useMingle((s) => s.streams);
  return useMemo(() => {
    if (!session || !all) return [];
    const out: DisplayMessage[] = [];
    const seen = new Set<string>();
    for (const m of all) {
      if (m.sessionId !== session.id) continue;
      seen.add(m.id);
      const st = streams[m.id];
      const streamed = st ? st.base + st.text : '';
      const content = streamed.length > m.content.length ? streamed : m.content;
      out.push({ id: m.id, sessionId: m.sessionId, role: m.role, content, createdAt: m.createdAt, kind: m.kind, runId: m.runId, live: (Boolean(st) || m.kind === 'streaming') && session.status === 'running', attachments: m.attachments, contextRefs: m.contextRefs });
    }
    for (const [id, st] of Object.entries(streams)) {
      if (st.sessionId !== session.id || seen.has(id)) continue;
      out.push({ id, sessionId: session.id, role: 'assistant', content: st.base + st.text, createdAt: '', live: session.status === 'running' });
    }
    return out;
  }, [all, streams, session]);
}

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
  const hasSessions = useMingle((s) => s.boot?.sessions.some((x) => x.projectId === s.activeProjectId) ?? false);
  const messages = useSessionMessages(session);
  const allRuns = useMingle((s) => s.boot?.runs ?? EMPTY_RUNS);
  const runs = useMemo(() => allRuns.filter(run => run.sessionId === session?.id), [allRuns, session?.id]);
  const allToolCalls = useMingle((s) => s.boot?.toolCalls ?? EMPTY_TOOL_CALLS);
  const allPlans = useMingle((s) => s.boot?.plans ?? EMPTY_PLANS);
  const allQuestions = useMingle((s) => s.boot?.questions ?? EMPTY_QUESTIONS);
  const toolCallsByRun = useMemo(() => {
    const grouped = new Map<string, ToolCall[]>();
    for (const call of allToolCalls) {
      if (call.sessionId !== session?.id) continue;
      const rows = grouped.get(call.runId) ?? [];
      rows.push(call);
      grouped.set(call.runId, rows);
    }
    return grouped;
  }, [allToolCalls, session?.id]);
  const runsByUserMessage = useMemo(() => {
    const grouped = new Map<string, SessionRun[]>();
    for (const run of runs) {
      const rows = grouped.get(run.userMessageId) ?? [];
      rows.push(run);
      grouped.set(run.userMessageId, rows);
    }
    return grouped;
  }, [runs]);
  const messageIds = useMemo(() => new Set(messages.map(message => message.id)), [messages]);
  const unplacedRuns = useMemo(() => runs.filter(run => !messageIds.has(run.userMessageId)).sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [runs, messageIds]);
  const changesAfterMessage = useMemo(() => {
    const placements = new Map<number, SessionRun[]>();
    for (const run of runs) {
      if (!messageIds.has(run.userMessageId)) continue;
      const assistants = messages.map((message, index) => ({ message, index })).filter(row => row.message.role === 'assistant' && row.message.runId === run.id);
      let index = assistants.at(-1)?.index;
      if (index === undefined) {
        const fallback = messages.map((message, candidate) => ({ message, candidate })).filter(row => row.message.role !== 'tool' && row.message.runId === run.id).at(-1);
        index = fallback?.candidate ?? messages.findIndex(message => message.id === run.userMessageId);
      }
      if (index === undefined || index < 0) continue;
      const list = placements.get(index) ?? []; list.push(run); placements.set(index, list);
    }
    return placements;
  }, [runs, messages, messageIds]);
  const approvals = useMingle((s) => s.boot?.approvals);
  const pending = useMemo(() => (approvals ?? []).filter((a) => a.sessionId === session?.id && a.status === 'pending'), [approvals, session?.id]);
  const plans = useMemo(() => {
    const rows = allPlans.filter((plan) => plan.sessionId === session?.id);
    const completed = rows.filter((plan) => plan.status === 'completed').at(-1);
    return [...rows.filter((plan) => plan.status !== 'completed'), ...(completed ? [completed] : [])];
  }, [allPlans, session?.id]);
  const questions = useMemo(() => {
    const rows = allQuestions.filter((question) => question.sessionId === session?.id);
    const pendingRows = rows.filter((question) => question.status === 'pending');
    return [...rows.filter((question) => question.status !== 'pending').slice(-2), ...pendingRows];
  }, [allQuestions, session?.id]);
  const { openDialog } = useMingle.getState();
  const creatingSession = useMingle((s) => s.creatingSession);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const last = messages[messages.length - 1];
  const activitySig = runs.map(run => `${run.id}:${run.status}:${run.toolCount}:${run.changes?.status ?? 'unknown'}:${run.changes?.fileCount ?? ''}:${run.changes?.additions ?? ''}:${run.changes?.deletions ?? ''}`).join('|');
  const planningSig = `${plans.map((plan) => `${plan.id}:${plan.revision}:${plan.status}`).join(',')}|${questions.map((question) => `${question.id}:${question.status}`).join(',')}`;
  const sig = `${session?.id}|${messages.length}|${last?.content.length ?? 0}|${pending.length}|${activitySig}|${allToolCalls.length}|${planningSig}`;

  useEffect(() => { stick.current = true; setAway(false); }, [session?.id]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [sig]);

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
      <div className="chat__history">
      <div
        className="chat__scroll" ref={scroller} role="log" aria-live="polite" aria-label={`Conversation with ${session.name}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          setAway(!near);
        }}
      >
        <div className="chat__inner">
          {!messages.some(message => message.role === 'user' || message.role === 'assistant') ? (
            <div className="chat__empty">
              <span className="chat__welcome-mark" aria-hidden="true"><MingleGlyph size={28} /></span>
              <span className="chat__eyebrow">YOUR WORKSPACE, READY</span>
              <h3>What are we building?</h3>
              <p>Work through an idea, explore your code, or make your next change with {PROVIDER_NAME[session.provider]}.</p>
              <div className="chat__welcome-hints"><span><kbd>@</kbd> Add files and context</span><span><kbd>/</kbd> Explore commands</span></div>
            </div>
          ) : null}
          {messages.map((m, index) => {
            if (m.role === 'tool') {
              const group = [m];
              let next = index + 1;
              while (next < messages.length && messages[next]?.role === 'tool') group.push(messages[next++]!);
              if (index > 0 && messages[index - 1]?.role === 'tool') return null;
              return <LegacyToolGroup key={m.id} messages={group} />;
            }
            if (m.role === 'user' && (m.kind === 'group-delivery' || m.kind === 'team-delivery')) return <Fragment key={m.id}>
              <InternalDeliveryDisclosure message={m} />
              {(runsByUserMessage.get(m.id) ?? []).map(run => <RunActivity key={run.id} run={run} initialCalls={toolCallsByRun.get(run.id) ?? EMPTY_TOOL_CALLS} />)}
            </Fragment>;
            return (
              <Fragment key={m.id}>
                <MessageRow m={m} provider={session.provider} onAskAboutThis={(quote) => appendContextReference(session.id, quote)} />
                {m.role === 'user' ? (runsByUserMessage.get(m.id) ?? []).map(run => <RunActivity key={run.id} run={run} initialCalls={toolCallsByRun.get(run.id) ?? EMPTY_TOOL_CALLS} />) : null}
                {(changesAfterMessage.get(index) ?? []).filter(run => run.status !== 'running').map(run => <RunChanges key={run.id} runId={run.id} summary={run.changes} />)}
              </Fragment>
            );
          })}
           {unplacedRuns.map(run => <Fragment key={run.id}><RunActivity run={run} initialCalls={toolCallsByRun.get(run.id) ?? EMPTY_TOOL_CALLS} />{run.status !== 'running' ? <RunChanges runId={run.id} summary={run.changes} /> : null}</Fragment>)}
          {session.status === 'running' && !runs.some(run => run.status === 'running') ? (
            <div className="working" role="status"><span className="activity-shimmer">{PROVIDER_NAME[session.provider]} is working…</span></div>
          ) : null}
          {session.error && session.status === 'error' ? <div className="chat__error" role="alert"><strong>Session error</strong><span>{session.error}</span></div> : null}
          {pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}
          {plans.map((plan) => <SessionPlanCard key={plan.id} plan={plan} reviewReady={runs.some((run) => run.id === plan.runId && run.status === 'completed')} />)}
          {questions.map((question) => <UserQuestionCard key={question.id} question={question} />)}
        </div>
      </div>
      {away ? (
        <button type="button" className="jump" onClick={() => { const el = scroller.current; if (el) { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); } }}>
          <ArrowDown size={13} /> Latest
        </button>
      ) : null}
      </div>
      <Composer key={session.id} session={session} />
    </div>
  );
}
