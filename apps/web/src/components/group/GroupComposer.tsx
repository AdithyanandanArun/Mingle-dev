import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, AtSign, FilePlus2, Square, X } from 'lucide-react';
import type { AttachmentRef, GroupSnapshot, NativeActionCatalog, Provider, Session } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import { api, errorMessage } from '../../lib/api';
import { cx } from '../../lib/format';
import { stopGroup } from '../../lib/groupActions';
import {
  MODE_LABEL, ROLE_LABEL, activeMembers, defaultRecipients, isBusy, maskNonActionable, providerAvailability, providerName, resolveMentions, retiredHandles, type MentionCandidate,
} from '../../lib/groups';
import { MOD } from '../ui';
import { Popover } from '../git/Popover';
import { UsagePanel } from '../UsagePanel';
import { AgentIdentity } from './AgentIdentity';
import { AttachmentDrafts, AttachmentTray, useAttachmentDraft } from '../AttachmentDrafts';
import { usePresence } from '../../lib/motion';
import {
  appendContextReference, ContextReferenceChips, EMPTY_CONTEXT_REFS, FileContextPicker,
  findFileMentionTrigger, removeFileMentionTrigger, type FileMentionTrigger,
} from '../MessageContextControls';

const COMMANDS = [
  { name: 'new', description: 'Create a new session' },
  { name: 'stop', description: 'Interrupt active agent runs and pause queued work; resume explicitly to continue' },
  { name: 'members', description: 'Open participants, status and settings' },
  { name: 'agent', description: 'Add another agent to this group' },
  { name: 'settings', description: 'Open Settings' },
  { name: 'model', description: 'Edit a member’s model in Members' },
  { name: 'effort', description: 'Edit a member’s effort in Members' },
  { name: 'permissions', description: 'Edit a member’s permissions in Members' },
  { name: 'tier', description: 'Edit a member’s service tier in Members' },
  { name: 'skills', description: 'Use @handle $skill-name to call a provider skill' },
  { name: 'usage', description: 'Show provider limits (add @handle for a member)' },
  { name: 'compact', description: 'Compact one member’s context with its provider' },
  { name: 'import', description: 'Import a local supported provider conversation' },
  { name: 'status', description: 'Show this group’s mode and members' },
  { name: 'diff', description: 'Open the Changes pane' },
  { name: 'help', description: 'List Mingle commands' },
] as const;
const LOCAL_COMMAND = new RegExp(`^/(${COMMANDS.map((command) => command.name).join('|')})(?:\\s.*)?$`, 'i');
const MAX_RECIPIENTS = 8;

interface Suggestion { key: string; token: string; description: string; group: string; identityKey?: string; provider?: Provider; browseFiles?: boolean; action?: { kind: 'command' | 'skill'; id: string; name: string } }

