import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Activity, ArrowDownToLine, ArrowLeftRight, Check, CircleHelp, GitBranch, Laptop, LockKeyhole, MessageSquare, Plus, RefreshCw, Send, Shield, Users, Workflow } from 'lucide-react';
import type { Project, Session, Task } from '@mingle/contracts';
import { api } from '../../lib/api';
import { useMingle, type TeamWorkspaceTab } from '../../store/store';
import { Button, Badge, EmptyState, InlineError } from '../ui';
import { createIdempotencyKey, distributedApi, DistributedApiError, type DistributedRecord, type DistributedSnapshot } from './api';
import { asRecord, idOf, nameOf, readList, readText, readValue, unwrap } from './viewModels';
import '../../styles/distributed.css';
import { SharedAgentMap } from './SharedAgentMap';

type WorkspaceTab = TeamWorkspaceTab;
const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'people', label: 'People' }, { id: 'projects', label: 'Projects' }, { id: 'devices', label: 'Devices' },
  { id: 'agents', label: 'Agents' }, { id: 'conversation', label: 'Conversation' }, { id: 'recovery', label: 'Recovery' }, { id: 'transfers', label: 'Transfers' },
];
const text = (row: unknown, keys: string[], fallback = 'Not reported') => readText(row, keys, fallback);
const taskRecordKey = (row: unknown, index: number) => JSON.stringify([readText(row, ['teamId']), readText(row, ['deviceId']), readText(row, ['sharedProjectId']), idOf(row, ['id', 'taskId']) || `task-${index}`]);
const normalized = (value: string) => value.trim().toLowerCase().replaceAll('_', '-');

function recordsFrom(sources: unknown[], keys: string[]): DistributedRecord[] {
  for (const source of sources) {
    // A section array is only a list for the section itself (for example teams),
    // never a substitute for a different named collection such as its projects.
    if (Array.isArray(source) && keys.length) continue;
    const rows = readList(source, keys);
    if (rows.length) return rows;
  }
  return [];
}

function listSnapshot(snapshot: DistributedSnapshot | null, sectionName: string, keys: string[], nestedSources: unknown[] = []): DistributedRecord[] {
  const section = snapshot?.[sectionName];
  return recordsFrom([section, ...nestedSources, snapshot], keys);
}

function serviceTeamRows(snapshot: DistributedSnapshot | null): DistributedRecord[] {
  const section = snapshot?.teams;
  const rows = readList(section, ['teams', 'items', 'memberships']);
  if (rows.length) return rows;
  const candidate = asRecord(section);
  const team = candidate ? asRecord(candidate.team) : null;
  return team && idOf(team, ['id', 'teamId']) ? [team] : [];
}

function displayStatus(row: unknown, statusKeys: string[] = ['presence', 'status', 'state']): { label: string; tone: 'ok' | 'warn' | 'err' | 'neutral' } {
  const value = normalized(readText(row, statusKeys));
  if (['online', 'ready', 'connected', 'active'].includes(value)) return { label: value === 'active' ? 'Active' : value[0]!.toUpperCase() + value.slice(1), tone: 'ok' };
  if (['busy', 'running', 'working'].includes(value)) return { label: 'Busy', tone: 'warn' };
  if (['idle', 'available'].includes(value)) return { label: 'Idle', tone: 'neutral' };
  if (['offline', 'disconnected', 'revoked'].includes(value)) return { label: value === 'revoked' ? 'Revoked' : 'Offline', tone: 'err' };
  if (['failed', 'error'].includes(value)) return { label: 'Failed', tone: 'err' };
  return { label: 'Presence unknown', tone: 'neutral' };
}

function invitationStatus(row: unknown): { label: string; tone: 'warn' | 'neutral' | 'err' } {
  if (readText(row, ['acceptedAt', 'accepted_at'])) return { label: 'Accepted', tone: 'neutral' };
  const expiresAt = readText(row, ['expiresAt', 'expiry', 'expires_at']);
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isFinite(expiry) && expiry <= Date.now()) return { label: 'Expired', tone: 'err' };
  return { label: 'Pending', tone: 'warn' };
}

function belongsToLocalDevice(row: unknown, localDeviceId: string, side: 'source' | 'destination'): boolean {
  if (!localDeviceId) return false;
  const keys = side === 'destination'
    ? ['targetDeviceId', 'toDeviceId', 'destinationDeviceId', 'ownerDeviceId']
    : ['sourceDeviceId', 'fromDeviceId', 'ownerDeviceId'];
  const reportedOwner = readText(row, keys);
  return !reportedOwner || reportedOwner === localDeviceId;
}

function decisionIdentities(snapshot: DistributedSnapshot | null): Map<string, string> {
  const identities = new Map<string, string>();
  const add = (rows: DistributedRecord[], digestKeys: string[], scopeKeys: string[]) => {
    for (const row of rows) {
      const id = idOf(row, ['id', 'requestId']);
      if (!id) continue;
      identities.set(id, [readText(row, digestKeys), ...scopeKeys.map((key) => readText(row, [key])), readText(row, ['status', 'state'])].join('|'));
    }
  };
  add(listSnapshot(snapshot, 'execution', ['requests']), ['digest', 'requestDigest'], ['targetOwnerId', 'targetDeviceId']);
  add(listSnapshot(snapshot, 'git', ['requests', 'transfers', 'operations']), ['requestDigest', 'digest'], ['direction', 'targetDeviceId', 'peerDeviceId']);
  add(listSnapshot(snapshot, 'commands', ['requests', 'commandRequests']), ['requestDigest', 'digest'], ['direction', 'targetDeviceId', 'peerDeviceId']);
  return identities;
}

function agentDeviceId(row: unknown): string {
  const agent = unwrap(row, 'agent');
  const device = asRecord(readValue(agent, ['device', 'ownerDevice']));
  return readText(agent, ['deviceId', 'ownerDeviceId', 'toDeviceId']) || readText(device, ['id', 'deviceId']);
}

function exactList(value: unknown): string {
  if (!Array.isArray(value)) return 'Not reported';
  return value.length ? value.map((item) => String(item)).join(' · ') : 'None';
}

function SelectControl({ label, value, onChange, options, disabled, hint }: {
  label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; disabled?: boolean; hint?: string;
}) {
  return <label className="dw-field"><span>{label}</span><select className="input" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    <option value="">Choose {label.toLowerCase()}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>{hint ? <small>{hint}</small> : null}</label>;
}

function TextControl({ label, value, onChange, placeholder, type = 'text', required = false, hint, maxLength }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; required?: boolean; hint?: string; maxLength?: number;
}) {
  return <label className="dw-field"><span>{label}</span><input className="input" type={type} value={value} placeholder={placeholder} required={required} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} />{hint ? <small>{hint}</small> : null}</label>;
}

function Disclosure({ title, value }: { title: string; value: string }) {
  return <div className="dw-disclosure"><span>{title}</span><strong>{value || 'Not reported'}</strong></div>;
}

