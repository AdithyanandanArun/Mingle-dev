import { useMemo, useState, type ReactNode } from 'react';
import { Activity as ActivityIcon, ChevronRight } from 'lucide-react';
import type { SessionRun, Task, ToolCall } from '@mingle/contracts';
import { useMingle, useProject } from '../store/store';
import { useProjectContext } from '../store/projectContext';
import { clockTime, cx, dayLabel, relativeTime, useNow } from '../lib/format';
import { formatElapsed } from '../lib/activity';
import { Badge, EmptyState, PROVIDER_NAME } from '../components/ui';
import { SelectMenu } from '../components/SelectMenu';
import { ContextStrip } from '../components/automation/ContextSummary';
import { SOURCE_LABEL, sourceLocation } from '../components/automation/TaskSource';
import { shortSha } from '../components/git/gitUtil';
import { AgentIdentity } from '../components/group/AgentIdentity';
import { activityEventInScope, activityMatchesSearch } from '../lib/activityView';

type Tone = 'ok' | 'warn' | 'err' | 'info' | 'accent' | 'neutral';
const toneFor = (type: string): Tone => {
  if (/error|fail|denied/.test(type)) return 'err';
  if (/approval|waiting|interrupt/.test(type)) return 'warn';
  if (/complete|done|approved|finished/.test(type)) return 'ok';
  if (/handoff/.test(type)) return 'accent';
  if (/task|session|project/.test(type)) return 'info';
  return 'neutral';
};

/** One timeline entry, whether it came from a durable workspace event or a recorded run/tool lifecycle. */
interface Entry {
  key: string; at: number; order: number; type: string; tone: Tone; summary: string; createdAt: string;
  sessionId: string | null; origin: string; detail?: ReactNode; payload?: Record<string, unknown>; source?: Task['source'];
  identity?: { handle: string; key: string; provider?: import('@mingle/contracts').Provider };
}

const RUN_TONE: Record<SessionRun['status'], Tone> = { running: 'info', completed: 'ok', failed: 'err', interrupted: 'warn' };
const TOOL_TONE: Record<ToolCall['status'], Tone> = { running: 'info', completed: 'neutral', failed: 'err', interrupted: 'warn' };
const stamp = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

function EntryRow({ entry, sessionName, now }: { entry: Entry; sessionName?: string; now: number }) {
  const [open, setOpen] = useState(false);
  const hasPayload = Boolean(entry.payload && Object.keys(entry.payload).length > 0);
  const expandable = hasPayload || Boolean(entry.detail);
  const where = entry.source ? sourceLocation(entry.source) : null;
  return (
    <li className="evt">
      <span className={cx('evt__dot', `evt__dot--${entry.tone}`)} aria-hidden="true" />
      <div className="evt__main">
        <div className="evt__line">
          <span className="evt__summary">{entry.summary}</span>
          {expandable ? (
            <button type="button" className="evt__toggle" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen((o) => !o)}>
              <ChevronRight size={13} className={cx('trow__chev', open && 'is-open')} />
            </button>
          ) : null}
        </div>
        <div className="evt__meta">
          <Badge tone={entry.tone}>{entry.type}</Badge>
          {entry.identity ? <AgentIdentity handle={entry.identity.handle} identityKey={entry.identity.key} provider={entry.identity.provider} /> : null}
          {entry.source ? <Badge tone="neutral" title={where ?? entry.source.key}>{SOURCE_LABEL[entry.source.kind]}{where ? ` · ${where}` : ''}</Badge> : null}
          {sessionName ? <button type="button" className="chip chip--btn" onClick={() => entry.sessionId && useMingle.getState().selectSession(entry.sessionId)}>{sessionName}</button> : null}
          <span title={new Date(entry.createdAt).toLocaleString()}>{clockTime(entry.createdAt)} · {relativeTime(entry.createdAt, now)}</span>
          <span className="evt__id">{entry.origin}</span>
        </div>
        {open ? <>{entry.detail}{hasPayload ? <pre className="evt__payload">{JSON.stringify(entry.payload, null, 2)}</pre> : null}</> : null}
      </div>
    </li>
  );
}

