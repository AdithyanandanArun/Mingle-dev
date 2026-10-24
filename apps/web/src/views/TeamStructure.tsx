import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  applyNodeChanges, Background, BackgroundVariant, Controls, Handle, Position, ReactFlow,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Armchair, ArrowDown, ArrowUp, Check, CircleAlert, Crown, GitFork, MoreHorizontal, Network, RefreshCw, ShieldCheck, Trash2, Wifi, WifiOff, X,
} from 'lucide-react';
import type { TeamStructureChange, TeamStructureMember, TeamStructureSnapshot } from '@mingle/contracts';
import { useMingle, useProject } from '../store/store';
import { Button, EmptyState, InlineError, Modal, ProviderMark, Spinner } from '../components/ui';
import { cx } from '../lib/format';
import { TeamStructureApiError, teamStructureApi } from './team-structure/api';
import { buildTeamStructureGraph, TEAM_NODE_HEIGHT, TEAM_NODE_WIDTH, type TeamFlowNode, type TeamNodeData } from './team-structure/layout';
import '../styles/team-structure.css';

type RoleChange = 'worker' | 'idle';
interface PendingPromotion { member: TeamStructureMember; previousRole: RoleChange }

const STATE_LABEL: Record<TeamStructureMember['state'], string> = {
  idle: 'Idle', queued: 'Queued', working: 'Working', 'awaiting-approval': 'Awaiting approval',
  'quota-exhausted': 'Quota exhausted', offline: 'Offline', paused: 'Paused', failed: 'Failed',
};
const CONSENT_LABEL: Record<TeamStructureMember['consent'], string> = {
  granted: 'Consent granted', 'needs-reconsent': 'Re-consent needed', paused: 'Consent paused', revoked: 'Consent revoked',
};
const REASON_LABEL: Record<TeamStructureSnapshot['leaderHistory'][number]['reason'], string> = {
  manual: 'Manual handover', 'fallback-quota': 'Quota fallback', 'fallback-offline': 'Offline fallback', restored: 'Leader restored', removed: 'Leader removed',
};

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

function TeamLane({ data }: { data: TeamNodeData }) {
  return (
    <div className={cx('team-lane', `team-lane--${data.lane}`)} aria-hidden="true">
      <div className="team-lane__head"><strong>{data.title}</strong><span>{data.description}</span></div>
      {data.lane === 'workers' ? <div className="team-lane__drop"><GitFork size={13} /> Drop agents here to assign them as workers</div> : <div className="team-lane__drop"><Armchair size={13} /> Drop an agent here to move it to idle</div>}
    </div>
  );
}