export function TeamWorkspace({ initialTab = 'people' }: { initialTab?: WorkspaceTab }) {
  const boot = useMingle((state) => state.boot);
  const activeProjectId = useMingle((state) => state.activeProjectId);
  const eventCount = useMingle((state) => state.boot?.events.length ?? 0);
  const projects = boot?.projects ?? [];
  const localSessions = boot?.sessions ?? [];
  const [snapshot, setSnapshot] = useState<DistributedSnapshot | null>(null);
  const [accountIdentity, setAccountIdentity] = useState<{ userId: string; name: string | null; email: string | null } | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [checkedApprovals, setCheckedApprovals] = useState<Record<string, boolean>>({});
  const [shareProgress, setShareProgress] = useState<Record<string, boolean>>({});
  const [allowProviderSpend, setAllowProviderSpend] = useState<Record<string, boolean>>({});
  const [allowUnverifiedQuota, setAllowUnverifiedQuota] = useState<Record<string, boolean>>({});
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const operationGeneration = useRef(0);
  const previousSnapshot = useRef<{ snapshot: DistributedSnapshot; teamId: string; userId: string | null } | null>(null);

  const clearDecisions = () => {
    setCheckedApprovals({});
    setShareProgress({});
    setAllowProviderSpend({});
    setAllowUnverifiedQuota({});
  };
  const clearTeamActionState = () => {
    operationGeneration.current++;
    clearDecisions();
    setResult(null);
    setNotice(null);
    setError(null);
    setErrorStatus(null);
  };

  const teams = useMemo(() => serviceTeamRows(snapshot), [snapshot]);
  const chosenTeamRow = teams.find((team) => idOf(team, ['id', 'teamId']) === selectedTeamId) ?? teams[0];
  const selectedTeam = chosenTeamRow ? unwrap(chosenTeamRow, 'team') : {};
  const selectedTeamKey = chosenTeamRow ? idOf(chosenTeamRow, ['id', 'teamId']) : '';
  const teamRows = (rows: DistributedRecord[]) => rows.filter((row) => !readText(row, ['teamId']) || readText(row, ['teamId']) === selectedTeamKey);
  const canManageTeam = ['owner', 'admin'].includes(readText(selectedTeam, ['role']).toLowerCase());
  const teamContainers = [snapshot?.teams, chosenTeamRow, selectedTeam];
  const bindings = listSnapshot(snapshot, 'execution', ['bindings']);
  const sharedProjects = teamRows(listSnapshot(snapshot, 'teams', ['projects', 'sharedProjects', 'items'], teamContainers)).map((row) => {
    const binding = bindings.find((binding) => binding.teamId === selectedTeamKey && binding.sharedProjectId === row.id);
    return binding ? { ...row, localProjectId: binding.localProjectId } : row;
  });
  const members = teamRows(listSnapshot(snapshot, 'teams', ['members', 'roster', 'people'], [chosenTeamRow, selectedTeam]));
  const invitations = teamRows(listSnapshot(snapshot, 'teams', ['invitations', 'pendingInvitations'], [chosenTeamRow, selectedTeam]));
  const devices = teamRows(listSnapshot(snapshot, 'transport', ['devices', 'registeredDevices', 'roster'], teamContainers));
  const transportSection = asRecord(snapshot?.transport) ?? {};
  const localDevice = devices.find((device) => idOf(device, ['id', 'deviceId']) === readText(transportSection, ['deviceId'])) ?? {};
  const links = teamRows(readList(transportSection, ['links', 'deviceLinks']));
  const agents = teamRows(listSnapshot(snapshot, 'execution', ['agents', 'roster', 'remoteAgents'], teamContainers));
  const messages = teamRows(listSnapshot(snapshot, 'execution', ['messages', 'conversation', 'chat'], teamContainers));
  const tasks = teamRows(listSnapshot(snapshot, 'execution', ['tasks', 'sharedTasks'], teamContainers));
  const executionRequests = teamRows(listSnapshot(snapshot, 'execution', ['requests'], teamContainers));
  const executionEvents = teamRows(listSnapshot(snapshot, 'execution', ['timeline', 'events', 'deliveries', 'progress'], teamContainers));
  const gitRequests = teamRows(listSnapshot(snapshot, 'git', ['requests', 'transfers', 'operations'], teamContainers));
  const gitRequestIds = new Set(gitRequests.map((row) => idOf(row, ['id', 'requestId'])));
  const gitAudit = listSnapshot(snapshot, 'git', ['audit', 'audits', 'history'], teamContainers).filter((row) => {
    const rowTeamId = readText(row, ['teamId']);
    return rowTeamId ? rowTeamId === selectedTeamKey : gitRequestIds.has(readText(row, ['requestId']));
  });
  const commandRequests = teamRows(listSnapshot(snapshot, 'commands', ['requests', 'commandRequests'], teamContainers));
  const commandRequestIds = new Set(commandRequests.map((row) => idOf(row, ['id', 'requestId'])));
  const commandAudit = listSnapshot(snapshot, 'commands', ['audit', 'audits', 'history', 'outcomes'], teamContainers).filter((row) => {
    const rowTeamId = readText(row, ['teamId']);
    return rowTeamId ? rowTeamId === selectedTeamKey : commandRequestIds.has(readText(row, ['requestId']));
  });
  const selectedLocalProject = projects.find((project) => project.id === activeProjectId);
  const teamSection = asRecord(snapshot?.teams);
  const verifiedUserId = readText(teamSection, ['userId']);
  const teamsStatus = teamSection?.error || error
    ? { label: 'Unavailable', tone: 'err' as const }
    : verifiedUserId
      ? { label: 'Signed in', tone: 'ok' as const }
      : snapshot
        ? { label: 'Signed out', tone: 'neutral' as const }
        : loading
          ? { label: 'Loading', tone: 'neutral' as const }
          : { label: 'Unavailable', tone: 'err' as const };
  const cloudActionsAvailable = Boolean(snapshot && verifiedUserId && !error && !teamSection?.error);
  const actionBusy = busy ?? (cloudActionsAvailable ? null : 'cloud-unavailable');
  const transportStatus = displayStatus(snapshot?.transport, ['status', 'state', 'connection']);

  useEffect(() => {
    let current = true;
    setAccountIdentity(null);
    if (!verifiedUserId) return () => { current = false; };
    void api.account().then((account) => {
      const user = account.user;
      if (current && user?.id === verifiedUserId && account.status === 'signed-in') {
        setAccountIdentity({ userId: user.id, name: user.name, email: user.email });
      }
    }).catch(() => { /* Public profile details are optional; the verified team snapshot remains authoritative. */ });
    return () => { current = false; };
  }, [verifiedUserId]);

  const refreshSnapshot = useCallback(async (quiet = false) => {
    const current = ++sequence.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    if (!quiet) setLoading(true);
    try {
      const next = await distributedApi.snapshot(selectedTeamId || undefined, nextController.signal);
      if (sequence.current !== current) return;
      const serviceError = readText(next.teams, ['error']) || readText(next.transport, ['error']);
      if (serviceError) {
        previousSnapshot.current = null;
        clearTeamActionState();
        setSnapshot(null);
        setUpdatedAt(null);
      } else {
        const userId = readText(next.teams, ['userId']) || null;
        const previous = previousSnapshot.current;
        if (!previous || previous.teamId !== selectedTeamId || previous.userId !== userId) {
          if (previous && previous.userId !== userId) operationGeneration.current++;
          clearDecisions();
          setResult(null);
          setNotice(null);
        } else {
          const before = decisionIdentities(previous.snapshot);
          const after = decisionIdentities(next);
          const changed = new Set([...before.keys(), ...after.keys()].filter((id) => before.get(id) !== after.get(id)));
          if (changed.size) {
            const retain = (current: Record<string, boolean>) => Object.fromEntries(Object.entries(current).filter(([id]) => !changed.has(id)));
            setCheckedApprovals(retain);
            setShareProgress(retain);
            setAllowProviderSpend(retain);
            setAllowUnverifiedQuota(retain);
          }
        }
        previousSnapshot.current = { snapshot: next, teamId: selectedTeamId, userId };
        setSnapshot(next);
      }
      setError(serviceError || null);
      setErrorStatus(serviceError ? (/sign.?in/i.test(serviceError) ? 401 : 503) : null);
      setUpdatedAt(new Date().toISOString());
    } catch (cause) {
      if (nextController.signal.aborted || sequence.current !== current) return;
      previousSnapshot.current = null;
      clearTeamActionState();
      setSnapshot(null);
      setUpdatedAt(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      setErrorStatus(cause instanceof DistributedApiError ? cause.status : null);
    } finally {
      if (sequence.current === current) setLoading(false);
    }
  }, [selectedTeamId]);

  useEffect(() => {
    void refreshSnapshot();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSnapshot(true);
    }, 5_000);
    const refreshOnReturn = () => { if (document.visibilityState === 'visible') void refreshSnapshot(true); };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
      sequence.current++;
      controller.current?.abort();
    };
  }, [refreshSnapshot, eventCount]);

  useEffect(() => {
    if (!teams.length) return;
    const ids = teams.map((team) => idOf(team, ['id', 'teamId'])).filter(Boolean);
    if (!selectedTeamId && ids[0]) setSelectedTeamId(ids[0]);
    else if (selectedTeamId && !ids.includes(selectedTeamId)) {
      clearTeamActionState();
      previousSnapshot.current = null;
      setSelectedTeamId('');
    }
  }, [teams, selectedTeamId]);

  const perform = async (key: string, success: string, work: () => Promise<unknown>) => {
    if (!cloudActionsAvailable) {
      setError(error || (!snapshot
        ? 'Refresh the team workspace and wait for a current cloud snapshot before submitting.'
        : 'Sign in to a verified account before submitting team changes.'));
      setErrorStatus(errorStatus ?? (snapshot ? 401 : null));
      return;
    }
    if (busy) return;
    const generation = operationGeneration.current;
    setBusy(key); setError(null); setErrorStatus(null); setNotice(null); setResult(null);
    try {
      const value = await work();
      if (generation !== operationGeneration.current) return;
      setResult(value);
      setNotice(success);
      await refreshSnapshot(true);
      return value;
    } catch (cause) {
      if (generation !== operationGeneration.current) return;
      if (cause instanceof DistributedApiError && cause.status === 409 && /digest/i.test(cause.message)) {
        previousSnapshot.current = null;
        clearDecisions();
        setSnapshot(null);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      setErrorStatus(cause instanceof DistributedApiError ? cause.status : null);
    } finally { setBusy(null); }
  };

  const deviceOptions = devices.map((device) => ({ value: idOf(device, ['id', 'deviceId']), label: `${nameOf(device, 'Device')} · ${displayStatus(device).label}` })).filter((option) => option.value && option.value !== idOf(localDevice, ['id', 'deviceId']));

  const currentTab = <>
    {tab === 'people' ? <PeoplePanel teamId={selectedTeamKey} team={selectedTeam} currentUserId={verifiedUserId} accountIdentity={accountIdentity} canManageTeam={canManageTeam} members={members} invitations={invitations} busy={actionBusy} actionsAvailable={cloudActionsAvailable} result={result} perform={perform} onCreatedTeam={setSelectedTeamId} /> : null}
    {tab === 'projects' ? <ProjectsPanel teamId={selectedTeamKey} sharedProjects={sharedProjects} localProject={selectedLocalProject} canManageTeam={canManageTeam} busy={actionBusy} perform={perform} /> : null}
    {tab === 'devices' ? <DevicesPanel teamId={selectedTeamKey} localDevice={localDevice} devices={devices} links={links} busy={actionBusy} result={result} perform={perform} /> : null}
    {tab === 'agents' ? <AgentsPanel teamId={selectedTeamKey} sharedProjects={sharedProjects} localProject={selectedLocalProject} localSessions={localSessions} agents={agents} devices={devices} tasks={tasks} members={members} busy={actionBusy} perform={perform} /> : null}
    {tab === 'conversation' ? <ConversationPanel teamId={selectedTeamKey} sharedProjects={sharedProjects} localTasks={(boot?.tasks ?? []).filter((task) => task.projectId === activeProjectId)} messages={messages} tasks={tasks} timeline={executionEvents} busy={actionBusy} perform={perform} /> : null}
    {tab === 'recovery' ? <RecoveryPanel teamId={selectedTeamKey} sharedProjects={sharedProjects} agents={agents} requests={executionRequests} localDeviceId={idOf(localDevice, ['id', 'deviceId'])} localSessions={localSessions} localTasks={(boot?.tasks ?? []).filter((task) => task.projectId === activeProjectId)} runs={boot?.runs ?? []} busy={actionBusy} checkedApprovals={checkedApprovals} setCheckedApprovals={setCheckedApprovals} shareProgress={shareProgress} setShareProgress={setShareProgress} allowProviderSpend={allowProviderSpend} setAllowProviderSpend={setAllowProviderSpend} allowUnverifiedQuota={allowUnverifiedQuota} setAllowUnverifiedQuota={setAllowUnverifiedQuota} perform={perform} /> : null}
    {tab === 'transfers' ? <TransfersPanel teamId={selectedTeamKey} localDeviceId={idOf(localDevice, ['id', 'deviceId'])} sharedProjects={sharedProjects} devices={deviceOptions} gitRequests={gitRequests} gitAudit={gitAudit} commandRequests={commandRequests} commandAudit={commandAudit} busy={actionBusy} checkedApprovals={checkedApprovals} setCheckedApprovals={setCheckedApprovals} perform={perform} /> : null}
  </>;

  const noTeam = teams.length === 0;
  return <section className="settings-page__section distributed" aria-labelledby="distributed-heading">
    <header className="distributed__header">
      <div className="distributed__title"><span className="distributed__mark"><Users size={17} aria-hidden="true" /></span><div><h2 id="distributed-heading">Team workspace</h2><p>Share selected work across devices. Your local sessions remain the default.</p></div></div>
      <div className="distributed__header-actions">
        {teams.length ? <label className="distributed__team-select"><span className="sr-only">Active team</span><select className="input" value={selectedTeamKey} onChange={(event) => {
          const nextTeamId = event.target.value;
          if (nextTeamId === selectedTeamId) return;
          clearTeamActionState();
          setSelectedTeamId(nextTeamId);
        }} aria-label="Active team">{teams.map((team) => <option key={idOf(team, ['id', 'teamId'])} value={idOf(team, ['id', 'teamId'])}>{nameOf(team, 'Team')}</option>)}</select></label> : null}
        <Button size="sm" disabled={Boolean(busy) || !cloudActionsAvailable} busy={busy === 'sync'} onClick={() => void perform('sync', 'Device mailbox checked.', () => distributedApi.sync())}><RefreshCw size={13} /> Sync</Button>
        <Button size="sm" disabled={loading || Boolean(busy)} onClick={() => void refreshSnapshot()}><RefreshCw size={13} /> Refresh</Button>
      </div>
    </header>
    <div className="distributed__statusline" role="status">
      <span><i className="distributed__dot" /> Team service: {teamsStatus.label}</span>
      <span><i className="distributed__dot" /> Device transport: {transportStatus.label}</span>
      <span>{updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : loading ? 'Loading snapshot…' : 'Snapshot not available'}</span>
    </div>
    {error ? <><InlineError onRetry={() => void refreshSnapshot()}>{error}{/migration|schema|table/i.test(error) ? ' A distributed service migration may be missing.' : errorStatus === 404 ? ' Distributed routes may not be integrated in this runtime yet.' : ''}</InlineError>{(errorStatus === 401 || /sign.?in|authenticated account|required account/i.test(error)) ? <Button size="sm" onClick={() => useMingle.getState().openSettings({ section: 'account' })}>Open Account settings</Button> : null}</> : null}
    {notice ? <p className="distributed__notice" role="status"><Check size={13} />{notice}</p> : null}
    <p className="distributed__principle"><LockKeyhole size={13} aria-hidden="true" /> Linking and publishing never starts an agent. Remote work needs a specific request and approval on the destination device.</p>
    <nav className="distributed__tabs" aria-label="Team workspace sections">
      {TABS.map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </nav>
    {noTeam && tab !== 'people' ? <EmptyState icon={<Users size={19} />} title="Create or join a team first">The other workspace sections appear here when a team snapshot is available.</EmptyState> : null}
    {(!noTeam || tab === 'people') ? currentTab : null}
    <footer className="distributed__foot">{loading ? 'Checking team workspace…' : 'Local workspace stays available when team services are offline.'}</footer>
  </section>;
}

function PeoplePanel({ teamId, team, currentUserId, accountIdentity, canManageTeam, members, invitations, busy, actionsAvailable, result, perform, onCreatedTeam }: {
  teamId: string; team: DistributedRecord; currentUserId: string; accountIdentity: { userId: string; name: string | null; email: string | null } | null; canManageTeam: boolean; members: DistributedRecord[]; invitations: DistributedRecord[]; busy: string | null; actionsAvailable: boolean; result: unknown;
  perform: (key: string, success: string, work: () => Promise<unknown>) => Promise<unknown | undefined>;
  onCreatedTeam: (id: string) => void;
}) {
  const [teamName, setTeamName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [token, setToken] = useState('');
  const createdToken = readText(result, ['token', 'inviteToken', 'invitationToken']);
  const hasTeam = Boolean(teamId);

  const createTeamForm = <form className="dw-card dw-people-action" onSubmit={(event: FormEvent) => { event.preventDefault(); void perform('create-team', 'Team created. No agents were started.', async () => { const response = await distributedApi.createTeam(teamName.trim()); setTeamName(''); return response; }).then((response) => { const id = idOf(response, ['id', 'teamId']) || idOf(asRecord(response)?.team, ['id', 'teamId']); if (id) onCreatedTeam(id); }); }}>
    <div className="dw-card__heading"><span><Plus size={15} /></span><div><h3>Create a team</h3><p>Membership is tied to verified account identity.</p></div></div>
    <TextControl label="Team name" value={teamName} onChange={setTeamName} required maxLength={100} placeholder="Design systems" />
    <Button type="submit" size="sm" disabled={!actionsAvailable || Boolean(busy) || !teamName.trim()} busy={busy === 'create-team'}>Create team</Button>
  </form>;

  const acceptInvitationForm = <form className="dw-card dw-people-action" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!token.trim()) return; void perform('accept-invite', 'Invitation accepted. Refreshing team membership.', () => distributedApi.acceptInvite(token.trim())).then((response) => { if (response !== undefined) setToken(''); }); }}>
    <div className="dw-card__heading"><span><ArrowDownToLine size={15} /></span><div><h3>Accept an invitation</h3><p>Acceptance is checked against the signed-in account by the service.</p></div></div>
    <TextControl label="Invitation token" value={token} onChange={setToken} required placeholder="Paste the one-time token" />
    <Button type="submit" size="sm" disabled={!actionsAvailable || Boolean(busy) || !token.trim()} busy={busy === 'accept-invite'}>Accept invitation</Button>
  </form>;

  const invitationForm = <form className="dw-people-invite" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!teamId || !canManageTeam) return; void perform('invite', 'Invitation created. Share its one-time token with the teammate yourself.', () => distributedApi.invite({ teamId, email: email.trim(), role })); }}>
    <div className="dw-card__heading"><span><Users size={15} /></span><div><h4>Invite someone</h4><p>Invitations expire and can be accepted once by the matching account.</p></div></div>
    <TextControl label="Email" type="email" value={email} onChange={setEmail} required placeholder="teammate@example.com" />
    <SelectControl label="Role" value={role} onChange={setRole} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} />
    <Button type="submit" size="sm" disabled={!actionsAvailable || Boolean(busy) || !teamId || !email.trim() || !canManageTeam} why={!canManageTeam ? 'Only a team owner or admin can invite members.' : undefined} busy={busy === 'invite'}>Create invitation</Button>
    {createdToken ? <div className="dw-secret" role="status"><strong>Copy this invitation token now</strong><code>{createdToken}</code><small>It is shown from this creation response only. Send it through a channel you choose.</small></div> : null}
  </form>;

  return <div className="distributed__panel">
    {!hasTeam ? <div className="distributed__grid distributed__grid--people-onboarding" aria-label="Team onboarding">{createTeamForm}{acceptInvitationForm}</div> : <>
      <div className="distributed__grid distributed__grid--people-primary">
        <section className="dw-card dw-people-roster" aria-labelledby="dw-team-members-heading">
          <div className="dw-section-head"><div><h3 id="dw-team-members-heading">{nameOf(team, 'Team')} members</h3><p>Names are for display; authorization uses verified account identifiers.</p></div><Badge>{members.length} listed</Badge></div>
          {members.length ? <div className="dw-list">{members.map((raw, index) => {
            const member = unwrap(raw, 'member', 'user');
            const userId = readText(raw, ['userId', 'accountId']) || readText(member, ['id', 'userId']);
            const memberId = idOf(raw, ['id', 'memberId']) || userId || `member-${index}`;
            const isCurrentUser = Boolean(userId && userId === currentUserId && accountIdentity?.userId === userId);
            const memberName = nameOf(member, nameOf(raw, isCurrentUser ? accountIdentity?.name || accountIdentity?.email || 'You' : 'Team member'));
            const memberEmail = text(member, ['email'], text(raw, ['email'], isCurrentUser ? accountIdentity?.email || 'Email not shared' : 'Email not shared'));
            const memberRole = readText(raw, ['role']) || readText(member, ['role']);
            const canRemove = Boolean(userId && !isCurrentUser && (
              readText(team, ['role']).toLowerCase() === 'owner' && ['admin', 'member'].includes(memberRole.toLowerCase())
              || readText(team, ['role']).toLowerCase() === 'admin' && memberRole.toLowerCase() === 'member'
            ));
            return <article className="dw-row" key={memberId}><div className="dw-avatar" aria-hidden="true">{memberName.charAt(0).toUpperCase()}</div><div className="dw-row__main"><strong>{memberName}</strong><span>{memberEmail} · {memberRole || 'Role unknown'}</span></div>{canManageTeam && canRemove ? <Button size="sm" variant="danger" disabled={Boolean(busy) || !teamId} onClick={() => { if (window.confirm(`Remove ${memberEmail} from this team? Their devices will lose future team authority.`)) void perform(`revoke-member:${userId}`, 'Team membership revoked.', () => distributedApi.revokeMember({ teamId, userId })); }}>Remove</Button> : null}</article>;
          })}</div> : <p className="dw-empty">No member roster was reported for this team yet.</p>}
        </section>
        <section className="dw-card dw-people-invitations" aria-labelledby="dw-team-invitations-heading">
          <div className="dw-section-head"><div><h3 id="dw-team-invitations-heading">Invitations</h3><p>Invitation records, expiry and status for this team.</p></div><Badge>{invitations.length}</Badge></div>
          {invitationForm}
          {invitations.length ? <div className="dw-list">{invitations.map((row, index) => { const state = invitationStatus(row); return <article className="dw-row" key={idOf(row) || `invite-${index}`}><div className="dw-row__main"><strong>{text(row, ['email'], 'Invitation recipient not reported')}</strong><span>{text(row, ['role'], 'Role unknown')} · {state.label} · expires {text(row, ['expiresAt', 'expiry', 'expires_at'], 'not reported')}</span></div><Badge tone={state.tone}>{state.label}</Badge></article>; })}</div> : <p className="dw-empty">No invitation records are currently listed.</p>}
        </section>
      </div>
      <details className="dw-people-secondary">
        <summary><span><strong>More team actions</strong><small>Create another team or join one with an invitation token</small></span><span className="dw-people-secondary__toggle" aria-hidden="true" /></summary>
        <div className="dw-people-secondary__forms">{createTeamForm}{acceptInvitationForm}</div>
      </details>
    </>}
  </div>;
}

