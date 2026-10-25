import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, CircleAlert, FolderOpen, GitBranch, Mail, Plus, RefreshCw, Users, X } from 'lucide-react';
import type { AccountState, DirectoryListing, Policy, Project, ProjectInvitationJoinResult, Provider, ProviderInfo, ProviderModel, Session } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { useMingle } from '../../store/store';
import { copyText } from '../../lib/clipboard';
import { teamAgentDisplayName } from '../../lib/team-agent-display';
import { PROVIDER_NAMES } from '../../lib/providers';
import { POLICY_DESCRIPTION, POLICY_LABEL } from '../../lib/groups';
import { createIdempotencyKey, distributedApi } from '../distributed/api';
import { Badge, Button, InlineError, Modal, ProviderMark, StatusDot } from '../ui';
import { projectCollaborationApi, CollaborationApiError, recordText, type CollaborationRecord, type InvitationPreview, type ProjectCollaborationSnapshot } from './api';
import { joinSuccessCopy, resolveJoinCloneParent } from './join-flow';
import { TeamConsentSheet } from '../team-orchestration/settings/TeamConsentSheet';
import { TeamOrchestrationSettings } from '../team-orchestration/settings/TeamOrchestrationSettings';
import '../../styles/project-collaboration.css';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const JOIN_PROVIDERS: Provider[] = ['codex', 'claude', 'opencode'];
const JOIN_POLICIES: Policy[] = ['supervised', 'balanced', 'auto', 'full-access'];

function errorStatus(cause: unknown): number {
  return cause instanceof CollaborationApiError ? cause.status : 0;
}

function selectedProviderInfo(providers: readonly ProviderInfo[], provider: string): ProviderInfo | undefined {
  return providers.find((item) => item.id === provider && JOIN_PROVIDERS.includes(item.id));
}

function supervisedModels(info: ProviderInfo | undefined): ProviderModel[] {
  if (!info?.available) return [];
  return info.models.filter((model) => {
    const policies = model.policies ?? info.policies;
    const supportsSupervised = policies ? policies.includes('supervised') : JOIN_PROVIDERS.includes(info.id);
    return supportsSupervised && reasoningChoices(info, model).length > 0;
  });
}

function policyChoices(info: ProviderInfo | undefined, model: ProviderModel | undefined): Policy[] {
  const policies = model?.policies ?? info?.policies;
  return JOIN_POLICIES.filter((policy) => policies ? policies.includes(policy) : policy === 'supervised');
}

