import { useCallback, useEffect, useMemo, useState } from 'react';
import { Crown, ChevronDown, ChevronUp, Circle, Loader2, RefreshCw } from 'lucide-react';
import type { TeamAgentState, TeamStructureMember, TeamStructureSnapshot } from '@mingle/contracts';
import { useMingle } from '../../../store/store';
import { errorMessage } from '../../../lib/api';
import { AgentIdentity } from '../../group/AgentIdentity';
import { AgentActivityDrawer, type ActivityAgent } from './AgentActivityDrawer';
import { teamActivityApi } from './api';
import './activity.css';

const STATE_LABEL: Record<TeamAgentState, string> = {
  idle: 'Idle', queued: 'Queued', working: 'Working', 'awaiting-approval': 'Awaiting approval',
  'quota-exhausted': 'Quota exhausted', offline: 'Offline', paused: 'Paused', failed: 'Failed',
};

function deviceLabel(member: TeamStructureMember): string {
  if (member.local) return 'This device';
  return `On ${member.ownerDisplayName}’s ${member.deviceName}`;
}

function toActivityAgent(member: TeamStructureMember): ActivityAgent {
  return {
    agentId: member.agentId, handle: member.handle, name: member.name, provider: member.provider, model: member.model,
    local: member.local, ownerDisplayName: member.ownerDisplayName, deviceName: member.deviceName,
    role: member.role, state: member.state, currentTask: member.currentTask, sessionId: member.sessionId,
    failureMessage: member.failure?.message ?? null,
  };
}

function summaryFor(members: TeamStructureMember[]): string {
  const count = (state: TeamAgentState) => members.filter((member) => member.state === state).length;
  const parts: string[] = [];
  for (const [state, label] of [['working', 'working'], ['queued', 'queued'], ['awaiting-approval', 'awaiting approval'], ['offline', 'offline'], ['failed', 'failed'], ['paused', 'paused']] as const) {
    const total = count(state);
    if (total) parts.push(`${total} ${label}`);
  }
  if (!parts.length) return members.length ? `${members.length} idle` : 'No agents';
  return parts.join(' · ');
}

export function TeamPresenceBubble({ projectId }: { projectId: string }) {
  const connection = useMingle((state) => state.connection);
  const [snapshot, setSnapshot] = useState<TeamStructureSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<ActivityAgent | null>(null);
  const members = snapshot?.members ?? [];

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (connection !== 'online') { setLoading(false); return; }
    try {
      const latest = await teamActivityApi.structure(projectId, signal);
      setSnapshot(latest);
      setError(null);
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [connection, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null); setLoading(true); setError(null);
    void refresh(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(controller.signal);
    }, 10_000);
    const stateChange = () => { if (document.visibilityState === 'visible') void refresh(controller.signal); };
    const visibility = () => { if (document.visibilityState === 'visible') void refresh(controller.signal); };
    window.addEventListener('mingle:state-changed', stateChange);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      controller.abort(); window.clearInterval(timer);
      window.removeEventListener('mingle:state-changed', stateChange);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [projectId, refresh]);

  const summary = useMemo(() => summaryFor(members), [members]);
  const openAgent = (member: TeamStructureMember) => setSelected(toActivityAgent(member));

  return <>
    <aside className={`team-presence${expanded ? ' is-expanded' : ' is-collapsed'}`} aria-label="Team agent presence">
      <header className="team-presence__head">
        <button type="button" className="team-presence__toggle" aria-expanded={expanded} aria-label={expanded ? 'Collapse team presence' : 'Expand team presence'} onClick={() => setExpanded((value) => !value)}>
          <span className="team-presence__title"><Circle size={8} fill="currentColor" aria-hidden="true" />Team agents</span>
          <span className="team-presence__summary">{loading && !snapshot ? 'Loading…' : connection !== 'online' && !snapshot ? 'Offline' : summary}</span>
          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
        </button>
      </header>
      {expanded ? <div className="team-presence__content">
        {connection !== 'online' ? <p className="team-presence__notice" role="status">Offline · team presence is last known.</p> : null}
        {error ? <p className="team-presence__error" role="alert"><span>{error}</span><button type="button" aria-label="Retry team presence" onClick={() => { setLoading(true); void refresh(); }}><RefreshCw size={12} /></button></p> : null}
        {loading && !snapshot ? <div className="team-presence__empty"><Loader2 size={15} className="spin" />Loading team agents…</div> : null}
        {snapshot && !members.length ? <div className="team-presence__empty">No agents are currently listed for this team.</div> : null}
        <ul className="team-presence__list" aria-label="Team agents">
          {members.map((member) => <li key={member.agentId} className={`team-presence__row is-${member.state}`}>
            <button type="button" className="team-presence__agent" onClick={() => openAgent(member)} aria-label={`Open @${member.handle} conversation, ${STATE_LABEL[member.state]}, ${deviceLabel(member)}`}>
              <span className="team-presence__agent-main">
                {member.role === 'orchestrator' ? <Crown size={13} className="team-presence__crown" aria-label="Orchestrator" /> : <span className="team-presence__crown-space" aria-hidden="true" />}
                <AgentIdentity handle={member.handle} identityKey={member.agentId} provider={member.provider} />
                <span className="team-presence__state"><i aria-hidden="true" />{STATE_LABEL[member.state]}</span>
              </span>
              <span className="team-presence__meta"><span><strong className="team-presence__role">{member.role === 'orchestrator' ? 'Orchestrator' : member.role === 'worker' ? 'Worker' : 'Idle bench'}</strong> · {deviceLabel(member)}</span>{member.currentTask ? <span className="team-presence__task">{member.currentTask}</span> : null}</span>
              {member.failure ? <span className="team-presence__failure">{member.failure.message}</span> : null}
            </button>
          </li>)}
        </ul>
      </div> : null}
    </aside>
    {selected ? <AgentActivityDrawer key={`${selected.agentId}:${selected.sessionId ?? ''}`} projectId={projectId} agent={selected} onClose={() => setSelected(null)} /> : null}
  </>;
}