function ProjectsPanel({ teamId, sharedProjects, localProject, canManageTeam, busy, perform }: {
  teamId: string; sharedProjects: DistributedRecord[]; localProject?: Project; canManageTeam: boolean; busy: string | null;
  perform: (key: string, success: string, work: () => Promise<unknown>) => Promise<unknown | undefined>;
}) {
  const [name, setName] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [sharedProjectId, setSharedProjectId] = useState('');
  const sharedOptions = sharedProjects.map((project) => ({ value: idOf(project, ['id', 'projectId']), label: nameOf(project, 'Shared project') })).filter((project) => project.value);
  useEffect(() => { if (!sharedProjectId && sharedOptions[0]) setSharedProjectId(sharedOptions[0].value); }, [sharedProjectId, sharedOptions]);
  return <div className="distributed__panel">
    <div className="distributed__grid distributed__grid--forms">
      <form className="dw-card" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!teamId || !canManageTeam) return; void perform('create-project', 'Shared project created. No local repository was uploaded.', () => distributedApi.createProject({ teamId, name: name.trim(), ...(repositoryUrl.trim() ? { repositoryUrl: repositoryUrl.trim() } : {}) })); setName(''); setRepositoryUrl(''); }}>
        <div className="dw-card__heading"><span><GitBranch size={15} /></span><div><h3>Create shared project</h3><p>Creates a team record; it does not copy files or push Git.</p></div></div>
        <TextControl label="Project name" value={name} onChange={setName} required maxLength={120} placeholder="Web refresh" />
        <TextControl label="Repository URL (optional)" value={repositoryUrl} onChange={setRepositoryUrl} placeholder="https://host/org/repository" />
        <Button type="submit" size="sm" disabled={Boolean(busy) || !teamId || !name.trim() || !canManageTeam} why={!canManageTeam ? 'Only a team owner or admin can create shared projects.' : undefined} busy={busy === 'create-project'}>Create shared project</Button>
      </form>
      <form className="dw-card" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!teamId || !sharedProjectId || !localProject) return; void perform('bind-project', 'Project binding saved on this device.', () => distributedApi.bindProject({ teamId, sharedProjectId, localProjectId: localProject.id })); }}>
        <div className="dw-card__heading"><span><ArrowLeftRight size={15} /></span><div><h3>Bind this device’s project</h3><p>Binding is a local mapping. It does not send repository contents.</p></div></div>
        <SelectControl label="Shared project" value={sharedProjectId} onChange={setSharedProjectId} options={sharedOptions} disabled={!sharedOptions.length} />
        <div className="dw-local-device"><div className="dw-icon"><Laptop size={15} /></div><div><strong>Current local project</strong><span>{localProject ? `${localProject.name}${localProject.isExample ? ' · Example workspace' : ''} · ${localProject.path}` : 'No local project is selected.'}</span></div></div>
        <Button type="submit" size="sm" disabled={Boolean(busy) || !teamId || !sharedProjectId || !localProject} busy={busy === 'bind-project'}>Bind current project</Button>
      </form>
    </div>
    <div className="dw-section-head"><div><h3>Shared projects</h3><p>Repository content stays on each device unless you request a separately approved Git transfer.</p></div><Badge>{sharedProjects.length} listed</Badge></div>
    {sharedProjects.length ? <div className="dw-list">{sharedProjects.map((row, index) => <article className="dw-row" key={idOf(row, ['id', 'projectId']) || `project-${index}`}><span className="dw-icon"><GitBranch size={15} /></span><div className="dw-row__main"><strong>{nameOf(row, 'Shared project')}</strong><span>{text(row, ['repositoryUrl', 'repository'], 'No repository URL reported')} · {text(row, ['localProjectId', 'bindingStatus'], 'Binding status unknown')}</span></div><Badge tone={readText(row, ['localProjectId', 'boundDeviceId']) ? 'ok' : 'neutral'}>{readText(row, ['bindingStatus']) || (readText(row, ['localProjectId', 'boundDeviceId']) ? 'Bound here' : 'Not bound here')}</Badge></article>)}</div> : <p className="dw-empty">No shared projects are listed yet.</p>}
  </div>;
}