/** The group conversation's composer: it resolves recipients itself and sends one message to the group endpoint. */
export function GroupComposer({ snapshot, anchor, onOpenMembers, footer }: { snapshot: GroupSnapshot; anchor: Session; onOpenMembers: () => void; footer?: ReactNode }) {
  const draft = useMingle((s) => s.drafts[anchor.id] ?? '');
  const contextRefs = useMingle((s) => s.contextDrafts[anchor.id] ?? EMPTY_CONTEXT_REFS);
  const connection = useMingle((s) => s.connection);
  const providers = useMingle((s) => s.boot?.providers);
  const sessions = useMingle((s) => s.boot?.sessions);
  const ref = useRef<HTMLTextAreaElement>(null);
  const compactController = useRef<{ controller: AbortController; targetSessionId: string; operationId: string } | null>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  const pendingId = useRef<{ key: string; id: string } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [planningMode, setPlanningMode] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  useEffect(() => { setAttachments([]); setCompactStatus(null); setPlanningMode(false); }, [snapshot.group.id]);
  const [filePickerQuery, setFilePickerQuery] = useState('');
  const [filePickerSessionId, setFilePickerSessionId] = useState(anchor.id);
  const fileMentionTrigger = useRef<FileMentionTrigger | null>(null);
  const filePickerRestoreCaret = useRef<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compactStatus, setCompactStatus] = useState<{ status: 'running' | 'completed' | 'unsupported' | 'failed'; handle?: string; message?: string } | null>(null);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [usageSession, setUsageSession] = useState<Session | null>(null);
  const usageSessionRef = useRef(usageSession);
  usageSessionRef.current = usageSession;
  const usageCloseVersion = useRef(0);
  const usageFocusFrame = useRef<number | null>(null);
  const [nativeCatalog, setNativeCatalog] = useState<NativeActionCatalog | null>(null);
  const [nativeCatalogError, setNativeCatalogError] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [selectedNativeAction, setSelectedNativeAction] = useState<{ kind: 'command' | 'skill'; id: string; name: string } | null>(null);
  const attachmentDraft = useAttachmentDraft({ kind: 'group', id: snapshot.group.id }, attachments, setAttachments, setError);
  const openUsage = useCallback((session: Session) => {
    usageCloseVersion.current++;
    if (usageFocusFrame.current !== null) window.cancelAnimationFrame(usageFocusFrame.current);
    usageFocusFrame.current = null;
    setUsageSession(session);
  }, []);
  const closeUsage = useCallback(() => {
    setUsageSession(null);
    const version = ++usageCloseVersion.current;
    if (usageFocusFrame.current !== null) window.cancelAnimationFrame(usageFocusFrame.current);
    usageFocusFrame.current = window.requestAnimationFrame(() => {
      usageFocusFrame.current = null;
      if (version === usageCloseVersion.current && !usageSessionRef.current) ref.current?.focus();
    });
  }, []);
  useEffect(() => () => { if (usageFocusFrame.current !== null) window.cancelAnimationFrame(usageFocusFrame.current); }, []);

  const members = useMemo(() => activeMembers(snapshot), [snapshot]);
  const retired = useMemo(() => retiredHandles(snapshot), [snapshot]);
  const sessionOf = (sessionId: string) => sessions?.find((session) => session.id === sessionId);
  const candidates = useMemo<MentionCandidate[]>(
    () => members.flatMap((member) => {
      const provider = sessions?.find((session) => session.id === member.sessionId)?.provider;
      return provider ? [{ id: member.id, handle: member.handle, provider }] : [{ id: member.id, handle: member.handle }];
    }),
    [members, sessions],
  );
  const caretIndex = Math.min(caret, draft.length);
  const mentions = useMemo(() => resolveMentions(draft, candidates, retired), [draft, candidates, retired]);
  const pickedActive = picked.filter((id) => members.some((member) => member.id === id));
  const stalePicked = picked.filter((id) => !members.some((member) => member.id === id));
  const staleSelectionError = stalePicked.length ? 'A selected recipient was removed. Remove the unavailable recipient chip or clear selection before sending.' : null;
  const direct = members.filter((member) => pickedActive.includes(member.id) || mentions.ids.includes(member.id));
  const actionTargetId = mentions.ids.length === 1 ? mentions.ids[0] : pickedActive.length === 1 ? pickedActive[0] : null;
  const actionTargetSession = actionTargetId ? sessionOf(members.find((member) => member.id === actionTargetId)?.sessionId ?? '') : undefined;
  const actionCatalogKey = `${actionTargetId ?? ''}:${actionTargetSession?.provider ?? ''}:${actionTargetSession?.model ?? ''}:${actionTargetSession?.providerSessionId ?? ''}`;
  const defaults = useMemo(() => defaultRecipients(snapshot), [snapshot]);
  const recipients = direct.length ? direct : defaults;
  const fileContextSource = (text: string) => {
    const targetIds = new Set([...pickedActive, ...resolveMentions(text, candidates, retired).ids]);
    const targets = members.filter((member) => targetIds.has(member.id));
    return targets.length === 1 ? targets[0]!.sessionId : anchor.id;
  };
  const openFilePicker = (query = '', sourceDraft = draft, trigger: FileMentionTrigger | null = null) => {
    fileMentionTrigger.current = trigger;
    filePickerRestoreCaret.current = null;
    setFilePickerQuery(query);
    setFilePickerSessionId(fileContextSource(sourceDraft));
    setFilePickerOpen(true);
  };
  const closeFilePicker = () => {
    const position = filePickerRestoreCaret.current ?? fileMentionTrigger.current?.end ?? caret;
    filePickerRestoreCaret.current = null;
    fileMentionTrigger.current = null;
    setFilePickerOpen(false);
    requestAnimationFrame(() => {
      const input = ref.current;
      if (!input) return;
      const caretAt = Math.min(position, input.value.length);
      input.focus();
      input.setSelectionRange(caretAt, caretAt);
    });
  };
  const anyBusy = members.some((member) => isBusy(sessionOf(member.sessionId)));

  const empty = draft.trim().length === 0 && attachments.length === 0 && attachmentDraft.uploads.length === 0;
  const local = attachments.length || attachmentDraft.uploads.length ? null : LOCAL_COMMAND.exec(draft.trim());
  const compactText = maskNonActionable(draft).trim();
  const compactCandidate = /^\/compact(?:\b|$)/i.test(compactText) || /^@[A-Za-z0-9_-]+\s+\/compact(?:\b|$)/i.test(compactText);
  const compactSyntax = /^\/compact(?:\s+@([A-Za-z0-9_-]+))?\s*$/i.exec(compactText)
    ?? /^@([A-Za-z0-9_-]+)\s+\/compact\s*$/i.exec(compactText);
  const unavailable = recipients.map((member) => {
    const session = sessionOf(member.sessionId);
    const state = session && providers ? providerAvailability(providers, session.provider) : null;
    return state && !state.available ? `@${member.handle}: ${providerName(session!.provider)} needs setup — ${state.reason}` : null;
  }).find(Boolean) ?? null;
  const blocker = connection !== 'online' ? 'Disconnected from the Mingle server — reconnect to send.'
    : recipients.length === 0 ? 'No agent is set to receive unaddressed messages. Mention an agent or choose a recipient.'
      : recipients.length > MAX_RECIPIENTS ? `A message can address at most ${MAX_RECIPIENTS} agents.`
        : planningMode && recipients.length !== 1 ? 'Native plan mode must target exactly one agent. Choose one recipient or mention one @handle.'
          : unavailable;
  const problem = staleSelectionError ?? mentions.problems[0]?.message ?? null;
  const sendDisabled = sending || (attachmentDraft.busy && !compactCandidate) || empty || (!local && !compactCandidate && (Boolean(blocker) || Boolean(problem)));

  useEffect(() => {
    const controller = new AbortController();
    setNativeCatalog(null); setNativeCatalogError(null);
    if (!actionTargetId || connection !== 'online') return () => controller.abort();
    void api.groupActionCatalog(snapshot.group.id, actionTargetId, controller.signal, catalogRevision > 0).then((value) => {
      if (!controller.signal.aborted) setNativeCatalog(value);
    }).catch((cause) => { if (!controller.signal.aborted) setNativeCatalogError(errorMessage(cause)); });
    return () => controller.abort();
  }, [snapshot.group.id, actionCatalogKey, connection, catalogRevision]);
  useEffect(() => { setSelectedNativeAction(null); }, [actionCatalogKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft]);

  const actionable = useMemo(() => maskNonActionable(draft), [draft]);
  const before = actionable.slice(0, caretIndex);
  const commandMatch = before.match(/(?:^|\s)(\/[^\s]*)$/);
  const mentionMatch = commandMatch ? null : before.match(/(?:^|[\s([{"'“‘,;:!?])@([A-Za-z0-9_-]*)$/);
  const skillMatch = !commandMatch && !mentionMatch ? /(?:^|\s)(\$[^\s]*)$/.exec(before) : null;
  const skillTrigger = Boolean(skillMatch);
  const trigger = commandMatch?.[1] ?? (mentionMatch ? `@${mentionMatch[1]}` : skillMatch?.[1] ?? '');
  const triggerStart = caretIndex - trigger.length;
  const suggestions: Suggestion[] = (() => {
    if (commandMatch) {
      const localCommands = COMMANDS.filter((command) => command.name.startsWith(trigger.slice(1).toLowerCase())).map((command) => ({ key: `c:${command.name}`, token: `/${command.name}`, description: command.description, group: 'Mingle' }));
      const nativeCommands = actionTargetId ? (nativeCatalog?.commands ?? []).filter((command) => command.name.toLowerCase().startsWith(trigger.slice(1).toLowerCase())).map((command) => ({
        key: `native-command:${command.id}`, token: `/${command.name}`, description: command.description || 'Provider command', group: 'Provider', action: { kind: 'command' as const, id: command.id, name: command.name },
      })) : [];
      return [...localCommands, ...nativeCommands];
    }
    if (mentionMatch) {
      const query = mentionMatch[1]!.toLowerCase();
      const matching = members.filter((member) => member.handle.toLowerCase().startsWith(query));
      // Provider aliases address the sole matching agent; several agents list their individual handles instead.
      const aliasProviders = ['claude', 'codex', 'antigravity', 'opencode'] as const satisfies readonly Provider[];
      const matched = aliasProviders.flatMap((aliasProvider) => {
        const same = members.filter((member) => sessionOf(member.sessionId)?.provider === aliasProvider);
        const matchesAlias = Boolean(query && aliasProvider.startsWith(query)) && !matching.some((member) => member.handle.toLowerCase() === aliasProvider);
        return matchesAlias ? [{ aliasProvider, same }] : [];
      });
      const alias = matched.filter((entry) => entry.same.length === 1).map(({ aliasProvider, same }) => ({
        key: `provider:${aliasProvider}:${same[0]!.id}`, memberId: same[0]!.id, token: `@${aliasProvider}`, description: `${providerName(aliasProvider)} agent · @${same[0]!.handle}`, group: 'Providers', identityKey: same[0]!.sessionId, provider: aliasProvider as Provider,
      }));
      const aliasChoices = matched.filter((entry) => entry.same.length > 1).flatMap((entry) => entry.same);
      const seen = new Set<string>();
      const choices = [...alias, ...aliasChoices, ...matching].filter((member) => {
        const id = 'memberId' in member ? member.memberId : member.id;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const fileChoice: Suggestion[] = 'files'.startsWith(query) ? [{ key: 'browse-files', token: '@files', description: 'Choose files from the targeted worktree', group: 'Workspace context', browseFiles: true }] : [];
      return [...fileChoice, ...choices.slice(0, 8).map((member) => {
        if ('token' in member) return member;
        const session = sessionOf(member.sessionId);
        return { key: `m:${member.id}`, token: `@${member.handle}`, description: `${ROLE_LABEL[member.role]}${session ? ` · ${providerName(session.provider)} ${session.model}` : ''}`, group: 'Agents', identityKey: member.sessionId, provider: session?.provider };
      })];
    }
    if (skillTrigger && actionTargetId && nativeCatalog) return nativeCatalog.skills.filter((skill) => skill.enabled && skill.name.toLowerCase().startsWith(before.match(/(?:^|\s)\$([^\s]*)$/)?.[1]?.toLowerCase() ?? '')).map((skill) => ({ key: `native-skill:${skill.id}`, token: `$${skill.name}`, description: skill.description, group: 'Provider skill', action: { kind: 'skill' as const, id: skill.id, name: skill.name } }));
    return [];
  })();
  const open = focused && suggestions.length > 0 && trigger !== dismissed;
  const { present: pickerPresent, closing: pickerClosing } = usePresence(open);
  const pickerSnapshot = useRef<{ suggestions: Suggestion[]; active: number; command: boolean } | null>(null);
  if (open) pickerSnapshot.current = { suggestions, active, command: Boolean(commandMatch) };
  const displayedPicker = open ? { suggestions, active, command: Boolean(commandMatch) } : pickerSnapshot.current;
  useEffect(() => { setDismissed((current) => (current === trigger ? current : null)); setActive(0); }, [trigger]);
  useEffect(() => { document.getElementById(`${pickerId}-option-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, pickerId, open]);

  const setDraft = (text: string) => useMingle.getState().setDraft(anchor.id, text);
  const choose = (index: number) => {
    const item = suggestions[index];
    if (!item) return;
    if (item.browseFiles) {
      const text = `${draft.slice(0, triggerStart)}${draft.slice(caretIndex)}`;
      setDraft(text); setCaret(triggerStart); setDismissed(null);
      openFilePicker('', text);
      return;
    }
    setSelectedNativeAction(item.action ?? null);
    const text = `${draft.slice(0, triggerStart)}${item.token} ${draft.slice(caretIndex)}`;
    const next = triggerStart + item.token.length + 1;
    setDraft(text);
    setCaret(next);
    setDismissed(null);
    requestAnimationFrame(() => { const input = ref.current; input?.focus(); input?.setSelectionRange(next, next); });
  };

  const runLocal = async (name: string): Promise<void> => {
    const store = useMingle.getState();
    switch (name) {
      case 'new': await store.createSession(); return;
      case 'stop': await stopGroup(snapshot); return;
      case 'settings': store.openSettings(); return;
      case 'members': case 'model': case 'effort': case 'permissions': case 'tier': onOpenMembers(); return;
      case 'agent': store.openDialog({ kind: 'add-agent', sessionId: anchor.id }); return;
      case 'import': store.openDialog({ kind: 'import' }); return;
      case 'diff': store.setContextTab('changes'); return;
      case 'skills': store.toast('info', 'Address a native skill directly, such as @codex1 $skill-name task, or @claude1 $project-skill task.'); return;
      case 'compact': return;
      case 'status': {
        const lead = members.find((member) => member.id === snapshot.group.orchestratorMemberId);
        store.toast('info', `${MODE_LABEL[snapshot.group.mode]} · ${members.map((member) => `@${member.handle}`).join(', ')}${lead ? ` · ${lead.handle} ${snapshot.group.mode === 'orchestrated' ? 'coordinates' : 'leads'}` : ''}${snapshot.group.paused ? ' · paused' : ''}`);
        return;
      }
      case 'help': store.toast('info', `Mingle commands: ${COMMANDS.map((command) => `/${command.name}`).join(', ')}. Use @handle /compact or /compact @handle to compact one member; Type @ to address an agent.`); return;
      case 'usage': {
        if (staleSelectionError) throw new Error(staleSelectionError);
        const resolved = resolveMentions(draft, candidates, retired);
        if (resolved.problems.length) throw new Error(resolved.problems[0]!.message);
        const targets = resolved.ids.length ? resolved.ids : pickedActive;
        if (targets.length > 1) throw new Error('Choose one @handle for /usage.');
        const target = targets.length === 1 ? members.find((member) => member.id === targets[0]) : null;
        const session = sessionOf(target?.sessionId ?? anchor.id) ?? anchor;
        openUsage(session);
        return;
      }
      default: return;
    }
  };

  const submit = async () => {
    if (sending) return;
    if (compactCandidate && attachmentDraft.isBusy()) {
      setError('Wait for the attachment upload to finish, then remove or send the attachments before compacting. They remain in your draft.');
      return;
    }
    if (empty || attachmentDraft.isBusy()) return;
    if (compactCandidate && attachmentDraft.uploads.length) {
      setError('Retry or remove each failed attachment before compacting. They remain in your draft.');
      return;
    }
    if (attachmentDraft.uploads.length) { setError('Retry or remove each failed attachment before sending.'); return; }
    if (compactCandidate) {
      setSending(true);
      setError(null);
      try {
        if (!compactSyntax) throw new Error('Choose exactly one member: @handle /compact or /compact @handle.');
        if (attachments.length) throw new Error('Remove or send the attachments before compacting. They remain in your draft.');
        if (connection !== 'online') throw new Error('Reconnect to Mingle before compacting a member.');
        if (mentions.problems.length) throw new Error(mentions.problems[0]!.message);
        const explicitIds = [...new Set([...mentions.ids, ...pickedActive])];
        if (explicitIds.length !== 1) throw new Error('Choose exactly one explicit member with @handle or the recipient picker. Group defaults are not used for compaction.');
        const member = members.find((item) => item.id === explicitIds[0]);
        if (!member) throw new Error('That member is no longer active in this group. Refresh the roster and choose an active member.');
        const target = sessionOf(member.sessionId);
        if (!target) throw new Error(`@${member.handle} has no available session to compact.`);
        if (isBusy(target)) throw new Error(`@${member.handle} is busy. Wait for its run to finish before compacting.`);
        setCompactStatus({ status: 'running', handle: member.handle });
        const controller = new AbortController();
        const operationId = crypto.randomUUID();
        compactController.current = { controller, targetSessionId: target.id, operationId };
        try {
          const result = await api.compactSession(target.id, controller.signal, operationId);
          if (result.status === 'completed') {
            setCompactStatus({ status: 'completed', handle: member.handle, message: result.message || 'Context compacted.' });
            if (useMingle.getState().drafts[anchor.id] === draft) setDraft('');
            await useMingle.getState().refreshNow();
          } else if (result.status === 'unsupported') {
            setCompactStatus({ status: 'unsupported', handle: member.handle, message: result.error || result.message || `${providerName(target.provider)} does not support manual compaction.` });
          } else {
            const message = result.error || result.message || `@${member.handle}’s provider could not compact this conversation.`;
            setCompactStatus({ status: 'failed', handle: member.handle, message });
          }
        } catch (cause) {
          if (!controller.signal.aborted) {
            setCompactStatus(null);
            throw cause;
          }
        } finally {
          if (compactController.current?.controller === controller) compactController.current = null;
        }
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setSending(false);
        ref.current?.focus();
      }
      return;
    }
    if (local) {
      setSending(true);
      setError(null);
      try {
        await runLocal(local[1]!.toLowerCase());
        if (useMingle.getState().drafts[anchor.id] === draft) setDraft('');
        await useMingle.getState().refreshNow();
      } catch (cause) { setError(errorMessage(cause)); } finally { setSending(false); }
      return;
    }
    if (blocker || problem) return;
    // Resolve against the current roster again at submission; stale recipient chips never dispatch.
    const fresh = resolveMentions(draft, candidates, retired);
    if (fresh.problems.length) { setError(fresh.problems[0]!.message); return; }
    const targets = members.filter((member) => pickedActive.includes(member.id) || fresh.ids.includes(member.id));
    const ids = (targets.length ? targets : defaults).map((member) => member.id);
    const content = draft.trim();
    const actionMatch = /^\s*(?:@([A-Za-z0-9_-]+)\s+)?([/$])([A-Za-z0-9][A-Za-z0-9_.:-]*)(?:\s+([\s\S]*))?$/.exec(content);
    // Prose may contain paths or shell variables; only leading syntax, optionally after mentions, is an action.
    const actionToken = /^\s*(?:@[A-Za-z0-9_-]+(?:\s*,\s*|\s+))*([/$])([A-Za-z0-9][A-Za-z0-9_.:-]*)(?:\s|$)/.exec(content);
    const nativeIntent = Boolean(actionToken);
    if (planningMode && nativeIntent) { setError('Native plan mode accepts a regular planning prompt, not provider commands or skills.'); return; }
    let invocation: import('@mingle/contracts').NativeInvocationInput | undefined;
    if (actionMatch && actionTargetId && nativeCatalog) {
      const symbol = actionMatch[2];
      const name = actionMatch[3]!;
      const kind = symbol === '$' ? 'skill' : 'command';
      const prior = selectedNativeAction?.kind === kind && selectedNativeAction.name === name ? selectedNativeAction : null;
      const exact = kind === 'skill' ? nativeCatalog.skills.filter((row) => row.enabled && row.name === name) : nativeCatalog.commands.filter((row) => row.name === name);
      const item = prior ? exact.find((row) => row.id === prior.id) : exact.length === 1 ? exact[0] : undefined;
      if (item) invocation = { kind, id: item.id, name: item.name, arguments: actionMatch[4] ?? '', recipient: actionTargetId };
    }
    if (nativeIntent) {
      const kind = actionMatch?.[2] ?? actionToken?.[1];
      const actionName = actionMatch?.[3] ?? actionToken?.[2];
      if (mentions.ids.length > 1 || pickedActive.length > 1) { setError('A provider command or skill must target exactly one agent. Mention one handle, such as @claude1.'); return; }
      if (!actionTargetId) { setError('Address a provider command or skill to one agent, for example @claude1 /review or @codex1 $skill-name.'); return; }
      if (!invocation || invocation.name !== actionName || (kind === '$' ? invocation.kind !== 'skill' : invocation.kind !== 'command')) { setError(nativeCatalogError ?? 'That action is unavailable or ambiguous. Refresh the menu and choose the listed action.'); return; }
    }
    const key = `${planningMode ? 'plan' : 'normal'}\u0000${targets.length ? 'direct' : 'default'}\u0000${content}\u0000${ids.join(',')}\u0000${attachments.map((item) => item.id).join(',')}\u0000${JSON.stringify(contextRefs)}\u0000${invocation ? `${invocation.kind}:${invocation.id}:${invocation.arguments}` : ''}`;
    const clientMessageId = pendingId.current?.key === key ? pendingId.current.id : crypto.randomUUID();
    pendingId.current = { key, id: clientMessageId };
    setSending(true);
    setError(null);
    try {
      const submittedContextRefs = contextRefs;
      const updated = await api.sendGroupMessage(snapshot.group.id, { content, intent: planningMode ? 'plan' : 'normal', ...(targets.length ? { recipients: ids } : {}), ...(attachments.length ? { attachmentIds: attachments.map((item) => item.id) } : {}), ...(submittedContextRefs.length ? { contextRefs: submittedContextRefs } : {}), ...(invocation ? { invocation } : {}), clientMessageId });
      const store = useMingle.getState();
      store.applyGroup(updated);
      if (store.drafts[anchor.id] === draft) setDraft('');
      if (store.contextDrafts[anchor.id] === submittedContextRefs) store.setContextDraft(anchor.id, []);
      setPicked([]);
      setPlanningMode(false);
      attachmentDraft.sent(attachments.map((item) => item.id));
      pendingId.current = null;
      await store.refreshNow();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const togglePick = (memberId: string) => setPicked((current) => (current.includes(memberId) ? current.filter((id) => id !== memberId) : [...current, memberId]));
  const stopCompaction = () => {
    const operation = compactController.current;
    if (!operation) return;
    operation.controller.abort();
    compactController.current = null;
    setSending(false);
    const handle = compactStatus?.handle;
    const message = `Stopped waiting for compaction${handle ? ` for @${handle}` : ''} and sent a cancellation request for this operation. Its outcome may be unknown; refresh before retrying.`;
    setCompactStatus({ status: 'failed', handle, message });
    setError(null);
    void api.interruptCompaction(operation.targetSessionId, operation.operationId).then(({ interrupted }) => {
      if (!interrupted) setCompactStatus({ status: 'failed', handle, message: 'No active compaction matched this cancellation request. It may have completed before cancellation arrived; refresh before retrying.' });
    }).catch((cause) => setCompactStatus({ status: 'failed', handle, message: `Compaction cancellation could not be confirmed: ${errorMessage(cause)}. Its outcome may be unknown.` })).finally(() => { void useMingle.getState().refreshNow(); });
  };
  const defaultLabel = snapshot.group.mode === 'cowork' ? 'default: all peers' : 'default: orchestrator';
  const note = error ?? problem ?? blocker ?? (planningMode ? 'Native plan mode is read-only. The plan will appear for review before execution.' : null);
  const noteIsError = Boolean(error ?? problem);

  return (
    <div className="composer-wrap">
      <div className={cx('composer composer--group', blocker && 'is-blocked')}>
        <div className="recips" role="group" aria-label="Recipients">
          <span className="recips__label">To</span>
          {stalePicked.map((id) => <span key={id} className="recips__chip is-stale" title="This recipient is no longer in the group">
            <AgentIdentity handle={snapshot.members.find((member) => member.id === id)?.handle ?? 'removed-agent'} identityKey={id} removed />
            <button type="button" aria-label="Remove unavailable recipient" onClick={() => togglePick(id)}><X size={10} aria-hidden="true" /></button>
          </span>)}
          {direct.length ? direct.map((member) => {
            const removable = pickedActive.includes(member.id);
            const mentioned = mentions.ids.includes(member.id);
            return (
              <span key={member.id} className={cx('recips__chip', mentioned && !removable && 'is-mention')} title={mentioned ? 'Mentioned in your message' : 'Selected recipient'}>
                <AgentIdentity handle={member.handle} identityKey={member.sessionId} provider={sessionOf(member.sessionId)?.provider} />
                {removable ? <button type="button" aria-label={`Remove @${member.handle} from recipients`} onClick={() => togglePick(member.id)}><X size={10} aria-hidden="true" /></button> : null}
              </span>
            );
          }) : defaults.length && !stalePicked.length ? <>
            {defaults.map((member) => <span key={member.id} className="recips__chip is-default"><AgentIdentity handle={member.handle} identityKey={member.sessionId} provider={sessionOf(member.sessionId)?.provider} /></span>)}
            <span className="recips__default">{defaultLabel}</span>
          </> : !stalePicked.length ? <span className="recips__default">no default recipient</span> : null}
          <button ref={pickerButton} type="button" className="recips__pick" aria-haspopup="dialog" aria-expanded={pickerOpen} onClick={() => setPickerOpen((value) => !value)}><AtSign size={12} aria-hidden="true" /> Choose</button>
          {picked.length ? <button type="button" className="recips__clear" onClick={() => setPicked([])}>Clear selection</button> : null}
        </div>
        <label htmlFor={`composer-${anchor.id}`} className="sr-only">Message the group</label>
        <ContextReferenceChips refs={contextRefs} disabled={sending} onRemove={(index) => useMingle.getState().setContextDraft(anchor.id, contextRefs.filter((_, i) => i !== index))} />
        <AttachmentTray attachments={attachments} busy={attachmentDraft.busy} uploads={attachmentDraft.uploads} onRetry={attachmentDraft.retry} onForget={attachmentDraft.forget} loading={attachmentDraft.loading} loadError={attachmentDraft.loadError} onReload={attachmentDraft.reload} onRemove={(id) => void attachmentDraft.remove(id)} disabled={sending || Boolean(blocker)} />
        <textarea
          id={`composer-${anchor.id}`} ref={ref} className="composer__input" rows={1} value={draft}
          role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open}
          aria-controls={open ? pickerId : undefined} aria-activedescendant={open ? `${pickerId}-option-${active}` : undefined}
          placeholder="Message the group — @handle targets one agent; @/path adds file context…"
          onChange={(event) => {
            const next = event.target.value;
            const nextCaret = event.target.selectionStart ?? next.length;
            setCaret(nextCaret); setDraft(next);
            if (compactStatus?.status !== 'running') setCompactStatus(null);
            const pathTrigger = findFileMentionTrigger(next, nextCaret);
            if (pathTrigger) openFilePicker(pathTrigger.query, next, pathTrigger);
            if (selectedNativeAction) {
              const escaped = selectedNativeAction.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const marker = selectedNativeAction.kind === 'skill' ? '\\$' : '/';
              if (!new RegExp(`(?:^|\\s)${marker}${escaped}(?=\\s|$)`).test(maskNonActionable(next))) setSelectedNativeAction(null);
            }
          }}
          onFocus={(event) => { setFocused(true); setCaret(event.currentTarget.selectionStart ?? 0); }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onPaste={attachmentDraft.onPaste}
          onBlur={(event) => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.composer-picker-empty'))) setFocused(false); }}
          onKeyDown={(event) => {
            if (filePickerOpen) {
              if (event.key === 'Escape') { event.preventDefault(); closeFilePicker(); }
              return;
            }
            if (open && !event.nativeEvent.isComposing) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return; }
              if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); choose(active); return; }
              if (event.key === 'Escape') { event.preventDefault(); setDismissed(trigger); return; }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
          }}
        />
        {pickerPresent && displayedPicker ? (
          <div className={cx('composer-picker', pickerClosing && 'is-closing')} id={pickerId} role="listbox" aria-label={displayedPicker.command ? 'Commands' : displayedPicker.suggestions.some((item) => item.browseFiles) ? 'Agents and workspace files' : 'Agents'} aria-hidden={pickerClosing || undefined} inert={pickerClosing}>
            {displayedPicker.suggestions.map((item, index) => (
              <div key={item.key}>
                {index === 0 || displayedPicker.suggestions[index - 1]?.group !== item.group ? <div className="composer-picker__group" role="presentation">{item.group}</div> : null}
                <div role="option" id={`${pickerId}-option-${index}`} aria-selected={index === displayedPicker.active} className={cx('composer-picker__item', index === displayedPicker.active && 'is-active')}
                  onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(index)}>
                  <span className="composer-picker__name">{item.identityKey ? <AgentIdentity handle={item.token.slice(1)} identityKey={item.identityKey} provider={item.provider} /> : item.token}</span><span className="composer-picker__description">{item.description}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {focused && (skillTrigger || commandMatch) && suggestions.length === 0 ? <div className="composer-picker-empty" role="status">
          {!actionTargetId ? 'Address one agent first, for example @claude1 /review or @codex1 $skill-name.'
            : nativeCatalogError ? `Could not load this agent’s actions: ${nativeCatalogError}`
              : !nativeCatalog ? 'Loading this agent’s actions…'
                : skillTrigger ? nativeCatalog.skills.length ? 'No matching skill.' : nativeCatalog.unsupported.join(' ')
                  : nativeCatalog.commands.length ? 'No matching command.' : nativeCatalog.unsupported.join(' ')}
          {actionTargetId && (nativeCatalog || nativeCatalogError) ? <> <button type="button" className="link-btn" onMouseDown={(event) => event.preventDefault()} onClick={() => { setCatalogRevision((value) => value + 1); ref.current?.focus(); }}>Refresh</button></> : null}
        </div> : null}
        <div className="composer__bar">
          <div className="composer__controls">
            <button type="button" className={cx('composer__plan-toggle', planningMode && 'is-active')} aria-pressed={planningMode} disabled={sending} title="Ask one group agent for a native read-only plan" onClick={() => { setPlanningMode((value) => !value); setSelectedNativeAction(null); setError(null); }}>
              {planningMode ? 'Planning on' : 'Plan'}
            </button>
          </div>
          <div className="composer__send">
            <button type="button" className="composer__context-button" onClick={() => openFilePicker()} disabled={sending || connection !== 'online'} aria-label="Add workspace file context" title="Add a file from the targeted worktree, or type @/path"><FilePlus2 size={15} /></button>
            <AttachmentDrafts scope={{ kind: 'group', id: snapshot.group.id }} busy={attachmentDraft.busy} onFiles={attachmentDraft.addFiles} disabled={sending || Boolean(blocker)} />
            {compactStatus?.status === 'running' ? <button type="button" className="sendbtn sendbtn--stop" onClick={stopCompaction} aria-label="Request cancellation of this compaction" title="Stop waiting and send a cancellation request"><Square size={12} fill="currentColor" /></button> :
              <button type="button" className="sendbtn" onClick={() => void submit()} disabled={sendDisabled}
                aria-label={compactCandidate ? 'Compact one member' : local?.[1]?.toLowerCase() === 'import' ? 'Import conversation' : local?.[1]?.toLowerCase() === 'usage' ? 'Open usage' : 'Send message'}
                title={compactCandidate ? 'Compact exactly one explicitly selected member' : sendDisabled ? (problem ?? blocker ?? (empty ? 'Write a message first' : 'Sending…')) : anyBusy ? `Send and queue for busy agents (${MOD}+Enter or Enter)` : `Send (${MOD}+Enter or Enter)`}>
                <ArrowUp size={15} />
              </button>}
          </div>
        </div>
      </div>
      <Popover anchor={pickerButton} open={pickerOpen} onClose={() => setPickerOpen(false)} label="Choose recipients" width={300} align="start" className="recips-pop">
        <fieldset className="recips-pop__list">
          <legend>Send to these agents</legend>
          {members.map((member) => {
            const session = sessionOf(member.sessionId);
            return (
              <label key={member.id} className="check">
                <input type="checkbox" checked={pickedActive.includes(member.id)} onChange={() => togglePick(member.id)} data-autofocus={member === members[0] ? '' : undefined} />
                <span><AgentIdentity handle={member.handle} identityKey={member.sessionId} provider={session?.provider} /><small>{ROLE_LABEL[member.role]}{session ? ` · ${providerName(session.provider)} · ${session.status}` : ''}</small></span>
              </label>
            );
          })}
        </fieldset>
        <div className="recips-pop__foot">
          <small>{stalePicked.length ? `${stalePicked.length} unavailable recipient${stalePicked.length === 1 ? '' : 's'} — clear before sending` : pickedActive.length ? `${pickedActive.length} selected` : `Nothing selected: ${defaultLabel}`}</small>
          <button type="button" className="link-btn" disabled={!picked.length} onClick={() => setPicked([])}>Clear selection</button>
        </div>
      </Popover>
      {footer}
      {note || snapshot.group.paused ? (
        <p className={cx('composer__note', noteIsError && 'is-error')} role={noteIsError ? 'alert' : 'status'}>
          {note ?? `Group is paused${snapshot.group.pauseReason ? `: ${snapshot.group.pauseReason}` : ''}. Resume it from the bar above to start queued work.`}
          {!noteIsError && blocker && unavailable ? <> <button type="button" className="link-btn" onClick={() => useMingle.getState().openDialog({ kind: 'settings' })}>Open Settings</button></> : null}
        </p>
      ) : null}
      {compactStatus ? <p className={cx('composer__note', compactStatus.status === 'failed' && 'is-error')} role={compactStatus.status === 'failed' ? 'alert' : 'status'} aria-live="polite" aria-busy={compactStatus.status === 'running'}>{compactStatus.status === 'running' ? `Compacting @${compactStatus.handle}…` : compactStatus.status === 'completed' ? `@${compactStatus.handle}: ${compactStatus.message}` : compactStatus.status === 'unsupported' ? `Manual compaction unavailable for @${compactStatus.handle}: ${compactStatus.message}` : compactStatus.message}</p> : null}
      <UsagePanel session={usageSession} onClose={closeUsage} />
      <FileContextPicker open={filePickerOpen} projectId={anchor.projectId} sessionId={filePickerSessionId} initialQuery={filePickerQuery}
        onClose={closeFilePicker}
        onSelect={(file) => {
          const trigger = fileMentionTrigger.current;
          const currentDraft = useMingle.getState().drafts[anchor.id] ?? '';
          const replacement = trigger ? removeFileMentionTrigger(currentDraft, trigger) : null;
          if (replacement) {
            setDraft(replacement.draft);
            setCaret(replacement.caret);
            filePickerRestoreCaret.current = replacement.caret;
          } else {
            filePickerRestoreCaret.current = caret;
          }
          fileMentionTrigger.current = null;
          appendContextReference(anchor.id, file);
        }} />
    </div>
  );
}