/** Use native catalog choices when reported; otherwise mirror the runtime's documented defaults. */
function reasoningChoices(info: ProviderInfo, model: ProviderModel): NonNullable<ProviderModel['reasoningEfforts']> {
  if (model.reasoningEfforts?.length) return model.reasoningEfforts;
  if (model.reasoningEfforts) return [{ id: 'none', label: 'Native/default' }];
  if (info.id === 'codex' || info.id === 'claude') return [
    { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
  ];
  return [{ id: 'none', label: 'Native/default' }];
}

function localSessionLabel(session: Session): string {
  return `${session.provider[0]!.toUpperCase()}${session.provider.slice(1)} · ${session.model}`;
}

function publishableSession(session: Session): boolean {
  return JOIN_PROVIDERS.includes(session.provider);
}

export function ProjectTeammatesDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const boot = useMingle((state) => state.boot);
  const localSessions = (boot?.sessions ?? []).filter((session) => session.projectId === project.id);
  const [snapshot, setSnapshot] = useState<ProjectCollaborationSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<{ status: 'sent' | 'failed' | 'not_configured'; message: string; email: string; joinUrl?: string } | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [localSelection, setLocalSelection] = useState<string[] | null>(null);
  const [sharing, setSharing] = useState(false);
  const [note, setNote] = useState('');
  const [taskId, setTaskId] = useState('');
  const [sharedAction, setSharedAction] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await projectCollaborationApi.snapshot(project.id, signal);
      if (id === requestId.current && !signal?.aborted) setSnapshot(result);
    } catch (cause) {
      if (id === requestId.current && !signal?.aborted) setError(errorMessage(cause));
    } finally {
      if (id === requestId.current && !signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { requestId.current++; controller.abort(); };
    // `project.id` keys the dialog; use one bounded initial read per dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    const controller = new AbortController();
    void api.account(controller.signal).then(setAccount).catch(() => setAccount(null));
    return () => controller.abort();
  }, []);

  const localAgents = localSessions;
  const rosterAgents = snapshot?.agents ?? [];
  const sharedLocalIds = localAgents.filter((session) => rosterAgents.some((agent) => recordText(agent, ['sessionId']) === session.id)).map((session) => session.id);
  const remoteAgents = rosterAgents.filter((agent) => !(account?.user?.id && recordText(agent, ['accountId']) === account.user.id && localAgents.some((session) => session.id === recordText(agent, ['sessionId']))));
  const selectedLocalIds = localSelection ?? sharedLocalIds;
  const manageableRole = snapshot?.members.find((member) => recordText(member, ['accountId']) === account?.user?.id)?.role;
  const canManageRoster = manageableRole === 'leader' || manageableRole === 'admin';
  const memberMap = new Map(snapshot?.members.map((member) => [recordText(member, ['accountId']), member]) ?? []);
  const shareableTasks = (boot?.tasks ?? []).filter((task) => task.projectId === project.id);
  const selectedRemote = remoteAgents.find((agent, index) => {
    const agentId = recordText(agent, ['id', 'agentId', 'sharedAgentId'], `team-agent-${index}`);
    return agentId === selectedAgentId;
  });
  const selectedRemoteProvider = selectedRemote ? recordText(selectedRemote, ['provider'], 'Teammate') : 'Teammate';
  const selectedRemoteOwner = selectedRemote ? recordText(memberMap.get(recordText(selectedRemote, ['accountId'])), ['displayName', 'email'], 'Owner not reported') : 'Owner not reported';
  const selectedRemoteName = selectedRemote ? teamAgentDisplayName(recordText(selectedRemote, ['name', 'agentName', 'sessionName'], `${selectedRemoteProvider} agent`), selectedRemoteOwner, selectedRemoteProvider) : '';
  const emailStatus = snapshot?.email;

  const sendInvite = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalized) || sending) return;
    setSending(true);
    setError(null);
    setDelivery(null);
    try {
      const result = await projectCollaborationApi.invite(project.id, { email: normalized, role });
      setDelivery({
        status: result.delivery.status,
        email: result.invitation.email || normalized,
        message: result.delivery.message ?? '',
        ...((result.joinUrl ?? result.invitation.joinUrl) ? { joinUrl: result.joinUrl ?? result.invitation.joinUrl } : {}),
      });
      setEmail('');
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSending(false); }
  };

  const updatePublishedAgents = async () => {
    if (!snapshot?.project || !canManageRoster || sharing) return;
    setSharing(true);
    setError(null);
    try {
      await distributedApi.publishAgents({ teamId: snapshot.project.teamId, sharedProjectId: snapshot.project.sharedProjectId, sessionIds: selectedLocalIds.filter((id) => localAgents.some((session) => session.id === id && publishableSession(session))) });
      setSharedAction('Your selected local agents are now reflected in the shared project roster.');
      setLocalSelection(null);
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSharing(false); }
  };

  const revokeMember = async (member: CollaborationRecord) => {
    const accountId = recordText(member, ['accountId']);
    const address = recordText(member, ['email'], 'this teammate');
    if (!snapshot?.project || !accountId || !canManageRoster || accountId === account?.user?.id) return;
    if (!window.confirm(`Remove ${address} from this project team? Their devices will lose future team authority.`)) return;
    setError(null);
    try {
      await distributedApi.revokeMember({ teamId: snapshot.project.teamId, userId: accountId });
      setSharedAction(`${address} was removed from the project roster.`);
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
  };

  const shareNote = async (event: FormEvent) => {
    event.preventDefault();
    const content = note.trim();
    if (!content || !snapshot?.project || sharedAction === 'sending-note') return;
    setSharedAction('sending-note');
    setError(null);
    try {
      await distributedApi.sendMessage({ teamId: snapshot.project.teamId, sharedProjectId: snapshot.project.sharedProjectId, content, idempotencyKey: createIdempotencyKey() });
      setNote('');
      setSharedAction('Project note shared with the team. No local provider session was started.');
      await refresh();
    } catch (cause) { setSharedAction(null); setError(errorMessage(cause)); }
  };

  const shareTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!taskId || !snapshot?.project) return;
    setSharedAction('sharing-task');
    setError(null);
    try {
      await distributedApi.publishTask({ teamId: snapshot.project.teamId, sharedProjectId: snapshot.project.sharedProjectId, taskId });
      setSharedAction('Task shared with the project team.');
      await refresh();
    } catch (cause) { setSharedAction(null); setError(errorMessage(cause)); }
  };

  const openTeamWorkspace = () => {
    onClose();
    useMingle.getState().openSettings({ section: 'team', projectId: project.id, teamTab: 'recovery' });
  };

  return <Modal title="Teammates" description={`Invite people to work on ${project.name}. Your local agents stay yours.`} onClose={onClose} width={640}>
    <div className="pc-dialog" aria-busy={loading || sending}>
      <div className="pc-invite-intro"><span className="pc-icon"><Mail size={17} /></span><div><strong>Invite by email</strong><p>They’ll join this project from their own Mingle and choose their own checkout and provider.</p></div></div>
      {emailStatus?.configured === false ? <p className="pc-inline-note" role="status"><CircleAlert size={14} /> Email delivery is not configured. {emailStatus.message || 'New invites may be created, but they cannot be delivered until email is configured.'}</p> : null}
      {error ? <InlineError onRetry={() => void refresh()}>{error}</InlineError> : null}
      <form className="pc-invite-form" onSubmit={(event) => void sendInvite(event)}>
        <label className="pc-field pc-field--email"><span>Teammate email</span><input autoComplete="email" type="email" value={email} onChange={(event) => { setEmail(event.target.value); setDelivery(null); }} placeholder="name@example.com" required /></label>
        <label className="pc-field pc-field--role"><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value as 'member' | 'admin')}><option value="member">Member</option><option value="admin">Admin</option></select></label>
        <Button type="submit" variant="primary" size="sm" disabled={!EMAIL_PATTERN.test(email.trim()) || sending} busy={sending}>Send invite</Button>
      </form>
      {delivery ? <div className={`pc-delivery pc-delivery--${delivery.status}`} role="status">
        {delivery.status === 'sent' ? <Check size={14} /> : <CircleAlert size={14} />}
        <span>{delivery.status === 'sent' ? `Invitation email sent to ${delivery.email}.` : delivery.status === 'failed' ? `Invitation created, but email delivery failed for ${delivery.email}.` : `Invitation created, but no email was sent to ${delivery.email}.`}{delivery.message ? ` ${delivery.message}` : ''}</span>
        {delivery.joinUrl ? <Button size="sm" onClick={() => void copyText(delivery.joinUrl!).then(() => useMingle.getState().toast('success', 'Join link copied.')).catch(() => setError('Could not copy the join link.'))}>Copy join link</Button> : null}
      </div> : null}
      <div className="pc-roster-head"><div><h3>Project agents</h3><p>Inspect local and teammate agents together. Remote owners keep control of their model, permissions, stop and spend approvals.</p></div><Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()} aria-label="Refresh project agents"><RefreshCw size={13} />Refresh</Button></div>
      {loading && !snapshot ? <p className="pc-loading" role="status">Loading project roster…</p> : null}
      {snapshot?.project ? <p className="pc-project-ref"><Users size={13} /> {snapshot.project.name} <span>· shared project connected</span></p> : null}
      {!loading && snapshot && !snapshot.project ? <p className="pc-inline-note" role="status">This project’s collaboration workspace is being prepared. Refresh in a moment to see its roster.</p> : null}
      {snapshot?.project ? <TeamOrchestrationSettings projectId={project.id} /> : null}
      <div className="pc-agent-list" role="list" aria-label="Local and teammate agents">
        {localAgents.map((session) => <div className="pc-agent-row" role="listitem" key={`local-${session.id}`}>
          <input type="checkbox" aria-label={`Share ${session.name} with this project`} checked={selectedLocalIds.includes(session.id)} disabled={!snapshot?.project || !canManageRoster || !publishableSession(session)} title={!publishableSession(session) ? 'This provider cannot be shared for remote execution.' : undefined} onChange={(event) => setLocalSelection((current) => {
            const selected = current ?? sharedLocalIds;
            return event.target.checked ? [...new Set([...selected, session.id])] : selected.filter((id) => id !== session.id);
          })} />
          <button type="button" className="pc-agent-select" onClick={() => { useMingle.getState().selectSession(session.id); onClose(); }} aria-label={`Inspect local agent ${session.name}`}>
            <ProviderMark provider={session.provider} size={17} /><span className="pc-agent-copy"><strong>{session.name}</strong><small>{localSessionLabel(session)} · this device</small></span><StatusDot status={session.status} /><Badge>Local</Badge>
          </button>
        </div>)}
        {remoteAgents.map((agent, index) => {
          const id = recordText(agent, ['id', 'agentId', 'sharedAgentId'], `team-agent-${index}`);
          const accountId = recordText(agent, ['accountId']);
          const member = memberMap.get(accountId);
          const provider = recordText(agent, ['provider'], 'Provider not reported');
          const model = recordText(agent, ['model'], 'Model not reported');
          const device = recordText(agent, ['deviceName', 'deviceId'], 'Device not reported');
          const ownerName = recordText(member, ['displayName', 'email'], accountId || 'Owner not reported');
          const rawName = recordText(agent, ['name', 'agentName', 'sessionName'], `${provider} agent`);
          const name = teamAgentDisplayName(rawName, ownerName, provider);
          const state = recordText(agent, ['state'], 'State not reported');
          const selected = selectedAgentId === id;
          return <div className={`pc-agent-row pc-agent-row--remote${selected ? ' is-selected' : ''}`} role="listitem" key={`remote-${id}`}>
            <button type="button" className="pc-agent-select" aria-pressed={selected} onClick={() => setSelectedAgentId(selected ? null : id)}>
              <span className="pc-team-avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span><span className="pc-agent-copy"><strong>{name}</strong><small>{ownerName} · {PROVIDER_NAMES[provider as Provider] ?? provider} · {model} · {device}</small></span><Badge tone={/busy|running/i.test(state) ? 'info' : 'neutral'}>{state}</Badge><Badge>Team</Badge>
            </button>
          </div>;
        })}
        {!localAgents.length && !remoteAgents.length && snapshot?.project ? <p className="pc-empty">No agents have been shared for this project yet. Existing local sessions remain private until you explicitly publish them.</p> : null}
      </div>
      {snapshot?.project && localAgents.length ? <div className="pc-roster-actions"><span>{selectedLocalIds.filter((id) => localAgents.some((session) => session.id === id && publishableSession(session))).length} local agents selected · runs from teammates follow the team permission level</span><Button size="sm" disabled={!canManageRoster || sharing || selectedLocalIds.length === 0 && sharedLocalIds.length === 0} busy={sharing} onClick={() => void updatePublishedAgents()}>Update shared agents</Button></div> : null}
      {selectedRemote ? <div className="pc-owner-note"><strong>{selectedRemoteName} · {recordText(selectedRemote, ['state'], 'State not reported')}</strong><span>Owner {selectedRemoteOwner} · device {recordText(selectedRemote, ['deviceId'], 'not reported')} · {PROVIDER_NAMES[selectedRemoteProvider as Provider] ?? selectedRemoteProvider} · {recordText(selectedRemote, ['model'], 'Model not reported')} · owner retains model, permission, stop and spend control.</span><Button size="sm" onClick={openTeamWorkspace}>Open recovery controls <ArrowUpRight size={13} /></Button></div> : null}
      {snapshot?.project ? <div className="pc-shared-actions">
        <form className="pc-shared-note" onSubmit={(event) => void shareNote(event)}><label className="pc-field"><span>Share a project note</span><textarea value={note} onChange={(event) => { setNote(event.target.value); if (sharedAction && sharedAction !== 'sending-note') setSharedAction(null); }} placeholder="A decision, update or question for the team…" maxLength={5000} /></label><Button type="submit" size="sm" disabled={!note.trim() || sharedAction === 'sending-note'} busy={sharedAction === 'sending-note'}>Share note</Button></form>
        <form className="pc-share-task" onSubmit={(event) => void shareTask(event)}><label className="pc-field"><span>Share a project task</span><select aria-label="Task to share" value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">Choose a task…</option>{shareableTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><Button type="submit" size="sm" disabled={!taskId || sharedAction === 'sharing-task'} busy={sharedAction === 'sharing-task'}>Share task</Button></form>
        {sharedAction && !['sending-note', 'sharing-task'].includes(sharedAction) ? <p className="pc-shared-feedback" role="status">{sharedAction}</p> : null}
      </div> : null}
      {snapshot?.members?.length ? <details className="pc-members"><summary>Project members <span>{snapshot.members.length}</span></summary><div>{snapshot.members.map((member, index) => {
        const accountId = recordText(member, ['accountId']);
        const isSelf = Boolean(accountId && accountId === account?.user?.id);
        const memberRole = recordText(member, ['role'], 'member');
        const mayRemove = canManageRoster && !isSelf && memberRole !== 'leader' && (manageableRole === 'leader' || memberRole === 'member');
        return <p key={accountId || `member-${index}`}><span><strong>{recordText(member, ['displayName', 'email'], 'Project member')}</strong><small>{recordText(member, ['email'], 'Email not shared')} · {memberRole}{isSelf ? ' · you' : ''}</small></span>{mayRemove ? <Button size="sm" variant="danger" onClick={() => void revokeMember(member)}>Remove</Button> : null}</p>;
      })}</div></details> : null}
      {snapshot?.invitations?.length ? <details className="pc-invitations"><summary>Recent invitations <span>{snapshot.invitations.length}</span></summary><div>{snapshot.invitations.map((invite, index) => <p key={recordText(invite, ['id'], `invite-${index}`)}><strong>{recordText(invite, ['email'], 'Email not reported')}</strong><small>{recordText(invite, ['status', 'state'], 'Status not reported')} · expires {recordText(invite, ['expiresAt', 'expires_at'], 'not reported')}</small></p>)}</div></details> : null}
      <p className="pc-no-run-note">Inviting, joining and publishing agents don’t start a model run.</p>
    </div>
  </Modal>;
}