function DevicesPanel({ teamId, localDevice, devices, links, busy, result, perform }: {
  teamId: string; localDevice: DistributedRecord; devices: DistributedRecord[]; links: DistributedRecord[]; busy: string | null; result: unknown;
  perform: (key: string, success: string, work: () => Promise<unknown>) => Promise<unknown | undefined>;
}) {
  const [deviceName, setDeviceName] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const registeredFingerprint = readText(unwrap(result, 'device'), ['fingerprint', 'deviceFingerprint']);
  return <div className="distributed__panel">
    <div className="distributed__grid distributed__grid--forms">
      <form className="dw-card" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!teamId) return; void perform('register-device', 'Device registered. Verify its fingerprint with the other device before linking.', () => distributedApi.registerDevice({ teamId, name: deviceName.trim() })); setDeviceName(''); }}>
        <div className="dw-card__heading"><span><Laptop size={15} /></span><div><h3>Register this device</h3><p>Registration alone creates no peer trust or remote execution.</p></div></div>
        <TextControl label="Device name" value={deviceName} onChange={setDeviceName} required maxLength={100} placeholder="Studio laptop" />
        <Button type="submit" size="sm" disabled={Boolean(busy) || !teamId || !deviceName.trim()} busy={busy === 'register-device'}>Register device</Button>
        {registeredFingerprint ? <div className="dw-secret" role="status"><strong>New device fingerprint</strong><code>{registeredFingerprint}</code><small>Compare this fingerprint with the intended peer through a trusted channel.</small></div> : null}
      </form>
      <form className="dw-card" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!teamId) return; void perform('link-device', 'Fingerprint link requested. Delivery requires a reciprocal trust pin.', () => distributedApi.linkDevice({ teamId, deviceId: deviceId.trim(), fingerprint: fingerprint.trim() })); }}>
        <div className="dw-card__heading"><span><LockKeyhole size={15} /></span><div><h3>Verify and link a peer</h3><p>Enter the exact fingerprint confirmed with the device owner.</p></div></div>
        <TextControl label="Peer device ID" value={deviceId} onChange={setDeviceId} required placeholder="Device ID" />
        <TextControl label="Verified fingerprint" value={fingerprint} onChange={setFingerprint} required placeholder="Fingerprint shown on the peer" />
        <Button type="submit" size="sm" disabled={Boolean(busy) || !teamId || !deviceId.trim() || !fingerprint.trim()} busy={busy === 'link-device'}>Link verified device</Button>
      </form>
    </div>
    <div className="dw-local-device"><div className="dw-icon"><Laptop size={16} /></div><div><strong>This device</strong><span>{nameOf(localDevice, 'No local device registration reported')} · fingerprint {readText(localDevice, ['fingerprint'], 'not reported')}</span></div><Badge tone={displayStatus(localDevice).tone}>{displayStatus(localDevice).label}</Badge></div>
    <div className="dw-section-head"><div><h3>Devices on this team</h3><p>Presence is shown only when the transport reports it.</p></div><Badge>{devices.length}</Badge></div>
    {devices.length ? <div className="dw-list">{devices.map((raw, index) => {
      const row = unwrap(raw, 'device');
      const id = idOf(row, ['id', 'deviceId']);
      const state = displayStatus(row);
      const fingerprintValue = readText(row, ['fingerprint'], 'Fingerprint not reported');
      const localId = idOf(localDevice, ['id', 'deviceId']);
      const localOwnerId = readText(localDevice, ['ownerId']);
      const ownedByLocalAccount = Boolean(localOwnerId && readText(row, ['ownerId']) === localOwnerId);
      const linked = links.some((link) => link.deviceId === localId && link.peerDeviceId === id && link.mutual === true);
      const actionLabel = ownedByLocalAccount ? 'Revoke device' : 'Unlink device';
      const actionMessage = ownedByLocalAccount
        ? `Revoke ${nameOf(row, 'this device')}? It will no longer receive future team messages.`
        : `Unlink ${nameOf(row, 'this peer')} from this device? Future messages will no longer be delivered across this trust link.`;
      const actionNotice = ownedByLocalAccount ? 'Device revoked. Future delivery to this device is disabled.' : 'Device link removed. Future messages will not be sent to that peer.';
      return <article className="dw-row dw-row--device" key={id || `device-${index}`}><span className="dw-icon"><Laptop size={15} /></span><div className="dw-row__main"><strong>{nameOf(row, 'Unnamed device')}</strong><span>ID {id || 'not reported'} · {fingerprintValue} · owner {text(row, ['ownerName', 'ownerEmail', 'ownerId'], 'not reported')} · last seen {text(row, ['lastSeenAt', 'last_seen_at'], 'not reported')}</span></div><Badge tone={state.tone}>{state.label}</Badge><Badge tone={linked ? 'ok' : 'neutral'}>{linked ? 'Linked' : 'Not linked'}</Badge>{id && id !== localId && localOwnerId ? <Button size="sm" variant="danger" disabled={Boolean(busy)} onClick={() => { if (window.confirm(actionMessage)) void perform(`revoke-device:${id}`, actionNotice, () => distributedApi.revokeDevice({ teamId, deviceId: id })); }}>{actionLabel}</Button> : null}</article>;
    })}</div> : <p className="dw-empty">No registered devices were reported.</p>}
  </div>;
}

function AgentsPanel({ teamId, sharedProjects, localProject, localSessions, agents, devices, tasks, members, busy, perform }: {
  teamId: string; sharedProjects: DistributedRecord[]; localProject?: Project; localSessions: Session[]; agents: DistributedRecord[]; devices: DistributedRecord[]; tasks: DistributedRecord[]; members: DistributedRecord[]; busy: string | null;
  perform: (key: string, success: string, work: () => Promise<unknown>) => Promise<unknown | undefined>;
}) {
  const options = sharedProjects.map((row) => ({ value: idOf(row, ['id', 'projectId']), label: nameOf(row, 'Shared project') })).filter((item) => item.value);
  const [projectId, setProjectId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const publishableSessions = localSessions.filter((session) => session.projectId === localProject?.id && ['codex', 'claude', 'opencode'].includes(session.provider));
  useEffect(() => { if (!projectId && options[0]) setProjectId(options[0].value); }, [projectId, options]);
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  return <div className="distributed__panel">
    <div className="dw-card dw-card--wide">
      <div className="dw-card__heading"><span><Workflow size={15} /></span><div><h3>Publish selected local sessions</h3><p>Only the sessions you check are added to the shared roster. Runs from teammates follow the team permission level. Publishing never runs or transfers a conversation.</p></div></div>
      <div className="dw-form-row"><SelectControl label="Shared project" value={projectId} onChange={setProjectId} options={options} disabled={!options.length} /><div className="dw-form-actions"><Button size="sm" disabled={Boolean(busy) || !teamId || !projectId || !selected.some((id) => publishableSessions.some((session) => session.id === id))} busy={busy === 'publish-agents'} onClick={() => void perform('publish-agents', 'Selected agents published to the shared roster.', () => distributedApi.publishAgents({ teamId, sharedProjectId: projectId, sessionIds: selected.filter((id) => publishableSessions.some((session) => session.id === id)) }))}>Publish {selected.filter((id) => publishableSessions.some((session) => session.id === id)).length || ''} selected</Button><Button size="sm" disabled={Boolean(busy) || !teamId || !projectId} onClick={() => void perform('unpublish-agents', 'This device’s agents are no longer shared for this project.', () => distributedApi.publishAgents({ teamId, sharedProjectId: projectId, sessionIds: [] }))}>Stop sharing</Button><span>Current project: {localProject?.name ?? 'none selected'}</span></div></div>
      <div className="dw-session-picks">{publishableSessions.map((session) => <label key={session.id} className="dw-session-pick"><input type="checkbox" checked={selected.includes(session.id)} onChange={() => toggle(session.id)} /><span><strong>{session.name}</strong><small>{session.provider} · {session.model} · {session.status}</small></span><Badge>{session.isolated ? 'Worktree' : 'Project folder'}</Badge></label>)}</div>
      {!publishableSessions.length ? <p className="dw-empty">There are no sessions in the current local project to publish.</p> : null}
    </div>
    <div className="dw-section-head"><div><h3>Remote agent roster</h3><p>Remote usage, availability and quota are not inferred from provider configuration.</p></div><Badge>{agents.length} listed</Badge></div>
    {agents.length ? <div className="dw-agent-grid">{agents.map((raw, index) => {
      const agent = unwrap(raw, 'agent');
      const deviceId = readText(agent, ['deviceId', 'ownerDeviceId']);
      const device = devices.map((item) => unwrap(item, 'device')).find((item) => idOf(item, ['id', 'deviceId']) === deviceId);
      const status = displayStatus(agent, ['presence']);
      const quotaState = readText(agent, ['quotaState'], 'unknown');
      const quotaLabel = quotaState === 'available' ? 'Available' : quotaState === 'exhausted' ? 'Exhausted' : 'Unknown';
      const quotaTone = quotaState === 'available' ? 'ok' : quotaState === 'exhausted' ? 'warn' : 'neutral';
      return <article className="dw-agent" key={idOf(agent, ['id', 'agentId']) || `agent-${index}`}><div className="dw-agent__top"><span className="dw-icon"><Workflow size={16} /></span><Badge tone={status.tone}>{status.label}</Badge></div><strong>{nameOf(agent, 'Remote agent')}</strong><span>{text(agent, ['provider'], 'Provider unknown')} · {text(agent, ['model'], 'Model unknown')}</span><span>{device ? nameOf(device, 'Device') : text(agent, ['deviceId'], 'Device not reported')}</span><dl><div><dt>Quota</dt><dd><Badge tone={quotaTone}>{quotaLabel}</Badge></dd></div><div><dt>Project</dt><dd>{text(agent, ['sharedProjectId'], 'Not reported')}</dd></div><div><dt>Policy</dt><dd>{text(agent, ['policy'], 'Not reported')}</dd></div><div><dt>Shared group</dt><dd>{text(agent, ['activeGroupId'], 'Not grouped')}</dd></div></dl><small>{text(agent, ['quotaReason'], 'Quota details are not reported.')} Owner approval is required for each request.</small></article>;
    })}</div> : <p className="dw-empty">No remote agents are published for this team snapshot.</p>}
    <SharedAgentMap members={members} devices={devices} agents={agents} tasks={tasks} />
    <section className="dw-card"><div className="dw-section-head"><div><h3>Shared task relationships</h3><p>Only recorded device, agent, group and dependency identifiers are shown.</p></div><Badge>{tasks.length} tasks</Badge></div>{tasks.length ? <div className="dw-list dw-list--compact">{tasks.map((task, index) => { const groupId = readText(task, ['groupId']); const dependencyIds = readValue(task, ['dependsOn']); const dependencies = Array.isArray(dependencyIds) ? dependencyIds.map(String) : []; const taskAgent = readText(task, ['agentId']) ? agents.find((agent) => idOf(unwrap(agent, 'agent'), ['id', 'agentId']) === readText(task, ['agentId'])) : undefined; return <article className="dw-row" key={taskRecordKey(task, index)}><span className="dw-icon"><Workflow size={14} /></span><div className="dw-row__main"><strong>{nameOf(task, 'Shared task')}</strong><span>Group {groupId || 'not assigned'} · agent {taskAgent ? nameOf(unwrap(taskAgent, 'agent'), 'Agent') : readText(task, ['agentId'], 'unassigned')} · depends on {dependencies.length ? dependencies.join(', ') : 'none'}</span></div><Badge>{text(task, ['status'], 'Status unknown')}</Badge></article>; })}</div> : <p className="dw-empty">No shared task relationships are reported.</p>}</section>
  </div>;
}

function ConversationPanel({ teamId, sharedProjects, localTasks, messages, tasks, timeline, busy, perform }: {
  teamId: string; sharedProjects: DistributedRecord[]; localTasks: Task[]; messages: DistributedRecord[]; tasks: DistributedRecord[]; timeline: DistributedRecord[]; busy: string | null;
  perform: (key: string, success: string, work: () => Promise<unknown>) => Promise<unknown | undefined>;
}) {
  const [sharedProjectId, setSharedProjectId] = useState('');
  const [message, setMessage] = useState('');
  const [localTaskId, setLocalTaskId] = useState('');
  const options = sharedProjects.map((row) => ({ value: idOf(row, ['id', 'projectId']), label: nameOf(row, 'Shared project') })).filter((item) => item.value);
  useEffect(() => { if (!sharedProjectId && options[0]) setSharedProjectId(options[0].value); }, [sharedProjectId, options]);
  const orderedMessages = [...messages].sort((a, b) => readText(a, ['createdAt', 'timestamp']).localeCompare(readText(b, ['createdAt', 'timestamp'])));
  return <div className="distributed__panel">
    <section className="dw-card dw-conversation" aria-labelledby="dw-conversation-heading">
      <div className="dw-form-row"><SelectControl label="Local task to share" value={localTaskId} onChange={setLocalTaskId} options={localTasks.map((task) => ({ value: task.id, label: task.title }))} /><Button size="sm" disabled={Boolean(busy) || !teamId || !sharedProjectId || !localTaskId} onClick={() => void perform('publish-task', 'Task and dependencies shared.', () => distributedApi.publishTask({ teamId, sharedProjectId, taskId: localTaskId }))}>Share task</Button></div>
      <div className="dw-card__heading"><span><MessageSquare size={15} /></span><div><h3 id="dw-conversation-heading">Shared conversation</h3><p>Messages are team records. Mentioned remote work still needs a separate destination-owner approval.</p></div></div>
      <div className="dw-message-list" aria-live="polite">{orderedMessages.length ? orderedMessages.map((row, index) => <article className="dw-message" key={idOf(row, ['id', 'messageId']) || `message-${index}`}><div><strong>{text(row, ['senderName', 'authorName'], `Device ${text(row, ['deviceId'], 'not reported')} · account ${text(row, ['ownerId'], 'not reported')}`)}</strong><time>{text(row, ['createdAt'], 'Time not reported')}</time></div><p>{text(row, ['content'], 'Message content unavailable')}</p><small>{text(row, ['kind'], 'kind not reported')} · agent {text(row, ['agentId'], 'none')} · group {text(row, ['groupId'], 'none')} · task {text(row, ['taskId'], 'none')}</small></article>) : <p className="dw-empty">No shared conversation messages are present in this snapshot.</p>}</div>
      <form className="dw-message-form" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!teamId || !sharedProjectId || !message.trim()) return; void perform('send-shared-message', 'Message sent to the shared conversation.', () => distributedApi.sendMessage({ teamId, sharedProjectId, content: message.trim(), idempotencyKey: createIdempotencyKey() })).then((response) => { if (response !== undefined) setMessage(''); }); }}>
        <SelectControl label="Project context" value={sharedProjectId} onChange={setSharedProjectId} options={options} disabled={!options.length} />
        <label className="dw-field"><span>Message</span><textarea className="input" value={message} rows={3} maxLength={20_000} placeholder="Share a note with the team…" onChange={(event) => setMessage(event.target.value)} /></label>
        <Button type="submit" size="sm" disabled={Boolean(busy) || !teamId || !sharedProjectId || !message.trim()} busy={busy === 'send-shared-message'}><Send size={13} /> Send message</Button>
      </form>
    </section>
    <div className="distributed__grid distributed__grid--split">
      <section className="dw-card"><div className="dw-section-head"><div><h3>Shared tasks</h3><p>Progress reflects task state reported by the execution service.</p></div><Badge>{tasks.length}</Badge></div>{tasks.length ? <div className="dw-list dw-list--compact">{tasks.map((row, index) => <article className="dw-row" key={taskRecordKey(row, index)}><div className="dw-row__main"><strong>{nameOf(row, 'Task')}</strong><span>{text(row, ['description'], 'No task description reported')} · Acceptance: {text(row, ['acceptanceCriteria'], 'Not reported')} · Dependencies: {exactList(readValue(row, ['dependsOn']))} · group {text(row, ['groupId'], 'none')}</span></div><Badge tone={displayStatus(row, ['status']).tone}>{text(row, ['status'], 'Status unknown')}</Badge></article>)}</div> : <p className="dw-empty">No shared tasks are listed.</p>}</section>
      <section className="dw-card"><div className="dw-section-head"><div><h3>Progress & results</h3><p>Recorded deliveries and outcomes only.</p></div><Badge>{timeline.length}</Badge></div>{timeline.length ? <div className="dw-timeline">{timeline.map((row, index) => <article key={idOf(row, ['id', 'deliveryId', 'eventId']) || `event-${index}`}><i aria-hidden="true" /><div><strong>{text(row, ['title', 'kind', 'type', 'status'], 'Recorded event')}</strong><p>{text(row, ['summary', 'message', 'result', 'detail'], 'No detail reported')}</p><small>{text(row, ['createdAt', 'timestamp', 'updatedAt'], 'Time not reported')}</small></div></article>)}</div> : <p className="dw-empty">No progress events or result summaries are reported yet.</p>}</section>
    </div>
  </div>;
}