function MemberCard({ data, selected = false }: { data: TeamNodeData; selected?: boolean }) {
  const member = data.member;
  const [menuOpen, setMenuOpen] = useState(false);
  if (!member) return null;
  const fallbackRank = member.fallbackRank;
  const currentRoleLabel = member.role === 'orchestrator'
    ? data.needsLeader ? 'Previous leader · unavailable' : 'Orchestrator'
    : member.role === 'worker' ? 'Worker' : 'Idle';

  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen((open) => !open);
    }
  };

  return (
    <div
      className={cx('team-card', selected && 'is-selected', `team-card--${member.state}`, member.role === 'orchestrator' && (data.needsLeader ? 'team-card--former-leader' : 'team-card--leader'))}
      role="group" tabIndex={0} aria-label={`${member.handle}, ${currentRoleLabel}, ${STATE_LABEL[member.state]}`}
      onContextMenu={data.canEdit ? (event) => { event.preventDefault(); setMenuOpen((open) => !open); } : undefined} onKeyDown={data.canEdit ? menuKeyDown : undefined}
    >
      <Handle type="target" position={Position.Top} id="in" />
      <div className="team-card__top">
        <div className="team-card__identity">
          <span className="team-card__avatar" aria-hidden="true">{initials(member.ownerDisplayName)}</span>
          <span className="team-card__who"><strong>@{member.handle}</strong><span title={member.name}>{member.name}</span></span>
        </div>
        <div className="team-card__badges">
          {fallbackRank ? <span className="team-rank" title={`Fallback leader number ${fallbackRank}`}>#{fallbackRank}</span> : null}
          {member.role === 'orchestrator' ? <Crown size={14} className="team-card__crown" aria-label="Orchestrator" /> : null}
          {data.canEdit ? <button type="button" className="nodrag team-card__menu-button" aria-label={`Actions for @${member.handle}`} aria-expanded={menuOpen} onClick={(event) => { event.stopPropagation(); setMenuOpen((open) => !open); }}><MoreHorizontal size={16} /></button> : null}
        </div>
      </div>
      <div className="team-card__provider"><ProviderMark provider={member.provider} size={14} /><span>{member.model}</span>{member.effort ? <span className="team-card__effort">{member.effort}</span> : null}</div>
      <div className="team-card__owner"><span>{member.ownerDisplayName}</span><span className="team-card__dot" aria-hidden="true">·</span><span>{member.local ? 'this device' : member.deviceName}</span></div>
      <div className="team-card__status-row">
        <span className={cx('team-state', `team-state--${member.state}`)}><i aria-hidden="true" />{STATE_LABEL[member.state]}</span>
        <span className="team-card__role">{currentRoleLabel}</span>
      </div>
      {member.currentTask ? <p className="team-card__task" title={member.currentTask}>{member.currentTask}</p> : null}
      {member.consent !== 'granted' ? <span className={cx('team-consent', `team-consent--${member.consent}`)}><ShieldCheck size={11} />{CONSENT_LABEL[member.consent]}</span> : null}
      {menuOpen && data.canEdit ? <div className="nodrag team-card__menu" role="group" aria-label={`Actions for @${member.handle}`}>
        {member.role !== 'orchestrator' ? <button type="button" onClick={() => { setMenuOpen(false); data.onPromote?.(member); }}><Crown size={13} /> Promote to leader</button> : null}
        {member.role !== 'worker' && (member.role !== 'orchestrator' || data.needsLeader) ? <button type="button" onClick={() => { setMenuOpen(false); data.onRoleChange?.(member, 'worker'); }}><GitFork size={13} /> Move to workers</button> : null}
        {member.role !== 'idle' && (member.role !== 'orchestrator' || data.needsLeader) ? <button type="button" onClick={() => { setMenuOpen(false); data.onRoleChange?.(member, 'idle'); }}><Armchair size={13} /> Move to idle</button> : null}
        <div className="team-card__menu-label">Set fallback rank</div>
        {[1, 2, 3, 4].map((rank) => <button key={rank} type="button" disabled={member.role === 'orchestrator' || (fallbackRank === rank && data.fallbackIds?.[rank - 1] === member.agentId)} onClick={() => { setMenuOpen(false); data.onFallback?.(member, rank); }}><span className="team-card__menu-rank">#{rank}</span> Set as fallback #{rank}</button>)}
        <button type="button" className="is-danger" onClick={() => { setMenuOpen(false); data.onRemove?.(member); }}><Trash2 size={13} /> Remove from team…</button>
      </div> : null}
      {member.role === 'orchestrator' && !data.needsLeader ? <Handle type="source" position={Position.Bottom} id="out" /> : null}
    </div>
  );
}

function LeaderSlot({ data }: { data: TeamNodeData }) {
  const member = data.member;
  if (member) return <MemberCard data={{ ...data, member }} />;
  return (
    <div className={cx('team-leader-empty', data.needsLeader && 'is-needed')}>
      <Handle type="target" position={Position.Top} id="leader-target" />
      <Crown size={18} aria-hidden="true" />
      <strong>{data.needsLeader ? 'Leader unavailable' : 'No leader assigned'}</strong>
      <span>{data.needsLeader ? 'Drag any available agent here to resume the team' : 'Promote an agent to coordinate this team'}</span>
      <Handle type="target" position={Position.Bottom} id="in" />
    </div>
  );
}

const nodeTypes = { teamLane: TeamLane, teamLeader: LeaderSlot, teamMember: MemberCard };

function applyOptimisticChange(snapshot: TeamStructureSnapshot, change: TeamStructureChange): TeamStructureSnapshot {
  let members = snapshot.members;
  let settings = snapshot.settings;
  if (change.action === 'set-orchestrator') {
    const target = members.find((member) => member.agentId === change.agentId);
    const fallbackIds = settings?.fallbackAgentIds.filter((agentId) => agentId !== change.agentId) ?? [];
    const ranks = new Map(fallbackIds.map((agentId, index) => [agentId, index + 1]));
    members = members.map((member) => ({
      ...member,
      role: member.agentId === change.agentId ? 'orchestrator' : member.role === 'orchestrator' ? change.previousRole : member.role,
      fallbackRank: ranks.get(member.agentId) ?? null,
    }));
    settings = settings ? { ...settings, orchestratorAgentId: change.agentId, fallbackAgentIds: fallbackIds } : settings;
    if (!target) return snapshot;
    return { ...snapshot, needsLeader: false, members, settings };
  } else if (change.action === 'set-role') {
    const wasLeader = members.some((member) => member.agentId === change.agentId && member.role === 'orchestrator');
    members = members.map((member) => member.agentId === change.agentId ? { ...member, role: change.role } : member);
    settings = settings?.orchestratorAgentId === change.agentId ? { ...settings, orchestratorAgentId: null } : settings;
    if (wasLeader && (settings?.fallbackAgentIds.length ?? 0) === 0) return { ...snapshot, needsLeader: true, members, settings };
  } else if (change.action === 'set-fallbacks') {
    const ranks = new Map(change.agentIds.map((id, index) => [id, index + 1]));
    members = members.map((member) => ({ ...member, fallbackRank: ranks.get(member.agentId) ?? null }));
    settings = settings ? { ...settings, fallbackAgentIds: change.agentIds } : settings;
  } else {
    const wasLeader = members.some((member) => member.agentId === change.agentId && member.role === 'orchestrator');
    const nextFallbackIds = settings?.fallbackAgentIds.filter((id) => id !== change.agentId) ?? [];
    const ranks = new Map(nextFallbackIds.map((id, index) => [id, index + 1]));
    members = members.filter((member) => member.agentId !== change.agentId).map((member) => ({ ...member, fallbackRank: ranks.get(member.agentId) ?? null }));
    settings = settings ? {
      ...settings,
      orchestratorAgentId: settings.orchestratorAgentId === change.agentId ? null : settings.orchestratorAgentId,
      fallbackAgentIds: nextFallbackIds,
    } : settings;
    if (wasLeader && (settings?.fallbackAgentIds.length ?? 0) === 0) return { ...snapshot, needsLeader: true, members, settings };
  }
  return { ...snapshot, members, settings };
}

export default function TeamStructure() {
  const project = useProject();
  const theme = useProject() ? document.documentElement.dataset.theme as 'dark' | 'light' | undefined : undefined;
  const [snapshot, setSnapshot] = useState<TeamStructureSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<TeamStructureMember | null>(null);
  const [flowNodes, setFlowNodes] = useState<TeamFlowNode[]>([]);
  const fallbackStrip = useRef<HTMLDivElement>(null);
  const flowLayoutKey = useRef('');
  const busyRef = useRef(false);
  busyRef.current = busy;

  const refresh = useCallback(async (signal?: AbortSignal): Promise<TeamStructureSnapshot | null> => {
    if (!project) { setSnapshot(null); setLoading(false); return null; }
    try {
      const next = await teamStructureApi.snapshot(project.id, signal);
      if (!signal?.aborted) { setSnapshot(next); setLoadError(null); setLoading(false); }
      return next;
    } catch (error) {
      if (!signal?.aborted) { setLoadError(error); setLoading(false); }
      return null;
    }
  }, [project?.id]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSnapshot(null);
    setLoadError(null);
    void refresh(controller.signal);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !busyRef.current) void refresh();
    }, 3000);
    const onStructureChange = () => { if (document.visibilityState === 'visible' && !busyRef.current) void refresh(); };
    const onVisibility = () => { if (document.visibilityState === 'visible' && !busyRef.current) void refresh(); };
    window.addEventListener('mingle:state-changed', onStructureChange);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      controller.abort();
      window.clearInterval(poll);
      window.removeEventListener('mingle:state-changed', onStructureChange);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [project?.id, refresh]);

  const performChange = useCallback(async (change: TeamStructureChange) => {
    const current = snapshot;
    if (!project || !current?.canEdit || !current.settings || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    setSnapshot(applyOptimisticChange(current, change));
    try {
      await teamStructureApi.change(project.id, change);
      setLoadError(null);
      // Keep the optimistic result if the write succeeds but the immediate read is temporarily unavailable.
      try { setSnapshot(await teamStructureApi.snapshot(project.id)); }
      catch (error) { setLoadError(error); }
    } catch (error) {
      setSnapshot(current);
      if (error instanceof TeamStructureApiError && error.status === 409) {
        const fresh = await refresh();
        setNotice(fresh ? 'Structure changed elsewhere — refreshed.' : 'Structure changed elsewhere — refresh failed. Try refresh again.');
      } else {
        setLoadError(error);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [project?.id, snapshot, refresh]);

  const leaderMember = snapshot?.members.find((member) => member.role === 'orchestrator') ?? null;
  const requestPromotion = useCallback((member: TeamStructureMember) => {
    if (!snapshot?.canEdit || member.role === 'orchestrator') return;
    setPendingPromotion({ member, previousRole: 'worker' });
  }, [snapshot?.canEdit]);

  const callbacks = useMemo<Pick<TeamNodeData, 'onPromote' | 'onRoleChange' | 'onFallback' | 'onRemove'>>(() => ({
    onPromote: requestPromotion,
    onRoleChange: (member, role) => { if (snapshot?.settings) void performChange({ action: 'set-role', agentId: member.agentId, role, expectedVersion: snapshot.settings.version }); },
    onFallback: (member, rank) => {
      if (!snapshot?.settings || member.role === 'orchestrator') return;
      const ids = [...snapshot.settings.fallbackAgentIds].filter((id) => id !== member.agentId);
      ids.splice(Math.min(rank - 1, ids.length), 0, member.agentId);
      void performChange({ action: 'set-fallbacks', agentIds: ids.slice(0, 4), expectedVersion: snapshot.settings.version });
    },
    onRemove: setPendingRemoval,
  }), [requestPromotion, snapshot?.settings, performChange]);

  const graph = useMemo(() => snapshot ? buildTeamStructureGraph(snapshot, callbacks) : { nodes: [], edges: [] }, [snapshot, callbacks]);
  const graphLayoutKey = `${snapshot?.projectId ?? ''}|${graph.nodes.map((node) => `${node.id}:${node.position.x},${node.position.y}`).join('|')}`;
  useEffect(() => {
    const layoutChanged = flowLayoutKey.current !== graphLayoutKey;
    flowLayoutKey.current = graphLayoutKey;
    setFlowNodes((current) => {
      if (layoutChanged) return graph.nodes;
      const currentById = new Map(current.map((node) => [node.id, node]));
      return graph.nodes.map((node) => {
        const existing = currentById.get(node.id);
        return existing ? { ...node, position: existing.position } : node;
      });
    });
  }, [graph.nodes, graphLayoutKey]);
  const onNodesChange = useCallback((changes: NodeChange<TeamFlowNode>[]) => {
    setFlowNodes((nodes) => applyNodeChanges(changes, nodes));
  }, []);
  const fallbacks = useMemo(() => (snapshot?.settings?.fallbackAgentIds ?? []).map((agentId) => snapshot?.members.find((member) => member.agentId === agentId)).filter((member): member is TeamStructureMember => Boolean(member)), [snapshot]);

  const updateFallbacks = (agentIds: string[]) => {
    if (!snapshot?.settings || !snapshot.canEdit) return;
    const ordered = [...new Set(agentIds)].slice(0, 4);
    void performChange({ action: 'set-fallbacks', agentIds: ordered, expectedVersion: snapshot.settings.version });
  };

  const confirmPromotion = () => {
    if (!snapshot?.settings || !pendingPromotion) return;
    void performChange({ action: 'set-orchestrator', agentId: pendingPromotion.member.agentId, previousRole: pendingPromotion.previousRole, expectedVersion: snapshot.settings.version });
    setPendingPromotion(null);
  };

  const handleNodeDragStop = (event: MouseEvent | TouchEvent, dragged: TeamFlowNode, nodes: TeamFlowNode[]) => {
    if (!snapshot?.canEdit || !snapshot.settings) return;
    const member = dragged.id.startsWith('member:') ? snapshot.members.find((item) => `member:${item.agentId}` === dragged.id) : dragged.id === 'leader-slot' ? leaderMember ?? undefined : undefined;
    if (!member) return;
    const point = 'changedTouches' in event ? { x: event.changedTouches[0]?.clientX ?? -1, y: event.changedTouches[0]?.clientY ?? -1 } : { x: event.clientX, y: event.clientY };
    const strip = fallbackStrip.current?.getBoundingClientRect();
    if (dragged.id.startsWith('member:') && strip && point.x >= strip.left && point.x <= strip.right && point.y >= strip.top && point.y <= strip.bottom && !fallbacks.some((fallback) => fallback.agentId === member.agentId) && member.role !== 'orchestrator' && fallbacks.length < 4) {
      updateFallbacks([...fallbacks.map((fallback) => fallback.agentId), member.agentId]);
      return;
    }
    const width = dragged.measured?.width ?? TEAM_NODE_WIDTH;
    const height = dragged.measured?.height ?? TEAM_NODE_HEIGHT;
    const center = { x: dragged.position.x + width / 2, y: dragged.position.y + height / 2 };
    const contains = (node: TeamFlowNode | undefined) => {
      if (!node) return false;
      const w = node.measured?.width ?? (Number(node.style?.width) || 0);
      const h = node.measured?.height ?? (Number(node.style?.height) || 0);
      return center.x >= node.position.x && center.x <= node.position.x + w && center.y >= node.position.y && center.y <= node.position.y + h;
    };
    const leaderSlot = nodes.find((node) => node.id === 'leader-slot') as TeamFlowNode | undefined;
    const workersLane = nodes.find((node) => node.id === 'lane:workers') as TeamFlowNode | undefined;
    const benchLane = nodes.find((node) => node.id === 'lane:bench') as TeamFlowNode | undefined;
    if (dragged.id.startsWith('member:') && member.role !== 'orchestrator' && contains(leaderSlot)) { requestPromotion(member); return; }
    if (contains(benchLane) && member.role !== 'idle' && (member.role !== 'orchestrator' || snapshot.needsLeader)) {
      void performChange({ action: 'set-role', agentId: member.agentId, role: 'idle', expectedVersion: snapshot.settings.version });
      return;
    }
    if (contains(workersLane) && member.role !== 'worker' && (member.role !== 'orchestrator' || snapshot.needsLeader)) {
      void performChange({ action: 'set-role', agentId: member.agentId, role: 'worker', expectedVersion: snapshot.settings.version });
      return;
    }
  };

  if (!project) return <EmptyState icon={<Network size={20} />} title="No project">Open a shared project to manage its team structure.</EmptyState>;
  if (loading) return <div className="team-structure__loading"><Spinner label="Loading team structure" /><span>Loading team structure…</span></div>;
  if (loadError && !snapshot) {
    const noSharedTeam = loadError instanceof TeamStructureApiError && loadError.status === 404;
    const action = noSharedTeam
      ? <Button size="sm" variant="primary" onClick={() => useMingle.getState().openDialog({ kind: 'project-collaboration', projectId: project.id })}><Network size={13} /> Open Teammates</Button>
      : <Button size="sm" onClick={() => void refresh()}><RefreshCw size={13} /> Retry</Button>;
    return <div className="team-structure__empty"><EmptyState icon={<Network size={20} />} title={noSharedTeam ? 'This project is not a team project yet' : 'Team structure unavailable'} action={action}>
      {noSharedTeam ? 'Open Teammates and choose “Make this a team project” to enable shared orchestration.' : (loadError instanceof Error ? loadError.message : String(loadError))}
    </EmptyState></div>;
  }
  if (!snapshot) return <div className="team-structure__empty"><EmptyState icon={<Network size={20} />} title="Team structure unavailable">The server did not return a team structure for this project.</EmptyState></div>;
  const canEdit = snapshot.canEdit && Boolean(snapshot.settings);

  if (!snapshot.enabled) return <div className="team-structure">
    <header className="team-structure__header">
      <div className="team-structure__title"><span className="team-structure__glyph"><Network size={16} /></span><div><h1>Team structure</h1><p>Shared orchestration is not enabled for this project.</p></div></div>
      <div className="team-structure__settings" aria-label="Team orchestration settings">
        <span className="team-setting"><i /> Leader orchestration <strong>Off</strong></span>
        {snapshot.settings ? <span className="team-setting"><ShieldCheck size={13} /> Permission <strong>{snapshot.settings.permissionLevel === 'full-access' ? 'Full access' : 'Supervised'}</strong></span> : null}
        <span className={cx('team-setting', snapshot.host.online ? 'is-online' : 'is-offline')}>
          {snapshot.host.online ? <Wifi size={13} /> : <WifiOff size={13} />} Host device <strong>{snapshot.host.displayName} · {snapshot.host.online ? 'Online' : 'Offline'}</strong>
        </span>
      </div>
    </header>
    <div className="team-structure__empty"><EmptyState icon={<Network size={20} />} title="Make this a team project" action={<Button size="sm" variant="primary" onClick={() => useMingle.getState().openDialog({ kind: 'project-collaboration', projectId: project.id })}><Network size={13} /> Open Teammates</Button>}>
      Open Teammates to invite collaborators and enable shared agents for this project.
    </EmptyState></div>
  </div>;

  const fallbackChange = (from: number, to: number) => {
    if (to < 0 || to >= fallbacks.length) return;
    const ids = fallbacks.map((member) => member.agentId);
    const [item] = ids.splice(from, 1);
    if (!item) return;
    ids.splice(to, 0, item);
    updateFallbacks(ids);
  };

  return (
    <div className="team-structure">
      <header className="team-structure__header">
        <div className="team-structure__title"><span className="team-structure__glyph"><Network size={16} /></span><div><h1>Team structure</h1><p>{snapshot.members.length} contributed agent{snapshot.members.length === 1 ? '' : 's'} · updated {new Date(snapshot.observedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p></div></div>
        <div className="team-structure__settings" aria-label="Team orchestration settings">
          <span className={cx('team-setting', snapshot.settings?.leaderOrchestration && 'is-on')}><i /> Leader orchestration <strong>{snapshot.settings ? snapshot.settings.leaderOrchestration ? 'On' : 'Off' : 'Not configured'}</strong></span>
          {snapshot.settings ? <span className="team-setting"><ShieldCheck size={13} /> Permission <strong>{snapshot.settings.permissionLevel === 'full-access' ? 'Full access' : 'Supervised'}</strong></span> : null}
          <span className={cx('team-setting', snapshot.host.online ? 'is-online' : 'is-offline')}>
            {snapshot.host.online ? <Wifi size={13} /> : <WifiOff size={13} />} Host device <strong>{snapshot.host.displayName} · {snapshot.host.online ? 'Online' : 'Offline'}</strong>
          </span>
        </div>
      </header>

      {snapshot.needsLeader ? <div className="team-structure__pause" role="status"><CircleAlert size={16} /><div><strong>Team work is paused</strong><span>The orchestrator is unavailable and no fallback could take over. Drag an available agent into the leader slot.</span></div></div> : null}
      {!snapshot.enabled ? <div className="team-structure__readonly" role="note">Leader orchestration is not enabled for this shared project yet.</div> : null}
      {!snapshot.canEdit ? <div className="team-structure__readonly" role="note">Only the team lead’s device can change the structure.</div> : null}
      {notice ? <div className="team-structure__notice" role="status"><Check size={14} />{notice}</div> : null}
      {loadError && snapshot ? <InlineError onRetry={() => void refresh()}>{loadError instanceof Error ? loadError.message : String(loadError)}</InlineError> : null}

      <section className="team-fallback" aria-label="Fallback leaders">
        <div className="team-fallback__title"><span><RefreshCw size={13} /><strong>Fallback order</strong></span><small>Promoted automatically when the leader is offline or quota-exhausted · up to 4</small></div>
        <div className="team-fallback__strip" ref={fallbackStrip}>
          {fallbacks.length ? fallbacks.map((member, index) => <div className="team-fallback-chip" key={member.agentId} draggable={canEdit && !busy} onDragStart={(event) => { event.dataTransfer.setData('text/plain', member.agentId); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={(event) => { if (canEdit) event.preventDefault(); }} onDrop={(event) => {
            if (!canEdit) return;
            event.preventDefault();
            const moving = event.dataTransfer.getData('text/plain');
            const from = fallbacks.findIndex((entry) => entry.agentId === moving);
            if (from < 0 || from === index) return;
            const ids = fallbacks.map((entry) => entry.agentId);
            const [id] = ids.splice(from, 1);
            if (id) ids.splice(index, 0, id);
            updateFallbacks(ids);
          }}>
            <span className="team-fallback-chip__rank">#{index + 1}</span><span className="team-fallback-chip__handle">@{member.handle}</span>
            {canEdit ? <span className="team-fallback-chip__actions"><button type="button" aria-label={`Move @${member.handle} fallback up`} disabled={busy || index === 0} onClick={() => fallbackChange(index, index - 1)}><ArrowUp size={12} /></button><button type="button" aria-label={`Move @${member.handle} fallback down`} disabled={busy || index === fallbacks.length - 1} onClick={() => fallbackChange(index, index + 1)}><ArrowDown size={12} /></button><button type="button" aria-label={`Remove @${member.handle} from fallbacks`} disabled={busy} onClick={() => updateFallbacks(fallbacks.filter((entry) => entry.agentId !== member.agentId).map((entry) => entry.agentId))}><X size={12} /></button></span> : null}
          </div>) : <span className="team-fallback__empty">No fallback leaders configured</span>}
          {canEdit && fallbacks.length < 4 ? <span className="team-fallback__hint">Drag an agent here or use its actions menu to add a fallback</span> : null}
        </div>
      </section>

      <div className="team-structure__canvas-wrap" aria-busy={busy}>
        <ReactFlow
          key={snapshot.projectId}
          nodes={flowNodes} edges={graph.edges} nodeTypes={nodeTypes} colorMode={theme === 'light' ? 'light' : 'dark'}
          fitView fitViewOptions={{ padding: 0.1, maxZoom: 1 }} minZoom={0.3} maxZoom={1.5}
          onNodesChange={onNodesChange} nodesDraggable={canEdit} nodesConnectable={false} elementsSelectable={false}
          onNodeDragStop={handleNodeDragStop}
          aria-label="Interactive team structure"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {busy ? <div className="team-structure__busy" role="status"><Spinner label="Saving team structure" /> Saving structure…</div> : null}
        {pendingPromotion ? <div className="team-structure__confirm" role="dialog" aria-label="Confirm leader handover">
          <button type="button" className="team-structure__confirm-close" aria-label="Cancel leader handover" autoFocus onClick={() => setPendingPromotion(null)}><X size={15} /></button>
          <strong>Make @{pendingPromotion.member.handle} the orchestrator?</strong>
          {leaderMember ? <><span>Current leader @{leaderMember.handle} becomes:</span><div className="team-structure__role-choice"><button type="button" className={pendingPromotion.previousRole === 'worker' ? 'is-selected' : ''} onClick={() => setPendingPromotion({ ...pendingPromotion, previousRole: 'worker' })}><GitFork size={13} /> Worker</button><button type="button" className={pendingPromotion.previousRole === 'idle' ? 'is-selected' : ''} onClick={() => setPendingPromotion({ ...pendingPromotion, previousRole: 'idle' })}><Armchair size={13} /> Idle</button></div></> : <span>The agent you choose will take over team coordination.</span>}
          <div className="team-structure__confirm-actions"><Button size="sm" onClick={() => setPendingPromotion(null)}>Cancel</Button><Button size="sm" variant="primary" busy={busy} onClick={confirmPromotion}><Crown size={13} /> Make orchestrator</Button></div>
        </div> : null}
      </div>

      <details className="team-history">
        <summary><span><RefreshCw size={13} /><strong>Leader history</strong></span><span>{snapshot.leaderHistory.length} change{snapshot.leaderHistory.length === 1 ? '' : 's'}</span></summary>
        {snapshot.leaderHistory.length ? <ol>{[...snapshot.leaderHistory].reverse().map((change) => {
          const fromId = change.fromAgentId;
          const toId = change.toAgentId;
          const labelFor = (agentId: string | null) => {
            if (!agentId) return 'No leader';
            const member = snapshot.members.find((entry) => entry.agentId === agentId);
            return member ? `@${member.handle}` : `Agent ${agentId.slice(0, 8)}`;
          };
          return <li key={change.id}><span className="team-history__dot" /><div><strong>{REASON_LABEL[change.reason]}</strong><span>{labelFor(fromId)} → {labelFor(toId)}</span></div><time dateTime={change.at}>{new Date(change.at).toLocaleString()}</time></li>;
        })}</ol> : <p>No leader changes have been recorded.</p>}
      </details>

      {pendingRemoval ? <Modal
        title={`Remove @${pendingRemoval.handle} from the team?`}
        onClose={() => setPendingRemoval(null)}
        footer={<><Button size="sm" onClick={() => setPendingRemoval(null)}>Cancel</Button><Button size="sm" variant="danger" busy={busy} onClick={() => { if (!snapshot.settings) return; void performChange({ action: 'remove', agentId: pendingRemoval.agentId, expectedVersion: snapshot.settings.version }); setPendingRemoval(null); }}><Trash2 size={13} /> Remove agent</Button></>}
      >This removes the agent from the shared roster and fallback order. The owner’s local session stays on their device.</Modal> : null}
    </div>
  );
}