type InviteState = 'loading' | 'ready' | 'sign-in' | 'wrong-account' | 'unavailable' | 'expired' | 'revoked' | 'setup' | 'error';

function repoName(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).at(-1) ?? 'project';
    return segment.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 100) || 'project';
  } catch {
    const segment = url.split(/[/:]/).filter(Boolean).at(-1) ?? 'project';
    return segment.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 100) || 'project';
  }
}

function classifyPreviewError(cause: unknown, account: AccountState | null): InviteState {
  const message = errorMessage(cause).toLowerCase();
  const status = errorStatus(cause);
  if (account?.status !== 'signed-in' && (status === 401 || status === 403)) return 'sign-in';
  const genericUnavailable = /invitation is invalid, expired, revoked, or belongs to another account/.test(message);
  const explicitRevocation = /invitation (?:has been )?revoked|revoked invitation/.test(message);
  const explicitExpiry = /invitation (?:has )?expired|expired invitation/.test(message);
  if (genericUnavailable || (status === 404 && !explicitRevocation && !explicitExpiry)) return 'unavailable';
  if (explicitRevocation) return 'revoked';
  if (explicitExpiry || status === 410) return 'expired';
  if (/wrong account|email .* does not match|invited account/.test(message) || status === 403) return 'wrong-account';
  return 'error';
}