function ApprovalDisclosure({ row, category }: { row: unknown; category: 'execution' | 'git' | 'command' }) {
  const target = asRecord(readValue(row, ['agent', 'targetAgent', 'destinationAgent'])) ?? {};
  const destination = asRecord(readValue(row, ['device', 'destinationDevice', 'targetDevice'])) ?? {};
  const projectData = asRecord(readValue(row, ['project', 'sharedProject'])) ?? {};
  const taskData = asRecord(readValue(row, ['task', 'sharedTask'])) ?? {};
  const device = readText(row, ['destinationDeviceName', 'toDeviceName', 'deviceName', 'targetDeviceId', 'toDeviceId', 'deviceId']) || readText(destination, ['name', 'id', 'deviceId'], 'Device not reported');
  const project = readText(row, ['projectName', 'sharedProjectName', 'projectId', 'sharedProjectId']) || readText(projectData, ['name', 'id', 'projectId'], 'Project not reported');
  const provider = readText(row, ['provider']) || readText(asRecord(readValue(row, ['targetAgent', 'agent'])), ['provider'], 'Provider unknown');
  const model = readText(row, ['model']) || readText(target, ['model'], 'Model unknown');
  const quotaState = readText(row, ['quotaState']) || readText(target, ['quotaState'], 'unknown');
  const quotaReason = readText(row, ['quotaReason']) || readText(target, ['quotaReason']);
  const quota = `${quotaState === 'available' ? 'Available (reported)' : quotaState === 'exhausted' ? 'Exhausted (reported)' : 'Unknown'}${quotaReason ? ` · ${quotaReason}` : ''}`;
  const task = readText(row, ['taskTitle', 'taskName', 'taskId']) || readText(taskData, ['title', 'name', 'id', 'taskId'], 'No task linked');
  const operationData = asRecord(readValue(row, ['operation'])) ?? {};
  const operation = readText(row, ['operation', 'kind', 'action', 'mode']) || readText(operationData, ['kind'], category === 'command' ? 'Structured Git read' : category === 'git' ? 'Git transfer' : 'Remote execution');
  const refs = readValue(row, ['refs', 'commitRefs', 'commits']) ?? [readText(row, ['sourceHead']), readText(row, ['baseHead'])].filter(Boolean);
  const branchValue = readText(row, ['branch', 'targetBranch'], 'Not reported');
  const purpose = readText(row, ['purpose', 'note', 'instructions', 'content', 'description'], 'Not reported');
  const taskDetails = `${readText(taskData, ['description'], '')}${readText(taskData, ['acceptanceCriteria']) ? ` · Acceptance: ${readText(taskData, ['acceptanceCriteria'])}` : ''}` || 'Not reported';
  const recovery = asRecord(readValue(row, ['evidence'])) ?? {};
  return <><div className="dw-disclosures"><Disclosure title="Destination device" value={device} /><Disclosure title="Provider / model" value={`${provider} / ${model}`} /><Disclosure title="Quota state" value={quota} /><Disclosure title="Task" value={task} /><Disclosure title="Project" value={project} /><Disclosure title="Operation" value={operation} />{category === 'execution' ? <><Disclosure title="Destination owner" value={readText(row, ['targetOwnerId'], 'Not reported')} /><Disclosure title="Request digest" value={readText(row, ['digest'], 'Not reported')} /></> : null}</div>{category === 'execution' ? <div className="dw-exact-scope"><Disclosure title="Task description & acceptance" value={taskDetails} /><Disclosure title="Dependencies" value={exactList(readValue(taskData, ['dependsOn']))} /><Disclosure title="Group" value={readText(taskData, ['groupId']) || readText(row, ['groupId'], 'None')} /><Disclosure title="Request content" value={readText(row, ['content'], purpose)} /><Disclosure title="Source checkpoint commit" value={readText(asRecord(recovery.worktree), ['head'], 'Not reported')} /><Disclosure title="Committed artifact references" value={Array.isArray(recovery.committedReferences) ? recovery.committedReferences.map((item) => `${readText(item, ['revision'])} · ${readText(item, ['path'])}`).join('; ') || 'None' : 'Not reported'} /><Disclosure title="Recorded recovery evidence" value={`${readText(recovery, ['failureKind'], 'Not reported')}${readText(recovery, ['failureMessage']) ? ` · ${readText(recovery, ['failureMessage'])}` : ''}${readText(recovery, ['objective']) ? ` · ${readText(recovery, ['objective'])}` : ''}`} /></div> : null}{category === 'git' ? <div className="dw-exact-scope"><Disclosure title="Target branch" value={branchValue} /><Disclosure title="Source / base heads" value={exactList(refs)} /><Disclosure title="Bundle digest" value={readText(row, ['bundleSha256'], 'Not reported')} /><Disclosure title="Action / remote" value={`${readText(row, ['action'], 'Transfer')} / ${readText(row, ['remoteName'], 'None')}`} /><Disclosure title="Expected local HEAD" value={readText(row, ['expectedHead'], 'Not reported')} /><Disclosure title="Repository fingerprint" value={readText(row, ['expectedFingerprint'], 'Not reported')} /><Disclosure title="Request digest" value={readText(row, ['requestDigest'], 'Not reported')} /><Disclosure title="Reason" value={purpose} /></div> : null}{category === 'command' ? <div className="dw-exact-scope"><Disclosure title="Structured operation" value={readText(operationData, ['kind'], 'Not reported')} /><Disclosure title="Operation parameters" value={Object.keys(operationData).length ? JSON.stringify(operationData) : 'Not reported'} /><Disclosure title="Project-relative directory" value={readText(row, ['cwd'], '.')} /></div> : null}</>;
}