/** Real repository facts from the project scan; nothing is inferred from sessions. */
function RepoContext({ projectId }: { projectId: string }) {
  const { entry } = useProjectContext(projectId);
  const context = entry.context;
  const now = useNow();
  return (
    <section className="actrepo" aria-label="Repository context">
      <ContextStrip projectId={projectId} />
      {context?.isRepo ? (
        <div className="actrepo__body">
          <p className="small"><strong>{context.branch ?? 'Detached HEAD'}</strong>{context.head ? <> · <code>{shortSha(context.head)}</code></> : ' · no commits yet'} · {context.changedPaths.length === 0 ? 'no changed paths' : `${context.changedPaths.length} changed path${context.changedPaths.length === 1 ? '' : 's'}`}</p>
          {context.recentCommits.length > 0 ? (
            <ul className="ctxcard__commits">{context.recentCommits.slice(0, 5).map((c) => <li key={c.sha}><code>{shortSha(c.sha)}</code><span title={c.title}>{c.title}</span><time dateTime={c.authoredAt}>{relativeTime(c.authoredAt, now)}</time></li>)}</ul>
          ) : <p className="muted small">No commits in this repository yet.</p>}
        </div>
      ) : null}
    </section>
  );
}

export function ActivityView() {
  const project = useProject();
  const events = useMingle((s) => s.boot?.events);
  const sessions = useMingle((s) => s.boot?.sessions);
  const runs = useMingle((s) => s.boot?.runs);
  const toolCalls = useMingle((s) => s.boot?.toolCalls);
  const tasks = useMingle((s) => s.boot?.tasks);
  const groupSnapshots = useMingle((s) => s.boot?.groups);
  const [allProjects, setAllProjects] = useState(false);
  const [type, setType] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [search, setSearch] = useState('');
  const now = useNow();

  const sessionName = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s.name])), [sessions]);
  const groupIdentityBySession = useMemo(() => {
    const identities = new Map<string, { handle: string; key: string; provider?: import('@mingle/contracts').Provider }>();
    for (const group of groupSnapshots ?? []) for (const member of group.members) {
      const session = sessions?.find((item) => item.id === member.sessionId);
      identities.set(member.sessionId, { handle: member.handle, key: member.sessionId, provider: session?.provider });
    }
    return identities;
  }, [groupSnapshots, sessions]);
  const scopedSessions = useMemo(() => (sessions ?? []).filter((s) => allProjects || s.projectId === project?.id), [sessions, allProjects, project?.id]);
  const taskById = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);
  // Bootstrap tool records are bounded across all sessions, so they are only listed for one session at a time.
  const toolSessionId = sessionId || (scopedSessions.length === 1 ? scopedSessions[0]!.id : '');

  const entries = useMemo(() => {
    const out: Entry[] = [];
    const sessionIds = new Set(scopedSessions.map((s) => s.id));
    const covered = { start: new Set<string>(), finish: new Set<string>() };
    for (const e of events ?? []) {
      if (!activityEventInScope(e.projectId, project?.id, allProjects)) continue;
      const taskId = typeof e.payload.taskId === 'string' ? e.payload.taskId : undefined;
      const runId = typeof e.payload.runId === 'string' ? e.payload.runId : undefined;
      if (runId && /run|turn/i.test(e.type)) (/start|begin/i.test(e.type) ? covered.start : covered.finish).add(runId);
      const identity = e.sessionId ? groupIdentityBySession.get(e.sessionId) : undefined;
      out.push({ key: `e:${e.id}`, at: stamp(e.createdAt), order: e.id, type: e.type, tone: toneFor(e.type), summary: e.summary, createdAt: e.createdAt, sessionId: e.sessionId, origin: `event #${e.id}`, payload: e.payload, source: taskId ? taskById.get(taskId)?.source : undefined, identity });
    }
    for (const run of runs ?? []) {
      if (!sessionIds.has(run.sessionId)) continue;
      const name = sessionName.get(run.sessionId) ?? 'Session';
      if (!covered.start.has(run.id)) out.push({ key: `r:${run.id}:start`, at: stamp(run.startedAt), order: 0, type: 'run.started', tone: 'info', summary: `${name} started a run with ${PROVIDER_NAME[run.provider]} · ${run.model}`, createdAt: run.startedAt, sessionId: run.sessionId, origin: 'run record' });
      if (run.status !== 'running' && run.finishedAt && !covered.finish.has(run.id)) {
        const files = run.changes?.status === 'available' ? ` · ${run.changes.fileCount} file${run.changes.fileCount === 1 ? '' : 's'} changed` : '';
        out.push({
          key: `r:${run.id}:end`, at: stamp(run.finishedAt), order: 1, type: `run.${run.status}`, tone: RUN_TONE[run.status], createdAt: run.finishedAt, sessionId: run.sessionId, origin: 'run record', identity: groupIdentityBySession.get(run.sessionId),
          summary: `${name} run ${run.status}${run.durationMs !== null ? ` after ${formatElapsed(run.durationMs)}` : ''} · ${run.toolCount} tool call${run.toolCount === 1 ? '' : 's'}${files}`,
        });
      }
    }
    if (toolSessionId && sessionIds.has(toolSessionId)) {
      for (const call of toolCalls ?? []) {
        if (call.sessionId !== toolSessionId) continue;
        out.push({
          key: `t:${call.id}`, at: stamp(call.startedAt), order: 2, type: 'tool', tone: TOOL_TONE[call.status], createdAt: call.startedAt, sessionId: call.sessionId, origin: 'tool record', identity: groupIdentityBySession.get(call.sessionId),
          summary: `${call.summary || call.name} · ${call.category} tool ${call.status}`,
          detail: (
            <dl className="evt__facts">
              <dt>Tool</dt><dd>{call.name}</dd>
              {call.command ? <><dt>Command</dt><dd><code>{call.command}</code></dd></> : null}
              {call.cwd ? <><dt>Directory</dt><dd><code>{call.cwd}</code></dd></> : null}
              {call.exitCode !== null ? <><dt>Exit code</dt><dd>{call.exitCode}</dd></> : null}
              {call.durationMs !== null ? <><dt>Duration</dt><dd>{formatElapsed(call.durationMs)}</dd></> : null}
              <dt>Provider ID</dt><dd><code>{call.providerId}</code>{call.parentProviderId ? <> · child of <code>{call.parentProviderId}</code></> : null}</dd>
            </dl>
          ),
        });
      }
    }
    return out;
  }, [events, runs, toolCalls, scopedSessions, toolSessionId, allProjects, project?.id, sessionName, taskById, groupIdentityBySession]);

  const types = useMemo(() => Array.from(new Set(entries.map((e) => e.type))).sort(), [entries]);
  const filtered = useMemo(
    () => entries.filter((e) => (!type || e.type === type) && (!sessionId || e.sessionId === sessionId) && activityMatchesSearch(search, e.summary, e.type, e.origin, e.sessionId)).sort((a, b) => b.at - a.at || b.order - a.order).slice(0, 500),
    [entries, type, sessionId, search],
  );
  const groups = useMemo(() => {
    const out: { day: string; items: Entry[] }[] = [];
    for (const e of filtered) {
      const day = dayLabel(e.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [filtered]);

  return (
    <div className="activity">
      <div className="viewbar">
        <div>
          <h1>Activity</h1>
          <p className="muted small">Workspace events, run records and provider-reported tool calls, as recorded by the local server. Nothing here is simulated.</p>
        </div>
        <span className="spacer" />
        <label className="sr-only" htmlFor="ev-type">Event type</label>
        <label className="sr-only" htmlFor="ev-search">Search activity</label>
        <input id="ev-search" className="activity__search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search activity…" />
        <SelectMenu id="ev-type" label="Event type" value={type} onChange={setType} options={[{ value: '', label: 'All types' }, ...types.map((value) => ({ value, label: value }))]} />
        <label className="sr-only" htmlFor="ev-session">Session</label>
        <SelectMenu id="ev-session" label="Session" value={sessionId} onChange={setSessionId} options={[{ value: '', label: 'All sessions' }, ...scopedSessions.map((s) => ({ value: s.id, label: s.name }))]} />
        <label className="check check--inline"><input type="checkbox" checked={allProjects} onChange={(e) => setAllProjects(e.target.checked)} /> All projects</label>
      </div>
      {project && !allProjects ? <RepoContext projectId={project.id} /> : null}
      <p className="activity__note muted small">
        {toolSessionId ? `Tool calls for ${sessionName.get(toolSessionId) ?? 'this session'} come from the recent records loaded with the workspace, which are bounded.` : 'Tool calls are listed when a single session is selected, because the loaded tool records are bounded.'}
      </p>
      <div className="activity__scroll">
        {groups.length === 0 ? (
          <EmptyState icon={<ActivityIcon size={20} />} title={entries.length === 0 ? 'No events yet' : 'No events match these filters'}>
            {entries.length === 0 ? 'Project, session, task, run and approval events will appear here as they happen.' : 'Clear a filter to see more.'}
          </EmptyState>
        ) : (
          groups.map((g) => (
            <section key={g.day} className="egroup" aria-label={g.day}>
              <h2>{g.day}</h2>
              <ol className="evts">{g.items.map((e) => <EntryRow key={e.key} entry={e} now={now} sessionName={e.sessionId ? sessionName.get(e.sessionId) : undefined} />)}</ol>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