type JoinStep = 'invite' | 'workspace' | 'agents' | 'consent' | 'success';
type JoinSource = 'clone' | 'project' | 'folder';
type JoinAgentDraft = { id: number; provider: Provider | ''; model: string; effort: string; policy: Policy };

function preferredEffort(info: ProviderInfo, model: ProviderModel): string {
  const choices = reasoningChoices(info, model);
  return choices.find((item) => item.id === model.defaultReasoningEffort)?.id ?? choices[0]?.id ?? '';
}

function nativePathJoin(parent: string, name: string, separator: string): string {
  const trimmedParent = parent.replace(/[\\/]+$/, '');
  return `${trimmedParent}${separator || '/'}${name}`;
}

export function ProjectInviteJoinDialog({ token, onClose, onOpenAccountSettings, onOpenProviderSettings, onJoined }: {
  token: string; onClose: () => void; onOpenAccountSettings: () => void; onOpenProviderSettings: () => void;
  onJoined?: (result: ProjectInvitationJoinResult) => void;
}) {
  const boot = useMingle((state) => state.boot);
  const projects = boot?.projects ?? [];
  const providers = boot?.providers ?? [];
  const eligibleProviders = useMemo(() => JOIN_PROVIDERS.flatMap((id) => {
    const info = selectedProviderInfo(providers, id);
    return info && supervisedModels(info).length ? [info] : [];
  }), [providers]);
  const [inviteState, setInviteState] = useState<InviteState>('loading');
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [account, setAccount] = useState<AccountState | null>(null);
  const [step, setStep] = useState<JoinStep>('invite');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [source, setSource] = useState<JoinSource>('clone');
  const [folderPath, setFolderPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [directoryPath, setDirectoryPath] = useState('');
  const [directoryListing, setDirectoryListing] = useState<DirectoryListing | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [agentDrafts, setAgentDrafts] = useState<JoinAgentDraft[]>([]);
  const [joining, setJoining] = useState(false);
  const [consentSkipped, setConsentSkipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinResult, setJoinResult] = useState<ProjectInvitationJoinResult | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const previewSequence = useRef(0);
  const directorySequence = useRef(0);
  const nextAgentId = useRef(1);

  const selectedProject = projects.find((project) => project.id === selectedProjectId && !project.isExample);
  const accountEmail = account?.user?.email?.trim().toLowerCase() ?? '';
  const inviteEmail = preview?.email.trim().toLowerCase() ?? '';
  const emailMatches = Boolean(accountEmail && inviteEmail && accountEmail === inviteEmail);
  const signedIn = account?.status === 'signed-in';
  const parentPath = directoryPath.trim();
  const cloneName = folderName.trim();
  const resultingPath = parentPath && cloneName ? nativePathJoin(parentPath, cloneName, directoryListing?.separator ?? '/') : '';
  const listedDirectories = directoryListing?.directories ?? [];

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++previewSequence.current;
    setInviteState('loading');
    setPreview(null);
    setPreviewError('');
    setError(null);
    setStep('invite');
    if (!INVITATION_TOKEN_PATTERN.test(token)) {
      setPreviewError('This invitation link is incomplete or invalid. Ask the project leader to send a new invitation.');
      setInviteState('error');
      return () => { previewSequence.current++; controller.abort(); };
    }
    void Promise.allSettled([projectCollaborationApi.preview(token, controller.signal), api.account(controller.signal)]).then(([previewResult, accountResult]) => {
      if (controller.signal.aborted || sequence !== previewSequence.current) return;
      const nextAccount = accountResult.status === 'fulfilled' ? accountResult.value : null;
      setAccount(nextAccount);
      if (previewResult.status === 'fulfilled') {
        setPreview(previewResult.value);
        if (nextAccount?.status === 'signed-in' && nextAccount.user?.email?.trim().toLowerCase() !== previewResult.value.email.trim().toLowerCase()) setInviteState('wrong-account');
        else if (!nextAccount || nextAccount.status !== 'signed-in') setInviteState('sign-in');
        else setInviteState('ready');
      } else {
        const cause = previewResult.reason;
        setPreviewError(errorMessage(cause));
        setInviteState(classifyPreviewError(cause, nextAccount));
      }
    });
    return () => { previewSequence.current++; controller.abort(); };
  }, [previewRetry, token]);

  useEffect(() => {
    if (account?.status !== 'signing-in') return;
    const refresh = () => void api.account().then((value) => setAccount(value)).catch((cause) => setError(errorMessage(cause)));
    const timer = window.setInterval(refresh, 1600);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [account?.status]);

  useEffect(() => {
    if (account?.status !== 'signed-in' || preview || inviteState !== 'sign-in') return;
    const controller = new AbortController();
    void projectCollaborationApi.preview(token, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setPreview(value);
      setInviteState(account.user?.email?.trim().toLowerCase() === value.email.trim().toLowerCase() ? 'ready' : 'wrong-account');
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setPreviewError(errorMessage(cause));
      setInviteState(classifyPreviewError(cause, account));
    });
    return () => controller.abort();
  }, [account, inviteState, preview, token]);

  useEffect(() => {
    if (!preview || ['loading', 'expired', 'revoked', 'error'].includes(inviteState)) return;
    if (account?.status !== 'signed-in') { setInviteState('sign-in'); setStep('invite'); return; }
    const matches = account.user?.email?.trim().toLowerCase() === preview.email.trim().toLowerCase();
    setInviteState(matches ? 'ready' : 'wrong-account');
    if (!matches) setStep('invite');
  }, [account, inviteState, preview]);

  useEffect(() => {
    if (!preview) return;
    setFolderName((value) => value || repoName(preview.repositoryUrl));
  }, [preview]);

  useEffect(() => {
    const sequence = ++directorySequence.current;
    void api.directories('', '', false).then((listing) => {
      if (sequence !== directorySequence.current) return;
      setDirectoryListing(listing);
      setDirectoryPath(listing.displayPath);
    }).catch((cause) => {
      if (sequence === directorySequence.current) setDirectoryError(errorMessage(cause));
    });
    return () => { directorySequence.current++; };
  }, []);

  useEffect(() => {
    if (!eligibleProviders.length) {
      setAgentDrafts([]);
      return;
    }
    setAgentDrafts((current) => {
      if (!current.length) {
        const first = eligibleProviders[0]!;
        const model = supervisedModels(first)[0]!;
        return [{ id: nextAgentId.current++, provider: first.id as Provider, model: model.id, effort: preferredEffort(first, model), policy: 'supervised' }];
      }
      return current.map((draft) => {
        const provider = eligibleProviders.find((item) => item.id === draft.provider) ?? eligibleProviders[0]!;
        const models = supervisedModels(provider);
        const model = models.find((item) => item.id === draft.model) ?? models[0]!;
        const efforts = reasoningChoices(provider, model);
        const effort = efforts.find((item) => item.id === draft.effort)?.id ?? preferredEffort(provider, model);
        const policies = policyChoices(provider, model);
        const policy = policies.includes(draft.policy) ? draft.policy : policies.includes('supervised') ? 'supervised' : policies[0]!;
        return { ...draft, provider: provider.id as Provider, model: model.id, effort, policy };
      });
    });
  }, [eligibleProviders]);

  const loadDirectory = async (path: string) => {
    const sequence = ++directorySequence.current;
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      const listing = await api.directories(path, '', false);
      if (sequence !== directorySequence.current) return;
      setDirectoryListing(listing);
      setDirectoryPath(listing.displayPath);
    } catch (cause) {
      if (sequence === directorySequence.current) setDirectoryError(errorMessage(cause));
    } finally {
      if (sequence === directorySequence.current) setDirectoryLoading(false);
    }
  };

  const setAgentProvider = (index: number, providerId: string) => {
    const provider = eligibleProviders.find((item) => item.id === providerId);
    const model = provider && supervisedModels(provider)[0];
    if (!provider || !model) return;
    setAgentDrafts((current) => current.map((draft, draftIndex) => draftIndex === index
      ? { ...draft, provider: provider.id as Provider, model: model.id, effort: preferredEffort(provider, model), policy: policyChoices(provider, model).includes(draft.policy) ? draft.policy : 'supervised' }
      : draft));
  };

  const agentRowsValid = agentDrafts.length > 0 && agentDrafts.length <= 4 && agentDrafts.every((draft) => {
    const provider = eligibleProviders.find((item) => item.id === draft.provider);
    const model = supervisedModels(provider).find((item) => item.id === draft.model);
    return Boolean(provider && model && reasoningChoices(provider, model).some((choice) => choice.id === draft.effort)
      && policyChoices(provider, model).includes(draft.policy));
  });
  const canJoin = inviteState === 'ready' && Boolean(preview && signedIn && emailMatches && selectedProject && agentRowsValid && !joining && !workspaceBusy);

  const addExistingFolder = async (event: FormEvent) => {
    event.preventDefault();
    if (!folderPath.trim() || workspaceBusy) return;
    setWorkspaceBusy(true);
    setError(null);
    try {
      const listing = await api.directories(folderPath.trim(), '', false);
      if (!listing.canSelect) throw new Error('Choose an existing folder that Mingle can open.');
      const project = await api.createProject({ name: listing.displayPath.split(/[\\/]/).filter(Boolean).at(-1) || 'Project', path: listing.path });
      await useMingle.getState().refreshNow();
      setSelectedProjectId(project.id);
      setStep('agents');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setWorkspaceBusy(false); }
  };

  const cloneRepository = async () => {
    if (!preview?.repositoryUrl || !parentPath || !cloneName || workspaceBusy) return;
    setWorkspaceBusy(true);
    setError(null);
    setDirectoryError(null);
    let destination: DirectoryListing;
    try {
      destination = await resolveJoinCloneParent(parentPath, api.directories);
    } catch (cause) {
      setDirectoryError(errorMessage(cause));
      setWorkspaceBusy(false);
      return;
    }
    setDirectoryListing(destination);
    setDirectoryPath(destination.displayPath);
    try {
      const project = await api.cloneProject({ url: preview.repositoryUrl, name: cloneName, parentPath: destination.path });
      await useMingle.getState().refreshNow();
      setSelectedProjectId(project.id);
      setStep('agents');
    } catch (cause) {
      const message = errorMessage(cause);
      const authFailure = /auth|permission denied|repository not found|could not read from remote/i.test(message);
      setError(`${message} ${authFailure
        ? 'For a private repository, confirm Git is installed and your local Git credentials have access; Mingle does not receive repository credentials.'
        : 'Choose a different destination folder name. If Git created a partial checkout before failing, it is left at that path for inspection.'}`);
    } finally { setWorkspaceBusy(false); }
  };

  const signIn = async () => {
    setError(null);
    try { setAccount(await api.accountSignIn()); }
    catch (cause) { setError(errorMessage(cause)); }
  };

  const switchAccount = async () => {
    setError(null);
    try { setAccount(await api.accountSignOut()); setInviteState('sign-in'); setStep('invite'); }
    catch (cause) { setError(errorMessage(cause)); }
  };

  const joinProject = async () => {
    if (!canJoin || !preview || !selectedProject || joining) return;
    setJoining(true);
    setError(null);
    setConsentSkipped(false);
    try {
      const result = await projectCollaborationApi.join({
        token,
        localProjectId: selectedProject.id,
        agents: agentDrafts.map((draft) => ({ provider: draft.provider as 'codex' | 'claude' | 'opencode', model: draft.model, effort: draft.effort, policy: draft.policy })),
      });
      await useMingle.getState().refreshNow();
      if (result.projectId) useMingle.getState().selectProject(result.projectId);
      const firstSessionId = result.sessionIds?.[0] ?? result.sessionId;
      if (firstSessionId) useMingle.getState().selectSession(firstSessionId);
      const normalizedResult = { ...result, sessionIds: result.sessionIds?.length ? result.sessionIds : [result.sessionId] };
      setJoinResult(normalizedResult);
      setStep('consent');
    } catch (cause) {
      const state = classifyPreviewError(cause, account);
      if (state === 'unavailable' || state === 'expired' || state === 'revoked' || state === 'wrong-account') {
        setPreviewError(errorMessage(cause));
        setInviteState(state);
      } else if (/invited repository checkout|different repository|repository.*match/i.test(errorMessage(cause))) {
        setError('This checkout’s Git origin does not match the invited repository. Choose a project with the same repository origin or clone the repository URL shown in the invitation.');
      } else setError(errorMessage(cause));
    }
    finally { setJoining(false); }
  };

  const steps: { id: JoinStep; label: string }[] = [
    { id: 'invite', label: 'Invitation' }, { id: 'workspace', label: 'Code location' },
    { id: 'agents', label: 'Your agents' }, { id: 'consent', label: 'Team consent' }, { id: 'success', label: 'Ready' },
  ];
  const activeStepIndex = Math.max(0, steps.findIndex((item) => item.id === step));
  const canContinueInvite = inviteState === 'ready' && Boolean(preview && signedIn && emailMatches);
  const canContinueWorkspace = Boolean(selectedProject && inviteState === 'ready' && emailMatches && !workspaceBusy);
  const title = step === 'invite' && preview && inviteState === 'ready' ? `Join ${preview.projectName}?`
    : step === 'workspace' ? 'Where should we put the code?'
      : step === 'agents' ? 'Add your agents' : step === 'consent' ? 'Share your agents with the team' : step === 'success' ? 'Project joined' : 'Join project';

  return <Modal title={title} description={step === 'success' ? 'Your agents are ready in this project.' : step === 'consent' ? 'Choose which agents teammates may send work to, and review the consent terms.' : 'Review the invitation, choose a checkout, then configure your local agents.'} onClose={onClose} width={700}>
    <div className="pc-join" aria-busy={inviteState === 'loading' || joining || workspaceBusy}>
      <ol className="pc-join-steps" aria-label="Join project steps">
        {steps.slice(0, step === 'consent' ? 4 : 3).map((item, index) => <li key={item.id} className={`${index === activeStepIndex ? 'is-current' : ''}${index < activeStepIndex ? ' is-complete' : ''}`} aria-current={index === activeStepIndex ? 'step' : undefined}>
          <span>{index < activeStepIndex ? <Check size={13} /> : index + 1}</span>{item.label}
        </li>)}
      </ol>
      {inviteState === 'loading' ? <p className="pc-loading" role="status">Checking invitation and Mingle account…</p> : null}
      {inviteState === 'unavailable' ? <div className="pc-state-card pc-state-card--error"><CircleAlert size={19} /><div><h3>Invitation unavailable</h3><p>This link can’t be verified for the current account. Check which Google account received it, switch accounts, or ask the project owner to send a new invitation.</p>{accountEmail ? <small>Signed in as {accountEmail}</small> : null}<Button size="sm" onClick={() => void switchAccount()}>Switch account</Button><Button size="sm" variant="ghost" onClick={() => setPreviewRetry((value) => value + 1)}>Try again</Button></div></div> : null}
      {inviteState === 'expired' || inviteState === 'revoked' ? <div className="pc-state-card pc-state-card--error"><CircleAlert size={19} /><div><h3>{inviteState === 'revoked' ? 'This invitation was revoked' : 'This invitation has expired'}</h3><p>{previewError || 'Ask the project owner to send a new invitation.'}</p></div></div> : null}
      {inviteState === 'error' ? <div className="pc-state-card pc-state-card--error"><CircleAlert size={19} /><div><h3>We couldn’t verify this invitation</h3><p>{previewError ? `${previewError} It may be expired, revoked, already used or issued to another account. Sign in to the invited account or ask a project leader to send a new invitation.` : 'It may be expired, revoked, already used or issued to another account. Sign in to the invited account or ask a project leader to send a new invitation.'}</p>{accountEmail ? <small>Signed in as {accountEmail}</small> : null}<Button size="sm" onClick={() => setPreviewRetry((value) => value + 1)}>Try again</Button></div></div> : null}
      {inviteState === 'sign-in' && !preview ? <div className="pc-state-card"><span className="pc-icon"><Users size={18} /></span><div><h3>Sign in to join this project</h3><p>Sign in with the Mingle account that received this invitation. Your invitation stays in this window while sign-in finishes.</p>
        {account?.status === 'signing-in' ? <p className="pc-loading" role="status">Finish signing in in your browser. This window will resume automatically.</p> : account?.configured
          ? <Button variant="primary" size="sm" disabled={account.status === 'restoring'} onClick={() => void signIn()}>Continue with Google</Button>
          : <Button size="sm" onClick={onOpenAccountSettings}>Set up Mingle account</Button>}
        {account?.browserError ? <p className="pc-help">{account.browserError}</p> : null}
      </div></div> : null}
      {inviteState === 'wrong-account' && !preview ? <div className="pc-state-card pc-state-card--error"><CircleAlert size={19} /><div><h3>Use the invited account</h3><p>{previewError || 'Sign in with the verified Mingle email address that received this invitation.'} {accountEmail ? `You’re signed in as ${accountEmail}.` : ''}</p><Button size="sm" onClick={() => void switchAccount()}>Switch account</Button></div></div> : null}

      {preview && step === 'invite' && !['loading', 'unavailable', 'expired', 'revoked', 'error'].includes(inviteState) ? <>
        <section className="pc-join-confirm" aria-labelledby="pc-join-confirm-title">
          <div className="pc-join-summary"><div className="pc-join-mark"><Users size={18} /></div><div><span>PROJECT INVITATION</span><strong id="pc-join-confirm-title">{preview.projectName}</strong><small>Invited as {preview.email}</small></div><Badge tone="ok">Verified</Badge></div>
          <dl className="pc-invitation-details">
            {preview.inviterDisplayName || preview.inviterEmail ? <div><dt>Invited by</dt><dd>{preview.inviterDisplayName || preview.inviterEmail}{preview.inviterDisplayName && preview.inviterEmail ? ` · ${preview.inviterEmail}` : ''}</dd></div> : null}
            <div><dt>Your role</dt><dd>{preview.role === 'admin' ? 'Project admin' : 'Project member'}</dd></div>
            <div><dt>Repository</dt><dd><code>{preview.repositoryUrl}</code></dd></div>
            {preview.expiresAt ? <div><dt>Invitation expires</dt><dd>{new Date(preview.expiresAt).toLocaleString()}</dd></div> : null}
          </dl>
          {inviteState === 'sign-in' ? <div className="pc-state-card"><span className="pc-icon"><Users size={18} /></span><div><h3>Sign in to join this project</h3><p>This invitation is for {preview.email}. Sign in to that Mingle account to continue. Your invitation stays in this window while sign-in finishes.</p>
            {account?.status === 'signing-in' ? <p className="pc-loading" role="status">Finish signing in in your browser. This window will resume automatically.</p> : account?.configured
              ? <Button variant="primary" size="sm" disabled={account.status === 'restoring'} onClick={() => void signIn()}>Continue with Google</Button>
              : <Button size="sm" onClick={onOpenAccountSettings}>Set up Mingle account</Button>}
            {account?.browserError ? <p className="pc-help">{account.browserError}</p> : null}
          </div></div> : null}
          {inviteState === 'wrong-account' ? <div className="pc-state-card pc-state-card--error"><CircleAlert size={19} /><div><h3>Use the invited account</h3><p>This invitation is for {preview.email}. {accountEmail ? `You’re signed in as ${accountEmail}.` : ''}</p><Button size="sm" onClick={() => void switchAccount()}>Switch account</Button></div></div> : null}
          {accountEmail && !emailMatches ? <div className="pc-inline-note pc-inline-note--warning" role="alert">Switch to {preview.email} before continuing.</div> : null}
          {error ? <InlineError>{error}</InlineError> : null}
          <div className="pc-join-actions"><Button type="button" variant="ghost" onClick={onClose}>Not now</Button><Button type="button" variant="primary" disabled={!canContinueInvite} onClick={() => { setError(null); setStep('workspace'); }}>Join project <ChevronRight size={15} /></Button></div>
        </section>
      </> : null}

      {preview && step === 'workspace' && inviteState === 'ready' ? <>
        <section className="pc-workspace-step" aria-labelledby="pc-workspace-heading">
          <h3 id="pc-workspace-heading">Clone the invited repository</h3>
          <p className="pc-step-copy">Choose a parent folder. Mingle will create the checkout there and register it as a project.</p>
          <div className="pc-repository-url"><GitBranch size={14} /> <code>{preview.repositoryUrl}</code></div>
          <div className="pc-directory-picker">
            <form className="pc-directory-path" onSubmit={(event) => { event.preventDefault(); void loadDirectory(directoryPath); }}>
              <label className="pc-field"><span>Parent folder</span><input value={directoryPath} onChange={(event) => setDirectoryPath(event.target.value)} autoComplete="off" spellCheck={false} aria-label="Repository destination parent folder" /></label>
              <Button type="submit" size="sm" disabled={directoryLoading || !directoryPath.trim()} busy={directoryLoading}>Browse</Button>
            </form>
            {directoryError ? <InlineError onRetry={() => void loadDirectory(directoryPath)}>{directoryError}</InlineError> : null}
            {directoryListing?.truncated ? <p className="pc-directory-notice" role="status">Folder results are limited. Browse into a folder or type a more specific path.</p> : null}
            {directoryListing ? <div className="pc-directory-tools"><Button size="sm" variant="ghost" disabled={!directoryListing.parentPath || directoryLoading} onClick={() => void loadDirectory(directoryListing.parentPath!)}><ArrowLeft size={13} />Parent</Button><Button size="sm" variant="ghost" disabled={directoryLoading} onClick={() => void loadDirectory(directoryListing.homePath)}>Home</Button></div> : null}
            {directoryListing ? <div className="pc-directory-list" role="group" aria-label="Folders in destination parent" aria-busy={directoryLoading}>
              {listedDirectories.map((directory) => <button key={directory.path} type="button" disabled={directoryLoading} onClick={() => void loadDirectory(directory.path)}><FolderOpen size={14} /><span>{directory.name}</span><ChevronRight size={13} /></button>)}
              {!listedDirectories.length ? <p>{directoryLoading ? 'Loading folders…' : 'No folders here.'}</p> : null}
            </div> : null}
            {directoryListing?.roots.length ? <div className="pc-directory-roots" aria-label="Available locations">{directoryListing.roots.map((root) => <Button key={root.path} size="sm" variant="ghost" disabled={directoryLoading} onClick={() => void loadDirectory(root.path)}>{root.name}</Button>)}</div> : null}
          </div>
          <label className="pc-field"><span>Folder name</span><input value={folderName} onChange={(event) => setFolderName(event.target.value)} maxLength={100} autoComplete="off" /></label>
          <p className="pc-resulting-path"><span>Checkout path</span><code>{resultingPath || 'Choose a parent folder and checkout name'}</code></p>
          <div className="pc-source-tabs" role="group" aria-label="Choose repository checkout source">
            <button type="button" aria-pressed={source === 'clone'} onClick={() => { setSource('clone'); setSelectedProjectId(''); setError(null); }}>Clone repository</button>
            <button type="button" aria-pressed={source !== 'clone'} onClick={() => { setSource('project'); setError(null); }}>I already have a checkout</button>
          </div>
          {source !== 'clone' ? <div className="pc-existing-checkout">
            {projects.filter((project) => !project.isExample).length ? <div className="pc-project-choices" role="radiogroup" aria-label="Registered local projects">
              {projects.filter((project) => !project.isExample).map((project) => <button type="button" role="radio" aria-checked={selectedProjectId === project.id} className={`pc-project-choice${selectedProjectId === project.id ? ' is-selected' : ''}`} key={project.id} onClick={() => { setSelectedProjectId(project.id); setSource('project'); setError(null); }}><FolderOpen size={15} /><span><strong>{project.name}</strong><small>{project.path}</small></span>{selectedProjectId === project.id ? <Check size={15} /> : null}</button>)}
            </div> : <p className="pc-empty">No local projects are registered on this device yet.</p>}
            <form className="pc-local-folder-form" onSubmit={(event) => void addExistingFolder(event)}><label className="pc-field"><span>Or open a local folder</span><input value={folderPath} onChange={(event) => { setFolderPath(event.target.value); setSource('folder'); setSelectedProjectId(''); }} placeholder="/path/to/project" autoComplete="off" spellCheck={false} /></label><Button type="submit" size="sm" disabled={!folderPath.trim() || workspaceBusy} busy={workspaceBusy}>Use this folder</Button></form>
          </div> : null}
          {error ? <InlineError>{error}</InlineError> : null}
          <div className="pc-join-actions"><Button type="button" variant="ghost" disabled={workspaceBusy} onClick={() => { setError(null); setStep('invite'); }}><ArrowLeft size={14} />Back</Button>
            {source === 'clone' ? <Button type="button" variant="primary" disabled={!preview.repositoryUrl || !directoryPath.trim() || !cloneName || workspaceBusy || !emailMatches} busy={workspaceBusy} onClick={() => void cloneRepository()}>Clone and continue</Button>
              : <Button type="button" variant="primary" disabled={!canContinueWorkspace} onClick={() => { setError(null); setStep('agents'); }}>Use this checkout <ChevronRight size={15} /></Button>}
          </div>
          {source === 'clone' && workspaceBusy ? <p className="pc-loading" role="status">Cloning repository… This may take a little while.</p> : null}
        </section>
      </> : null}

      {preview && step === 'agents' && inviteState === 'ready' ? <section className="pc-agent-step" aria-labelledby="pc-agent-heading">
        <h3 id="pc-agent-heading">Choose one or more local agents</h3>
        <p className="pc-step-copy">Agents are created idle and use your existing provider sign-ins. No model run starts during joining.</p>
        {selectedProject ? <p className="pc-project-ref"><FolderOpen size={13} /> {selectedProject.name}<span>· {selectedProject.path}</span></p> : null}
        {!eligibleProviders.length ? <div className="pc-state-card pc-state-card--setup"><CircleAlert size={19} /><div><h3>No eligible provider is ready</h3><p>Choose an available Claude, Codex, or OpenCode provider with a Supervised model. Provider authentication and setup remain on this device.</p><Button size="sm" onClick={onOpenProviderSettings}>Open provider settings</Button></div></div> : null}
        <div className="pc-provider-availability" aria-label="Provider availability">
          {JOIN_PROVIDERS.map((id) => {
            const info = providers.find((candidate) => candidate.id === id);
            const choices = info ? supervisedModels(info) : [];
            const status = !info ? 'Not reported by this device' : !info.available ? `Unavailable${info.reason ? ` · ${info.reason}` : ''}`
              : !choices.length ? `Available, but no Supervised model is reported${info.reason ? ` · ${info.reason}` : ''}`
                : `${choices.length} Supervised model${choices.length === 1 ? '' : 's'} available${info.reason ? ` · ${info.reason}` : ''}`;
            return <p key={id} className={info?.available && choices.length ? 'is-available' : ''}><ProviderMark provider={id} size={15} /><strong>{info?.name ?? id}</strong><span>{status}</span></p>;
          })}
          <Button size="sm" variant="ghost" onClick={onOpenProviderSettings}>Provider settings</Button>
        </div>
        {agentDrafts.map((draft, index) => {
          const info = eligibleProviders.find((candidate) => candidate.id === draft.provider);
          const models = supervisedModels(info);
          const model = models.find((candidate) => candidate.id === draft.model);
          const efforts = info && model ? reasoningChoices(info, model) : [];
          const policies = info && model ? policyChoices(info, model) : [];
          return <fieldset className="pc-agent-card" key={draft.id}><legend>Agent {index + 1}</legend>
            <div className="pc-agent-config">
              <label className="pc-field"><span>Provider</span><select value={draft.provider} onChange={(event) => setAgentProvider(index, event.target.value)}>{eligibleProviders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="pc-field"><span>Model</span><select value={model?.id ?? ''} onChange={(event) => {
                const next = models.find((item) => item.id === event.target.value);
                if (!next) return;
                setAgentDrafts((current) => current.map((entry, rowIndex) => {
                  if (rowIndex !== index) return entry;
                  const policies = policyChoices(info, next);
                  return { ...entry, model: next.id, effort: preferredEffort(info!, next), policy: policies.includes(entry.policy) ? entry.policy : 'supervised' };
                }));
              }}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="pc-field"><span>Reasoning effort</span><select value={draft.effort} onChange={(event) => setAgentDrafts((current) => current.map((entry, rowIndex) => rowIndex === index ? { ...entry, effort: event.target.value } : entry))}>{efforts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <label className="pc-field"><span>Permissions</span><select value={draft.policy} onChange={(event) => setAgentDrafts((current) => current.map((entry, rowIndex) => rowIndex === index ? { ...entry, policy: event.target.value as Policy } : entry))}>{policies.map((policy) => <option key={policy} value={policy} title={POLICY_DESCRIPTION[policy]}>{POLICY_LABEL[policy]}</option>)}</select></label>
            </div>
            {model && !model.reasoningEfforts ? <small className="pc-workspace-note">This model did not report effort choices; these are Mingle’s documented local runtime defaults.</small> : null}
            <div className="pc-agent-card-footer"><span><Check size={13} /> {POLICY_LABEL[draft.policy]} · {POLICY_DESCRIPTION[draft.policy]}</span>{agentDrafts.length > 1 ? <Button type="button" size="sm" variant="ghost" onClick={() => setAgentDrafts((current) => current.filter((item) => item.id !== draft.id))}><X size={13} />Remove</Button> : null}</div>
          </fieldset>;
        })}
        {eligibleProviders.length && agentDrafts.length < 4 ? <Button type="button" size="sm" variant="ghost" className="pc-add-agent" onClick={() => {
          const provider = eligibleProviders[0]!;
          const model = supervisedModels(provider)[0]!;
          setAgentDrafts((current) => [...current, { id: nextAgentId.current++, provider: provider.id as Provider, model: model.id, effort: preferredEffort(provider, model), policy: 'supervised' }]);
        }}><Plus size={14} />Add another agent</Button> : null}
        {error ? <InlineError>{error}</InlineError> : null}
        <div className="pc-join-actions"><Button type="button" variant="ghost" disabled={joining} onClick={() => { setError(null); setStep('workspace'); }}><ArrowLeft size={14} />Back</Button>
          <Button type="button" variant="primary" disabled={!canJoin} busy={joining} onClick={() => void joinProject()}>Join project</Button>
        </div>
        <p className="pc-no-run-note">The leader can see these agents in the shared project roster. Runs from teammates follow the team permission level. Provider credentials stay on this device.</p>
      </section> : null}

      {step === 'consent' && joinResult ? <TeamConsentSheet
        projectId={joinResult.projectId || selectedProjectId}
        initialSelectedSessionIds={joinResult.sessionIds}
        presentation="inline"
        onClose={() => { setConsentSkipped(true); setStep('success'); }}
        onAccepted={() => { setConsentSkipped(false); setStep('success'); }}
      /> : null}

      {step === 'success' && joinResult ? <div className="pc-state-card pc-state-card--success"><Check size={19} /><div><h3>You’re in</h3><p>{joinSuccessCopy(joinResult.sessionIds.length, consentSkipped)}</p><Button variant="primary" size="sm" onClick={() => { onJoined?.(joinResult); onClose(); }}>Open project</Button></div></div> : null}
    </div>
  </Modal>;
}