function OwnerDecision({ row, id, category, busy, checkedApprovals, setCheckedApprovals, shareProgress, setShareProgress, allowProviderSpend, setAllowProviderSpend, allowUnverifiedQuota, setAllowUnverifiedQuota, onDecision }: {
  row: DistributedRecord; id: string; category: 'execution' | 'git' | 'command'; busy: string | null; checkedApprovals: Record<string, boolean>; setCheckedApprovals: (value: (current: Record<string, boolean>) => Record<string, boolean>) => void;
  shareProgress?: Record<string, boolean>; setShareProgress?: (value: (current: Record<string, boolean>) => Record<string, boolean>) => void;
  allowProviderSpend?: Record<string, boolean>; setAllowProviderSpend?: (value: (current: Record<string, boolean>) => Record<string, boolean>) => void;
  allowUnverifiedQuota?: Record<string, boolean>; setAllowUnverifiedQuota?: (value: (current: Record<string, boolean>) => Record<string, boolean>) => void;
  onDecision: (decision: 'approved' | 'denied') => void;
}) {
  const state = readText(row, ['state', 'status']);
  const pending = category === 'execution' ? state === 'awaiting-approval' : category === 'git' ? (state === 'awaiting-destination-approval' || state === 'awaiting-source-approval') : state === 'awaiting-approval';
  const digest = readText(row, ['digest', 'requestDigest']);
  const digestValid = /^[a-f0-9]{64}$/i.test(digest);
  const provider = readText(row, ['provider']) || readText(asRecord(readValue(row, ['targetAgent', 'agent'])), ['provider']);
  const quotaState = readText(row, ['quotaState'], 'unknown');
  const needsUnverifiedQuota = category === 'execution' && (quotaState === 'unknown' || provider === 'opencode');
  const phrase = category === 'execution' ? `I reviewed the destination, model, quota, task, project and operation above for request ${id}.` : `I reviewed the exact ${category === 'git' ? 'Git action, revisions, remote and bundle' : 'command and directory'}, project and digest above for request ${id}.`;
  return <article className="dw-approval">
    <div className="dw-approval__head"><div><strong>{text(row, ['title', 'summary', 'requestType'], category === 'execution' ? 'Remote execution request' : category === 'git' ? 'Git transfer request' : 'Command request')}</strong><span>{text(row, ['requesterName', 'fromDeviceName', 'sourceDeviceName', 'requester'], 'Requester not reported')} · {text(row, ['createdAt', 'timestamp'], 'Time not reported')}</span></div><Badge tone={pending ? 'warn' : 'neutral'}>{text(row, ['status', 'state'], 'Decision state unknown')}</Badge></div>
    <ApprovalDisclosure row={row} category={category} />
    {pending ? <>
      <p className="dw-owner-note"><Shield size={13} /> This decision belongs to the local device owner. Remote execution and imports require the receiving owner; source transfers and integration require this repository’s owner.</p>
      {category === 'execution' ? <div className="dw-execution-consents">
        <label className="dw-ack"><input type="checkbox" checked={Boolean(shareProgress?.[id])} onChange={(event) => setShareProgress?.((current) => ({ ...current, [id]: event.target.checked }))} /><span>Share this device’s live progress and results with the team. Off by default.</span></label>
        <label className="dw-ack"><input type="checkbox" checked={Boolean(allowProviderSpend?.[id])} onChange={(event) => setAllowProviderSpend?.((current) => ({ ...current, [id]: event.target.checked }))} /><span>Allow this provider run to use this device’s provider account. Provider charges may apply; Mingle cannot guarantee a dollar cap.</span></label>
        {needsUnverifiedQuota ? <label className="dw-ack dw-ack--warning"><input type="checkbox" checked={Boolean(allowUnverifiedQuota?.[id])} onChange={(event) => setAllowUnverifiedQuota?.((current) => ({ ...current, [id]: event.target.checked }))} /><span>Allow one run without verified quota data. {provider === 'opencode' ? 'OpenCode does not report native quota here, so availability remains unknown.' : 'Quota is unknown; this does not mean quota is available.'}</span></label> : null}
      </div> : null}
      <label className="dw-ack"><input type="checkbox" checked={Boolean(checkedApprovals[id])} onChange={(event) => setCheckedApprovals((current) => ({ ...current, [id]: event.target.checked }))} /><span>{phrase}</span></label>
      {!digestValid ? <p className="dw-owner-note dw-owner-note--warning">A valid displayed request digest is missing; refresh this snapshot before making a decision. The UI will not fetch a replacement digest on submit.</p> : null}
      <div className="dw-row-actions"><Button size="sm" variant="danger" disabled={Boolean(busy) || !digestValid} onClick={() => onDecision('denied')}>Deny</Button><Button size="sm" variant="primary" disabled={Boolean(busy) || !checkedApprovals[id] || !digestValid || (category === 'execution' && !allowProviderSpend?.[id]) || (category === 'execution' && needsUnverifiedQuota && !allowUnverifiedQuota?.[id])} busy={busy === `${category}-decision:${id}`} onClick={() => onDecision('approved')}>Approve this exact request</Button></div>
    </> : null}
  </article>;
}

function RecoveryPanel({ teamId, sharedProjects, agents, requests, localDeviceId, localSessions, localTasks, runs, busy, checkedApprovals, setCheckedApprovals, shareProgress, setShareProgress, allowProviderSpend, setAllowProviderSpend, allowUnverifiedQuota, setAllowUnverifiedQuota, perform }: {
  teamId: string; sharedProjects: DistributedRecord[]; agents: DistributedRecord[]; requests: DistributedRecord[]; localDeviceId: string; localSessions: Session[]; localTasks: Task[]; runs: { id: string; sessionId: string; status: string }[]; busy: string | null; checkedApprovals: Record<string, boolean>; setCheckedApprovals: (value: (current: Record<string, boolean>) => Record<string, boolean>) => void;
  shareProgress: Record<string, boolean>; setShareProgress: (value: (current: Record<string, boolean>) => Record<string, boolean>) => void;
  allowProviderSpend: Record<string, boolean>; setAllowProviderSpend: (value: (current: Record<string, boolean>) => Record<string, boolean>) => void;
  allowUnverifiedQuota: Record<string, boolean>; setAllowUnverifiedQuota: (value: (current: Record<string, boolean>) => Record<string, boolean>) => void;
  perform: (key: string, success: string, work: () => Promise<unknown>) => Promise<unknown | undefined>;
}) {
  const failed = localSessions.filter((session) => session.status === 'error' || Boolean(session.error) || runs.some((run) => run.sessionId === session.id && run.status === 'failed'));
  const agentOptions = agents.filter((row) => agentDeviceId(row) && agentDeviceId(row) !== localDeviceId).map((row) => ({ value: idOf(unwrap(row, 'agent'), ['id', 'agentId']), label: `${nameOf(unwrap(row, 'agent'), 'Remote agent')} · ${text(row, ['provider'], 'provider unknown')} / ${text(row, ['model'], 'model unknown')}` })).filter((item) => item.value);
  const projectOptions = sharedProjects.map((row) => ({ value: idOf(row, ['id', 'projectId']), label: nameOf(row, 'Shared project') })).filter((item) => item.value);
  const taskOptions = localTasks.filter((task) => task.status !== 'done').map((task) => ({ value: task.id, label: task.title }));
  const [agentId, setAgentId] = useState('');
  const [sharedProjectId, setSharedProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [sourceSessionId, setSourceSessionId] = useState('');
  const [mode, setMode] = useState<'provider-failure' | 'unpublished-recovery'>('unpublished-recovery');
  const [instructions, setInstructions] = useState('');
  const [allowUnverifiedTarget, setAllowUnverifiedTarget] = useState(false);
  const [failureSessionId, setFailureSessionId] = useState('');
  const [fallbackTaskId, setFallbackTaskId] = useState('');
  const [fallbackEligibility, setFallbackEligibility] = useState<unknown>(null);
  const [fallbackCandidateId, setFallbackCandidateId] = useState('');
  const [fallbackRequestContent, setFallbackRequestContent] = useState('');
  useEffect(() => { if (!agentId && agentOptions[0]) setAgentId(agentOptions[0].value); }, [agentId, agentOptions]);
  useEffect(() => { if (!sharedProjectId && projectOptions[0]) setSharedProjectId(projectOptions[0].value); }, [sharedProjectId, projectOptions]);
  useEffect(() => { if (!taskId && taskOptions[0]) setTaskId(taskOptions[0].value); }, [taskId, taskOptions]);
  const failedSessionOptions = failed.map((session) => ({ value: session.id, label: `${session.name} · ${session.status === 'error' ? 'session error' : session.error ? 'recorded error' : 'failed run'}` }));
  const sessionOptions = (mode === 'provider-failure' ? failed : localSessions).map((session) => ({ value: session.id, label: session.name }));
  useEffect(() => { if (!sourceSessionId && sessionOptions[0]) setSourceSessionId(sessionOptions[0].value); else if (sourceSessionId && !sessionOptions.some((option) => option.value === sourceSessionId)) setSourceSessionId(sessionOptions[0]?.value ?? ''); }, [sourceSessionId, mode, localSessions, failed]);
  useEffect(() => { if (!failureSessionId && failedSessionOptions[0]) setFailureSessionId(failedSessionOptions[0].value); }, [failureSessionId, failedSessionOptions]);
  useEffect(() => { if (!fallbackTaskId && taskOptions[0]) setFallbackTaskId(taskOptions[0].value); }, [fallbackTaskId, taskOptions]);
  const pendingRequests = localDeviceId ? requests.filter((request) => request.state === 'awaiting-approval' && request.targetDeviceId === localDeviceId) : [];
  const decorateRequest = (request: DistributedRecord) => {
    const agent = agents.find((candidate) => idOf(unwrap(candidate, 'agent'), ['id', 'agentId']) === readText(request, ['agentId']));
    const targetAgent = unwrap(agent, 'agent');
    return { ...request, targetAgent, provider: readText(targetAgent, ['provider']), model: readText(targetAgent, ['model']), quotaState: readText(targetAgent, ['quotaState'], 'unknown'), quotaKnown: Boolean(readValue(targetAgent, ['quotaKnown'])), quotaReason: readText(targetAgent, ['quotaReason']) };
  };
  const decide = (row: DistributedRecord, decision: 'approved' | 'denied') => {
    const id = idOf(row, ['id', 'requestId']);
    const digest = readText(row, ['digest']);
    if (!id || !/^[a-f0-9]{64}$/i.test(digest)) return;
    void perform(`execution-decision:${id}`, decision === 'approved' ? 'Request approved on this device.' : 'Request denied on this device.', () => distributedApi.decideExecution(id, { decision, expectedDigest: digest, shareProgress: Boolean(shareProgress[id]), allowProviderSpend: decision === 'approved' && Boolean(allowProviderSpend[id]), allowUnverifiedQuota: decision === 'approved' && Boolean(allowUnverifiedQuota[id]) }));
  };
  return <div className="distributed__panel">
    <p className="dw-owner-note dw-owner-note--large"><Shield size={14} /> Local agents stay the default. Remote work is a separate, explicit request. The destination device owner must approve the exact provider, model, quota state, task and project before it runs. Provider spend is not dollar-capped by Mingle.</p>
    <div className="distributed__grid distributed__grid--forms">
      <form className="dw-card" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!teamId || !sharedProjectId || !sourceSessionId || !taskId || !agentId || !instructions.trim()) return; void perform('delegation', 'Remote execution request sent for destination-owner approval.', () => distributedApi.delegation({ teamId, sharedProjectId, sourceSessionId, taskId, agentId, mode, allowUnverifiedTarget, content: instructions.trim(), idempotencyKey: createIdempotencyKey() })); }}>
        <div className="dw-card__heading"><span><Workflow size={15} /></span><div><h3>Request remote recovery</h3><p>Commit and review source edits, transfer the commits through Git sync, and prepare a clean destination session. The selected agent’s owner then approves execution.</p></div></div>
        <SelectControl label="Remote agent" value={agentId} onChange={setAgentId} options={agentOptions} disabled={!agentOptions.length} />
        <SelectControl label="Shared project" value={sharedProjectId} onChange={setSharedProjectId} options={projectOptions} disabled={!projectOptions.length} />
        <SelectControl label="Source local session" value={sourceSessionId} onChange={setSourceSessionId} options={sessionOptions} disabled={!sessionOptions.length} />
        <SelectControl label="Source local task" value={taskId} onChange={setTaskId} options={taskOptions} disabled={!taskOptions.length} />
        <SelectControl label="Reason" value={mode} onChange={(value) => setMode(value as 'provider-failure' | 'unpublished-recovery')} options={[{ value: 'provider-failure', label: 'Recorded provider failure' }, { value: 'unpublished-recovery', label: 'Human-requested unpublished recovery' }]} />
        <label className="dw-ack"><input type="checkbox" checked={allowUnverifiedTarget} onChange={(event) => setAllowUnverifiedTarget(event.target.checked)} /><span>Request review from an agent with unknown quota. The destination owner must separately consent to one unverified attempt; unknown agents are excluded from automatic suggestions.</span></label>
        <label className="dw-field"><span>Work request</span><textarea className="input" rows={3} value={instructions} maxLength={10_000} required onChange={(event) => setInstructions(event.target.value)} placeholder="Describe the exact task for the selected remote agent" /></label>
        <Button type="submit" size="sm" disabled={Boolean(busy) || !teamId || !sharedProjectId || !sourceSessionId || !taskId || !agentId || !instructions.trim()} busy={busy === 'delegation'}>Send approval request</Button>
      </form>
      <section className="dw-card">
        <div className="dw-card__heading"><span><CircleHelp size={15} /></span><div><h3>Check recovery eligibility</h3><p>Only recorded local failures can request candidates. This check does not create a delegation.</p></div></div>
        {failed.length ? <>
          <SelectControl label="Recorded local failure" value={failureSessionId} onChange={setFailureSessionId} options={failedSessionOptions} />
          <SelectControl label="Source local task" value={fallbackTaskId} onChange={setFallbackTaskId} options={taskOptions} disabled={!taskOptions.length} />
          <SelectControl label="Shared project" value={sharedProjectId} onChange={setSharedProjectId} options={projectOptions} disabled={!projectOptions.length} />
          <Button size="sm" disabled={Boolean(busy) || !teamId || !sharedProjectId || !failureSessionId || !fallbackTaskId} busy={busy === 'fallback-check'} onClick={() => { setFallbackEligibility(null); setFallbackCandidateId(''); void perform('fallback-check', 'Recovery eligibility refreshed.', () => distributedApi.suggestFallback({ teamId, sharedProjectId, sourceSessionId: failureSessionId, taskId: fallbackTaskId })).then((response) => setFallbackEligibility(response ?? null)); }}>Check eligible agents</Button>
          {fallbackEligibility ? <FallbackCandidates response={fallbackEligibility} agents={agents} candidateId={fallbackCandidateId} setCandidateId={setFallbackCandidateId} /> : null}
          {fallbackEligibility ? <>
            <TextControl label="Recovery request for the destination owner" value={fallbackRequestContent} onChange={setFallbackRequestContent} required placeholder="Describe what should be recovered" />
            <Button size="sm" disabled={Boolean(busy) || !teamId || !sharedProjectId || !failureSessionId || !fallbackTaskId || !fallbackCandidateId || !fallbackRequestContent.trim() || !fallbackHasEligibleCandidate(fallbackEligibility)} busy={busy === 'fallback-delegation'} onClick={() => { if (!fallbackHasEligibleCandidate(fallbackEligibility)) return; void perform('fallback-delegation', 'Recovery request sent for destination-owner approval.', () => distributedApi.delegation({ teamId, sharedProjectId, sourceSessionId: failureSessionId, taskId: fallbackTaskId, agentId: fallbackCandidateId, mode: 'provider-failure', content: fallbackRequestContent.trim(), idempotencyKey: createIdempotencyKey() })); }}>Request this fallback</Button>
          </> : null}
        </> : <p className="dw-empty">No failed local session or run is recorded. A fallback eligibility check is unavailable.</p>}
      </section>
    </div>
    <div className="dw-section-head"><div><h3>Destination-owner approvals</h3><p>Only requests awaiting approval on this device are actionable here.</p></div><Badge>{pendingRequests.length}</Badge></div>
    {pendingRequests.length ? <div className="dw-approval-list">{pendingRequests.map((raw, index) => {
      const row = decorateRequest(raw);
      const id = idOf(row, ['id', 'requestId']) || `approval-${index}`;
      return <OwnerDecision key={id} row={row} id={id} category="execution" busy={busy} checkedApprovals={checkedApprovals} setCheckedApprovals={setCheckedApprovals} shareProgress={shareProgress} setShareProgress={setShareProgress} allowProviderSpend={allowProviderSpend} setAllowProviderSpend={setAllowProviderSpend} allowUnverifiedQuota={allowUnverifiedQuota} setAllowUnverifiedQuota={setAllowUnverifiedQuota} onDecision={(decision) => decide(row, decision)} />;
    })}</div> : <p className="dw-empty">No execution approvals are reported in this snapshot.</p>}
  </div>;
}

function fallbackHasEligibleCandidate(response: unknown): boolean {
  const section = asRecord(readValue(response, ['eligibility'])) ?? asRecord(response) ?? {};
  return readValue(section, ['eligible']) === true;
}

function FallbackCandidates({ response, agents, candidateId, setCandidateId }: { response: unknown; agents: DistributedRecord[]; candidateId: string; setCandidateId: (id: string) => void }) {
  const section = asRecord(readValue(response, ['eligibility'])) ?? asRecord(response) ?? {};
  const candidates = readList(section, ['candidates', 'eligibleAgents']);
  const eligible = readValue(section, ['eligible']) === true;
  const reason = readText(section, ['reason', 'message', 'notice']);
  const options = candidates.map((candidate) => {
    const candidateAgent = unwrap(candidate, 'agent');
    const candidateId = idOf(candidateAgent, ['agentId', 'id']) || idOf(candidate, ['agentId', 'id']);
    const roster = agents.find((row) => idOf(unwrap(row, 'agent'), ['id', 'agentId']) === candidateId);
    const agent = roster ? unwrap(roster, 'agent') : candidateAgent;
    const quotaState = readText(agent, ['quotaState']) || readText(candidate, ['quotaState'], 'unknown');
    if (quotaState !== 'available') return null;
    return { value: candidateId, label: `${nameOf(agent, nameOf(candidate, 'Eligible agent'))} · ${text(agent, ['provider'], 'provider unknown')} / ${text(agent, ['model'], 'model unknown')} · Quota available (reported)` };
  }).filter((option): option is { value: string; label: string } => Boolean(option?.value));
  if (!eligible) return <p className="dw-empty" role="status">Recovery is not eligible{reason ? `: ${reason}` : '.'}</p>;
  if (!options.length) return <p className="dw-empty" role="status">No candidates with reported available quota are returned. Unknown quota is not treated as available.</p>;
  return <><p className="dw-owner-note" role="status">Eligibility check only; the service reported these candidates. No remote run has been queued.</p><SelectControl label="Eligible fallback agent" value={candidateId} onChange={setCandidateId} options={options} /></>;
}

function TransfersPanel({ teamId, localDeviceId, sharedProjects, devices, gitRequests, gitAudit, commandRequests, commandAudit, busy, checkedApprovals, setCheckedApprovals, perform }: {
  teamId: string; localDeviceId: string; sharedProjects: DistributedRecord[]; devices: { value: string; label: string }[]; gitRequests: DistributedRecord[]; gitAudit: DistributedRecord[]; commandRequests: DistributedRecord[]; commandAudit: DistributedRecord[]; busy: string | null; checkedApprovals: Record<string, boolean>; setCheckedApprovals: (value: (current: Record<string, boolean>) => Record<string, boolean>) => void;
  perform: (key: string, success: string, work: () => Promise<unknown>) => Promise<unknown | undefined>;
}) {
  const projectOptions = sharedProjects.map((row) => ({ value: idOf(row, ['id', 'projectId']), label: nameOf(row, 'Shared project') })).filter((item) => item.value);
  const [projectId, setProjectId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [expectedHead, setExpectedHead] = useState('');
  const [baseHead, setBaseHead] = useState('');
  const [branch, setBranch] = useState('');
  const [commandKind, setCommandKind] = useState('git.status');
  const [cwd, setCwd] = useState('.');
  const [logLimit, setLogLimit] = useState('10');
  const [commit, setCommit] = useState('');
  const [diffBase, setDiffBase] = useState('');
  const [diffHead, setDiffHead] = useState('');
  const [integrationAction, setIntegrationAction] = useState<Record<string, 'merge' | 'push'>>({});
  const [remoteNames, setRemoteNames] = useState<Record<string, string>>({});
  useEffect(() => { if (!projectId && projectOptions[0]) setProjectId(projectOptions[0].value); }, [projectId, projectOptions]);
  useEffect(() => { if (!deviceId && devices[0]) setDeviceId(devices[0].value); }, [deviceId, devices]);
  const pendingGit = gitRequests.filter((row) => {
    if (row.direction === 'incoming' && row.status === 'awaiting-destination-approval') return belongsToLocalDevice(row, localDeviceId, 'destination');
    if ((row.direction === 'outgoing' || row.direction === 'local') && row.status === 'awaiting-source-approval') return belongsToLocalDevice(row, localDeviceId, 'source');
    return false;
  });
  const pendingCommands = commandRequests.filter((row) => row.direction === 'incoming' && row.status === 'awaiting-approval' && belongsToLocalDevice(row, localDeviceId, 'destination'));
  const integrationRequests = gitRequests.filter((row) => row.direction === 'incoming' && row.kind === 'transfer' && row.status === 'imported' && belongsToLocalDevice(row, localDeviceId, 'destination'));
  const decide = (kind: 'git' | 'command', row: DistributedRecord, value: 'approved' | 'denied') => {
    const id = idOf(row, ['id', 'requestId']);
    const digest = readText(row, ['requestDigest']);
    if (!id || !/^[a-f0-9]{64}$/i.test(digest)) return;
    const input = { decision: value, expectedDigest: digest } as const;
    void perform(`${kind}-decision:${id}`, value === 'approved' ? `${kind === 'git' ? 'Git' : 'Command'} request approved by this device owner.` : `${kind === 'git' ? 'Git' : 'Command'} request denied.`, () => kind === 'git' ? distributedApi.decideGit(id, input) : distributedApi.decideCommand(id, input));
  };
  const makeCommand = () => {
    if (commandKind === 'git.version' || commandKind === 'git.status' || commandKind === 'git.head' || commandKind === 'git.branch') return { kind: commandKind } as const;
    if (commandKind === 'git.log') return { kind: 'git.log' as const, limit: Number(logLimit) };
    if (commandKind === 'git.showStat') return { kind: 'git.showStat' as const, commit: commit.trim() };
    return { kind: 'git.diffStat' as const, base: diffBase.trim(), head: diffHead.trim() };
  };
  const validObjectId = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.trim());
  const commandFieldsValid = commandKind === 'git.showStat' ? validObjectId(commit) : commandKind === 'git.diffStat' ? validObjectId(diffBase) && validObjectId(diffHead) : commandKind === 'git.log' ? Number.isInteger(Number(logLimit)) && Number(logLimit) >= 1 && Number(logLimit) <= 50 : true;
  const requestIntegration = (row: DistributedRecord, action: 'merge' | 'push') => {
    const incomingRequestId = idOf(row, ['id', 'requestId']);
    const head = readText(row, ['expectedHead']);
    const fingerprint = readText(row, ['expectedFingerprint']);
    const remoteName = remoteNames[incomingRequestId]?.trim();
    if (!incomingRequestId || !validObjectId(head) || !/^[a-f0-9]{64}$/i.test(fingerprint) || (action === 'push' && !remoteName)) return;
    void perform(`git-integrate:${incomingRequestId}`, `Git ${action} request submitted for explicit integration review.`, () => distributedApi.integrateGit({ teamId, sharedProjectId: readText(row, ['sharedProjectId']), incomingRequestId, action, expectedHead: head, expectedFingerprint: fingerprint, ...(action === 'push' ? { remoteName } : {}), idempotencyKey: createIdempotencyKey() }));
  };
  return <div className="distributed__panel">
    <p className="dw-owner-note dw-owner-note--large"><GitBranch size={14} /> Bundle import and Git integration are separate actions. Push and merge are requested only for an existing incoming transfer and use the displayed expected HEAD and repository fingerprint. Commands are a fixed structured Git read-operation allowlist, never arbitrary shell text.</p>
    <div className="distributed__grid distributed__grid--forms">
      <form className="dw-card" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!teamId || !deviceId || !projectId || !validObjectId(expectedHead)) return; void perform('git-request', 'Git bundle transfer requested; no checkout, push or merge occurred.', () => distributedApi.requestGit({ idempotencyKey: createIdempotencyKey(), teamId, sharedProjectId: projectId, toDeviceId: deviceId, expectedHead: expectedHead.trim(), ...(baseHead.trim() ? { baseHead: baseHead.trim() } : {}), ...(branch.trim() ? { branch: branch.trim() } : {}) })); }}>
        <div className="dw-card__heading"><span><GitBranch size={15} /></span><div><h3>Request a Git bundle transfer</h3><p>Imports are staged in an isolated ref. Push and merge use the separate integration action below.</p></div></div>
        <SelectControl label="Shared project" value={projectId} onChange={setProjectId} options={projectOptions} disabled={!projectOptions.length} />
        <SelectControl label="Destination device" value={deviceId} onChange={setDeviceId} options={devices} disabled={!devices.length} />
        <TextControl label="Expected source HEAD" value={expectedHead} onChange={setExpectedHead} required placeholder="40- or 64-character Git object ID" />
        <TextControl label="Common base HEAD (optional)" value={baseHead} onChange={setBaseHead} placeholder="40- or 64-character Git object ID" />
        <TextControl label="Source branch label (optional)" value={branch} onChange={setBranch} placeholder="feature/work" />
        <Button type="submit" size="sm" disabled={Boolean(busy) || !teamId || !deviceId || !projectId || !validObjectId(expectedHead) || Boolean(baseHead.trim() && !validObjectId(baseHead))} busy={busy === 'git-request'}>Request bundle import</Button>
      </form>
      <form className="dw-card" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!teamId || !deviceId || !projectId || !commandFieldsValid) return; void perform('command-request', 'Structured Git operation requested for destination-owner approval.', () => distributedApi.requestCommand({ idempotencyKey: createIdempotencyKey(), teamId, sharedProjectId: projectId, toDeviceId: deviceId, operation: makeCommand(), cwd: cwd.trim() || '.' })); }}>
        <div className="dw-card__heading"><span><Activity size={15} /></span><div><h3>Request a scoped Git read</h3><p>Only the service’s fixed Git metadata operations are available; no executable or shell command can be entered.</p></div></div>
        <SelectControl label="Shared project" value={projectId} onChange={setProjectId} options={projectOptions} disabled={!projectOptions.length} />
        <SelectControl label="Destination device" value={deviceId} onChange={setDeviceId} options={devices} disabled={!devices.length} />
        <SelectControl label="Operation" value={commandKind} onChange={setCommandKind} options={[{ value: 'git.version', label: 'Git version' }, { value: 'git.status', label: 'Repository status' }, { value: 'git.head', label: 'Current HEAD' }, { value: 'git.branch', label: 'Current branch' }, { value: 'git.log', label: 'Recent commit summaries' }, { value: 'git.showStat', label: 'Commit change summary' }, { value: 'git.diffStat', label: 'Compare two revisions' }]} />
        {commandKind === 'git.log' ? <TextControl label="Commit limit" type="number" value={logLimit} onChange={setLogLimit} required /> : null}
        {commandKind === 'git.showStat' ? <TextControl label="Commit object ID" value={commit} onChange={setCommit} required placeholder="40- or 64-character Git object ID" /> : null}
        {commandKind === 'git.diffStat' ? <><TextControl label="Base object ID" value={diffBase} onChange={setDiffBase} required placeholder="40- or 64-character Git object ID" /><TextControl label="Head object ID" value={diffHead} onChange={setDiffHead} required placeholder="40- or 64-character Git object ID" /></> : null}
        <TextControl label="Relative project directory" value={cwd} onChange={setCwd} required hint="The receiving service validates the project-relative path and symlinks." />
        <Button type="submit" size="sm" disabled={Boolean(busy) || !teamId || !deviceId || !projectId || !commandFieldsValid} busy={busy === 'command-request'}>Request read operation</Button>
      </form>
    </div>
    <DecisionList title="Git transfer and integration approvals" note="The request digest shown in the current snapshot is included in this decision; the UI does not fetch a replacement before submitting." category="git" rows={pendingGit} busy={busy} checkedApprovals={checkedApprovals} setCheckedApprovals={setCheckedApprovals} onDecision={(row, value) => decide('git', row, value)} />
    <DecisionList title="Incoming structured command approvals" note="Review the exact operation and project scope before deciding. Decisions bind to the displayed request digest." category="command" rows={pendingCommands} busy={busy} checkedApprovals={checkedApprovals} setCheckedApprovals={setCheckedApprovals} onDecision={(row, value) => decide('command', row, value)} />
    <section className="dw-decision-section"><div className="dw-section-head"><div><h3>Git integration</h3><p>Request merge or push only after the incoming bundle is imported; HEAD and fingerprint are read from the displayed request snapshot.</p></div><Badge>{integrationRequests.length}</Badge></div>{integrationRequests.length ? <div className="dw-approval-list">{integrationRequests.map((row, index) => {
      const id = idOf(row, ['id', 'requestId']) || `incoming-${index}`;
      const head = readText(row, ['expectedHead']);
      const fingerprint = readText(row, ['expectedFingerprint']);
      const action = integrationAction[id] ?? 'merge';
      return <article className="dw-approval" key={id}><div className="dw-approval__head"><div><strong>Imported bundle · {nameOf(row, id)}</strong><span>Expected HEAD {head || 'not reported'} · fingerprint {fingerprint || 'not reported'} · branch {text(row, ['branch'], 'not reported')}</span></div><Badge>{text(row, ['status'], 'Status unknown')}</Badge></div><SelectControl label="Integration action" value={action} onChange={(value) => setIntegrationAction((current) => ({ ...current, [id]: value as 'merge' | 'push' }))} options={[{ value: 'merge', label: 'Merge into reviewed local branch' }, { value: 'push', label: 'Push to configured remote' }]} />{action === 'push' ? <TextControl label="Configured remote name" value={remoteNames[id] ?? ''} onChange={(value) => setRemoteNames((current) => ({ ...current, [id]: value }))} required placeholder="Existing remote name" hint="The server checks this against local repository configuration." /> : null}<Button size="sm" disabled={Boolean(busy) || !teamId || !readText(row, ['sharedProjectId']) || !validObjectId(head) || !/^[a-f0-9]{64}$/i.test(fingerprint) || (action === 'push' && !remoteNames[id]?.trim())} busy={busy === `git-integrate:${id}`} onClick={() => requestIntegration(row, action)}>Request {action}</Button></article>;
    })}</div> : <p className="dw-empty">No imported incoming bundle is ready for an integration request.</p>}</section>
    <RequestHistory title="Command request results" rows={commandRequests} />
    <AuditHistory title="Git operation audit" rows={gitAudit} />
    <AuditHistory title="Command operation audit" rows={commandAudit} />
  </div>;
}

function RequestHistory({ title, rows }: { title: string; rows: DistributedRecord[] }) {
  return <section className="dw-decision-section"><div className="dw-section-head"><div><h3>{title}</h3><p>Recorded status and result from the structured command service.</p></div><Badge>{rows.length}</Badge></div>{rows.length ? <div className="dw-list">{rows.map((row, index) => { const operation = asRecord(readValue(row, ['operation'])) ?? {}; return <article className="dw-row" key={idOf(row, ['id', 'requestId']) || `command-${index}`}><div className="dw-row__main"><strong>{text(operation, ['kind'], 'Git operation')}</strong><span>{text(row, ['direction'], 'Direction unknown')} · {text(row, ['status'], 'Status unknown')} · cwd {text(row, ['cwd'], '.')} · {text(row, ['updatedAt'], 'Time not reported')}</span>{text(row, ['output'], '') ? <code className="dw-command-argv">{text(row, ['output'], '')}</code> : null}{text(row, ['error'], '') ? <span role="alert">{text(row, ['error'], '')}</span> : null}</div><Badge tone={displayStatus(row, ['status']).tone}>{text(row, ['status'], 'Status unknown')}</Badge></article>; })}</div> : <p className="dw-empty">No command requests are present.</p>}</section>;
}

function AuditHistory({ title, rows }: { title: string; rows: DistributedRecord[] }) {
  return <section className="dw-decision-section"><div className="dw-section-head"><div><h3>{title}</h3><p>Audit entries returned by the service.</p></div><Badge>{rows.length}</Badge></div>{rows.length ? <div className="dw-list">{rows.map((row, index) => { const details = asRecord(readValue(row, ['details'])) ?? {}; return <article className="dw-row" key={idOf(row, ['id', 'auditId']) || `audit-${index}`}><div className="dw-row__main"><strong>{text(row, ['action'], 'Recorded operation')}</strong><span>Request {text(row, ['requestId'], 'not linked')} · actor device {text(row, ['actorDeviceId'], 'not reported')} · digest {text(row, ['digest'], 'not reported')} · {text(row, ['createdAt'], 'time not reported')}</span><code className="dw-command-argv">{Object.keys(details).length ? JSON.stringify(details) : 'No detail reported'}</code></div></article>; })}</div> : <p className="dw-empty">No audit entries are present.</p>}</section>;
}

function DecisionList({ title, note, category, rows, busy, checkedApprovals, setCheckedApprovals, onDecision }: {
  title: string; note: string; category: 'git' | 'command'; rows: DistributedRecord[]; busy: string | null; checkedApprovals: Record<string, boolean>; setCheckedApprovals: (value: (current: Record<string, boolean>) => Record<string, boolean>) => void;
  onDecision: (row: DistributedRecord, decision: 'approved' | 'denied') => void;
}) {
  return <section className="dw-decision-section"><div className="dw-section-head"><div><h3>{title}</h3><p>{note}</p></div><Badge>{rows.length}</Badge></div>{rows.length ? <div className="dw-approval-list">{rows.map((row, index) => {
    const id = idOf(row, ['id', 'requestId']) || `${category}-${index}`;
    return <OwnerDecision key={id} row={row} id={id} category={category} busy={busy} checkedApprovals={checkedApprovals} setCheckedApprovals={setCheckedApprovals} onDecision={(decision) => onDecision(row, decision)} />;
  })}</div> : <p className="dw-empty">No {category} requests are reported.</p>}</section>;
}
