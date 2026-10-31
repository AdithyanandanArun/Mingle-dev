import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUp, Bot, FilePlus2, Square } from 'lucide-react';
import type { AttachmentRef, Provider, ProviderModel, Session, StartSubagent } from '@mingle/contracts';
import { useMingle } from '../store/store';
import { api, errorMessage, type ApiProviderFailure, type ProviderCatalog, type SessionPatch } from '../lib/api';
import { MOD, PROVIDER_NAME, Badge } from './ui';
import { cx } from '../lib/format';
import { SelectMenu } from './SelectMenu';
import { ModelPicker } from './ModelPicker';
import { UsagePanel } from './UsagePanel';
import { GitBar } from './git/GitBar';
import { AttachmentDrafts, AttachmentTray, useAttachmentDraft } from './AttachmentDrafts';
import { usePresence } from '../lib/motion';
import { useTeamStructure } from '../lib/team-structure-context';
import { providerSwitchFailureCopy } from '../lib/providerFailureUi';
import { QueuedMessages } from './composer/QueuedMessages';
import {
  appendContextReference, ContextReferenceChips, EMPTY_CONTEXT_REFS, FileContextPicker,
  findFileMentionTrigger, removeFileMentionTrigger, type FileMentionTrigger,
} from './MessageContextControls';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasSkillMarker = (text: string, name: string) => new RegExp(`(?:^|\\s)\\$${escapeRegExp(name)}(?=\\s|$)`).test(text);
const removeSkillMarker = (text: string, name: string) => text.replace(new RegExp(`(^|\\s)\\$${escapeRegExp(name)}(?=\\s|$)`, 'g'), '$1').replace(/[ \t]{2,}/g, ' ');
const localCommandNames = ['new', 'stop', 'settings', 'model', 'effort', 'permissions', 'tier', 'skills', 'usage', 'import', 'status', 'diff', 'compact', 'help'];
const reservedCommands = new Set(localCommandNames);

export function Composer({ session, statusBar }: { session: Session; statusBar?: ReactNode }) {
  const draft = useMingle((s) => s.drafts[session.id] ?? '');
  const contextRefs = useMingle((s) => s.contextDrafts[session.id] ?? EMPTY_CONTEXT_REFS);
  const connection = useMingle((s) => s.connection);
  const provider = useMingle((s) => s.boot?.providers.find((p) => p.id === session.provider));
  const providers = useMingle((s) => s.boot?.providers);
  const project = useMingle((s) => s.boot?.projects.find((p) => p.id === session.projectId));
  const teamStructure = useTeamStructure().snapshot;
  const allDelegatedSubagents = useMingle((s) => s.boot?.delegatedSubagents);
  const delegatedSubagents = useMemo(() => (allDelegatedSubagents ?? []).filter((item) => item.parentSessionId === session.id), [allDelegatedSubagents, session.id]);
  const allQueuedMessages = useMingle((s) => s.boot?.queuedMessages);
  const queuedMessages = useMemo(() => (allQueuedMessages ?? []).filter((item) => item.sessionId === session.id), [allQueuedMessages, session.id]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const compactController = useRef<{ controller: AbortController; targetSessionId: string; operationId: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [planningMode, setPlanningMode] = useState(false);
  const [compactStatus, setCompactStatus] = useState<{ status: 'running' | 'completed' | 'unsupported' | 'failed'; message?: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerFailure, setProviderFailure] = useState<ApiProviderFailure | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [suggestion, setSuggestion] = useState<{ kind: 'command' | 'skill'; start: number; query: string } | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filePickerQuery, setFilePickerQuery] = useState('');
  const fileMentionTrigger = useRef<FileMentionTrigger | null>(null);
  const filePickerRestoreCaret = useRef<number | null>(null);
  useEffect(() => { setAttachments([]); }, [session.id]);
  const [usageOpen, setUsageOpen] = useState(false);
  const usageOpenRef = useRef(usageOpen);
  usageOpenRef.current = usageOpen;
  const usageCloseVersion = useRef(0);
  const usageFocusFrame = useRef<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [caretPosition, setCaretPosition] = useState(0);
  const dismissedSuggestion = useRef<string | null>(null);
  const caret = useRef(0);
  const pickerId = useId();
  const [modelOpenRequest, setModelOpenRequest] = useState(0);
  const [policyOpenRequest, setPolicyOpenRequest] = useState(0);
  const [subagentOpen, setSubagentOpen] = useState(false);
  const [subagentTask, setSubagentTask] = useState('');
  const [subagentName, setSubagentName] = useState('');
  const [subagentModel, setSubagentModel] = useState({ provider: session.provider, model: session.model });
  const [reasoningOpenRequest, setReasoningOpenRequest] = useState(0);
  const modelControl = useRef<HTMLButtonElement>(null);
  const reasoningControl = useRef<HTMLButtonElement>(null);
  const policyControl = useRef<HTMLButtonElement>(null);
  const failedMessage = useMingle((s) => providerFailure?.runId
    ? s.boot?.messages.find((message) => message.sessionId === session.id && message.runId === providerFailure.runId && message.role === 'user')
    : undefined);

  const closeFilePicker = () => {
    const position = filePickerRestoreCaret.current ?? fileMentionTrigger.current?.end ?? caret.current;
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
  const openFilePicker = (query = '') => {
    fileMentionTrigger.current = null;
    filePickerRestoreCaret.current = null;
    setFilePickerQuery(query);
    setFilePickerOpen(true);
  };

  const catalogKey = `${session.id}:${session.provider}:${session.model}:${session.providerSessionId ?? ''}`;
  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null); setCatalogError(null);
    setSuggestion(null); setSelectedSkills([]); dismissedSuggestion.current = null;
    if (connection !== 'online') return () => controller.abort();
    void api.sessionCatalog(session.id, controller.signal, catalogRevision > 0).then((value) => {
      if (!controller.signal.aborted) setCatalog(value);
    }).catch((cause) => {
      if (!controller.signal.aborted) setCatalogError(errorMessage(cause));
    });
    return () => controller.abort();
  }, [catalogKey, connection, catalogRevision]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft, session.id]);
  useEffect(() => { setError(null); setCompactStatus(null); setPlanningMode(false); }, [session.id]);
  useEffect(() => {
    if (session.status !== 'error' || !session.error) {
      setProviderFailure(null);
      return;
    }
    const controller = new AbortController();
    void api.sessionRecovery(session.id, controller.signal).then(({ failure }) => {
      if (!controller.signal.aborted) setProviderFailure(failure);
    }).catch(() => {
      if (!controller.signal.aborted) setProviderFailure(null);
    });
    return () => controller.abort();
  }, [session.id, session.status, session.error]);
  useEffect(() => { setUsageOpen(false); }, [session.id, session.provider, session.model]);
  const closeUsage = useCallback(() => {
    setUsageOpen(false);
    const version = ++usageCloseVersion.current;
    if (usageFocusFrame.current !== null) window.cancelAnimationFrame(usageFocusFrame.current);
    usageFocusFrame.current = window.requestAnimationFrame(() => {
      usageFocusFrame.current = null;
      if (version === usageCloseVersion.current && !usageOpenRef.current) ref.current?.focus();
    });
  }, []);
  const openUsage = useCallback(() => {
    usageCloseVersion.current++;
    if (usageFocusFrame.current !== null) window.cancelAnimationFrame(usageFocusFrame.current);
    usageFocusFrame.current = null;
    setUsageOpen(true);
  }, []);
  useEffect(() => () => { if (usageFocusFrame.current !== null) window.cancelAnimationFrame(usageFocusFrame.current); }, []);
  const attachmentDraft = useAttachmentDraft({ kind: 'session', id: session.id }, attachments, setAttachments, setError);

  const running = session.status === 'running' || session.status === 'waiting';
  const steerable = running && session.steerable === true;
  const waitingBlocker = session.status === 'waiting' ? 'Waiting for your answer or approval above before the run can continue.' : null;
  const blocker =
    connection !== 'online' ? 'Disconnected from the Mingle server — reconnect to send.'
      : session.status === 'waiting' ? waitingBlocker
        : provider && !provider.available ? `${PROVIDER_NAME[session.provider]} needs setup before you can send a message.`
          : null;
  const empty = draft.trim().length === 0 && attachments.length === 0 && attachmentDraft.uploads.length === 0;
  const runningSubagents = delegatedSubagents.filter((item) => item.status === 'running').length;
  const inGroup = Boolean(teamStructure?.projectId === session.projectId && teamStructure.members.some((member) => member.sessionId === session.id));
  const subagentDisabledReason = inGroup ? 'Subagents are available in individual sessions.' : session.parentSessionId ? 'Child sessions cannot start more subagents.' : runningSubagents >= 4 ? 'Maximum of 4 running subagents reached.' : undefined;
  const compactDraftCommand = /^\/(compact)(?:\s.*)?$/i.exec(draft.trim());
  const localDraftCommand = compactDraftCommand ?? (attachments.length || attachmentDraft.uploads.length ? null : /^\/(new|stop|settings|model|effort|permissions|tier|skills|usage|import|status|diff|compact|help)(?:\s.*)?$/i.exec(draft.trim()));
  const compactIntent = localDraftCommand?.[1]?.toLowerCase() === 'compact';

  const submit = async (sendNow = false) => {
    const subagentShortcut = /^\/subagent\s+([\s\S]+)$/i.exec(draft.trim());
    const compactCommand = /^\/(compact)(?:\s.*)?$/i.exec(draft.trim());
    const local = compactCommand ?? (attachments.length || attachmentDraft.uploads.length ? null : /^\/(new|stop|settings|model|effort|permissions|tier|skills|usage|import|status|diff|compact|help)(?:\s.*)?$/i.exec(draft.trim()));
    if (local?.[1]?.toLowerCase() === 'compact' && attachmentDraft.isBusy()) {
      setError('Wait for the attachment upload to finish, then remove or send the attachments before compacting. They remain in your draft.');
      return;
    }
    if (attachmentDraft.isBusy()) return;
    if (attachmentDraft.uploads.length) { setError('Retry or remove each failed attachment before sending.'); return; }
    if ((blocker && !local && !subagentShortcut) || empty || sending || updating) return;
    setSending(true);
    setError(null);
    let focusComposerAfter = true;
    try {
      if (subagentShortcut) {
        if (subagentDisabledReason) throw new Error(subagentDisabledReason);
        await api.startSubagent(session.id, { task: subagentShortcut[1]!.trim() });
        if (useMingle.getState().drafts[session.id] === draft) useMingle.getState().setDraft(session.id, '');
        window.localStorage.setItem('mingle.subagent-tip-dismissed', '1');
        await useMingle.getState().refreshNow();
        return;
      }
      if (local) {
        const action = local[1]!.toLowerCase();
        if (action === 'compact') {
          if (draft.trim().toLowerCase() !== '/compact') throw new Error('/compact does not take arguments in a single session.');
          if (attachments.length || attachmentDraft.uploads.length) throw new Error('Remove or send the attachments before compacting. They remain in your draft.');
          if (connection !== 'online') throw new Error('Reconnect to Mingle before compacting this session.');
          if (running) throw new Error('This session is busy. Wait for its run to finish before compacting.');
          setCompactStatus({ status: 'running' });
          const controller = new AbortController();
          const operationId = crypto.randomUUID();
          compactController.current = { controller, targetSessionId: session.id, operationId };
          try {
            const result = await api.compactSession(session.id, controller.signal, operationId);
            if (result.status === 'completed') {
              setCompactStatus({ status: 'completed', message: result.message || 'Context compacted.' });
              if (useMingle.getState().drafts[session.id] === draft) useMingle.getState().setDraft(session.id, '');
              await useMingle.getState().refreshNow();
            } else if (result.status === 'unsupported') {
              setCompactStatus({ status: 'unsupported', message: result.error || result.message || `${PROVIDER_NAME[session.provider]} does not support manual compaction.` });
            } else {
              const message = result.error || result.message || 'The provider could not compact this conversation.';
              setCompactStatus({ status: 'failed', message });
            }
          } catch (cause) {
            if (!controller.signal.aborted) {
              setCompactStatus(null);
              throw cause;
            }
          } finally {
            if (compactController.current?.controller === controller) compactController.current = null;
          }
          return;
        }
        if (action === 'new') await useMingle.getState().createSession();
        if (action === 'stop') await api.interrupt(session.id);
        if (action === 'settings') useMingle.getState().openSettings();
        if (action === 'model') { focusComposerAfter = false; setModelOpenRequest((value) => value + 1); }
        if (action === 'effort' || action === 'tier') { focusComposerAfter = false; setReasoningOpenRequest((value) => value + 1); }
        if (action === 'permissions') { focusComposerAfter = false; setPolicyOpenRequest((value) => value + 1); }
        if (action === 'skills') {
          caret.current = 1; setCaretPosition(1);
          useMingle.getState().setDraft(session.id, '$');
        }
        if (action === 'usage') { focusComposerAfter = false; openUsage(); }
        if (action === 'import') { focusComposerAfter = false; useMingle.getState().openDialog({ kind: 'import' }); }
        if (action === 'diff') useMingle.getState().setContextTab('changes');
        if (action === 'status') {
          const currentTier = session.serviceTier ?? 'standard';
          const tier = currentTier === 'standard' ? 'Standard' : currentTier === 'priority' ? 'Fast' : currentTier;
          useMingle.getState().toast('info', `${PROVIDER_NAME[session.provider]} · ${session.model} · ${effortLabel(session.effort)} · ${tier}`);
        }
        if (action === 'help') {
          const providerCommands = Array.from(new Set((catalog?.commands ?? []).filter((item) => !reservedCommands.has(item.name.toLowerCase())).map((item) => `/${item.name}`)));
          const preview = providerCommands.slice(0, 5).join(', ');
          const remainder = providerCommands.length > 5 ? `, … ${providerCommands.length - 5} more` : '';
          useMingle.getState().toast('info', `Mingle commands: /new, /stop, /settings, /model, /effort, /permissions, /tier, /skills, /usage, /import, /status, /diff, /compact, /help${preview ? `. Other commands: ${preview}${remainder}. Type / to browse all.` : '.'}`);
        }
        if (action !== 'skills') useMingle.getState().setDraft(session.id, '');
        setSelectedSkills([]);
        await useMingle.getState().refreshNow();
        return;
      }
      const mentionedSkills = (catalog?.skills ?? []).filter((item) => item.enabled && hasSkillMarker(draft, item.name));
      const messageSkills: string[] = [];
      for (const skill of mentionedSkills) {
        const sameName = mentionedSkills.filter((item) => item.name === skill.name);
        const explicitlySelected = sameName.filter((item) => selectedSkills.includes(item.id));
        const candidates = explicitlySelected.length ? explicitlySelected : sameName;
        if (!explicitlySelected.length && candidates.length > 1) {
          throw new Error(`“$${skill.name}” matches multiple skills. Choose the intended skill from the picker.`);
        }
        for (const candidate of candidates) if (!messageSkills.includes(candidate.id)) messageSkills.push(candidate.id);
      }
      if (session.provider === 'claude' && messageSkills.length > 1) {
        throw new Error('Claude accepts one selected skill per message. Remove the extra skill reference.');
      }
      if (planningMode && (messageSkills.length || /^\s*\//.test(draft))) throw new Error('Native plan mode accepts a regular planning prompt, not provider commands or skills.');
      const submittedDraft = draft;
      const submittedAttachmentIds = attachments.map((item) => item.id);
      const submittedContextRefs = contextRefs;
      if (running) {
        const response = await api.queueMessage(session.id,{content:draft.trim(),skills:messageSkills,attachmentIds:submittedAttachmentIds,contextRefs:submittedContextRefs,intent:planningMode?'plan':'normal'});
        if (sendNow) await api.sendQueuedNow(session.id, response.queued.id);
        useMingle.getState().toast('success', sendNow ? 'Message sent next' : 'Message queued');
      } else await api.sendMessage(session.id, draft.trim(), messageSkills, submittedAttachmentIds, submittedContextRefs, planningMode ? 'plan' : 'normal');
      if (useMingle.getState().drafts[session.id] === submittedDraft) useMingle.getState().setDraft(session.id, '');
      if (useMingle.getState().contextDrafts[session.id] === submittedContextRefs) useMingle.getState().setContextDraft(session.id, []);
      attachmentDraft.sent(submittedAttachmentIds);
      setSelectedSkills([]);
      setPlanningMode(false);
      await useMingle.getState().refreshNow();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
      if (focusComposerAfter) ref.current?.focus();
    }
  };

  const stop = async () => {
    try {
      await api.interrupt(session.id);
      void useMingle.getState().refreshNow();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const stopCompaction = () => {
    const operation = compactController.current;
    if (!operation) return;
    operation.controller.abort();
    compactController.current = null;
    setSending(false);
    const message = 'Stopped waiting and sent a cancellation request for this compaction. Its outcome may be unknown; refresh before retrying.';
    setCompactStatus({ status: 'failed', message });
    setError(null);
    void api.interruptCompaction(operation.targetSessionId, operation.operationId).then(({ interrupted }) => {
      if (!interrupted) setCompactStatus({ status: 'failed', message: 'No active compaction matched this cancellation request. It may have completed before cancellation arrived; refresh before retrying.' });
    }).catch((cause) => setCompactStatus({ status: 'failed', message: `Compaction cancellation could not be confirmed: ${errorMessage(cause)}. Its outcome may be unknown.` })).finally(() => { void useMingle.getState().refreshNow(); });
  };

  const configure = async (patch: SessionPatch) => {
    if (running || sending || updating || connection !== 'online') return;
    setUpdating(true);
    setError(null);
    try {
      const updated = await api.updateSession(session.id, patch);
      await useMingle.getState().refreshNow();
      useMingle.setState((s) => ({
        boot: s.boot ? { ...s.boot, sessions: s.boot.sessions.map((item) => item.id === updated.id && item.updatedAt <= updated.updatedAt ? updated : item) } : s.boot,
      }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUpdating(false);
    }
  };
  const retryFailedMessage = async () => {
    if (!failedMessage || (!failedMessage.content.trim() && !failedMessage.attachments?.length) || !providerFailure
      || session.provider === providerFailure.provider || !provider?.available || sending || updating) return;
    setSending(true);
    setError(null);
    try {
      await api.retryMessage(session.id, failedMessage.id);
      await useMingle.getState().refreshNow();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  };
  const disabled = session.status === 'waiting' || sending || updating || connection !== 'online';
  const providerFailureCopy = providerFailure ? providerSwitchFailureCopy(providerFailure) : null;
  const canRetryFailedMessage = Boolean(providerFailure && session.provider !== providerFailure.provider && provider?.available && failedMessage
    && (failedMessage.content.trim() || failedMessage.attachments?.length));
  const currentProvider = providers?.find((p) => p.id === session.provider);
  const modelData = (currentProvider?.models ?? []) as ProviderModel[];
  const currentModel = modelData.find((m) => m.id === session.model || m.aliases?.includes(session.model));
  const selectedModelId = currentModel?.id ?? session.model;
  const effortChoices = currentModel?.reasoningEfforts ?? [];
  const tierChoices = [
    { id: 'standard', name: 'Standard', description: 'Standard service tier.' },
    ...(currentModel?.serviceTiers ?? []).filter((item) => item.id !== 'standard'),
  ];
  const effortLabel = (id: string) => {
    const reported = effortChoices.find((item) => item.id === id)?.label;
    if (reported) return reported;
    const known: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', 'extra-high': 'Extra High', max: 'Max', ultra: 'Ultra' };
    return known[id.toLowerCase()] ?? (id === 'none' ? 'Native/default' : id[0]?.toUpperCase() + id.slice(1));
  };
  const effortDefault = currentModel?.defaultReasoningEffort;
  const tierDefault = currentModel?.defaultServiceTier ?? 'standard';
  const tierName = (id: string, name: string) => id === 'standard' ? 'Standard' : id === 'priority' ? 'Fast' : name;
  const combinedOptions = [
    ...effortChoices.map((item) => ({
      value: `effort:${item.id}`,
      label: effortLabel(item.id),
      badge: item.id === effortDefault ? 'Default' : undefined,
      group: 'Reasoning effort',
    })),
    ...tierChoices.map((item) => ({
      value: `tier:${item.id}`,
      label: tierName(item.id, item.name),
      badge: item.id === tierDefault ? 'Default' : undefined,
      description: item.id !== 'standard' ? item.description : undefined,
      group: 'Service tier',
    })),
  ];
  const currentTier = session.serviceTier ?? 'standard';
  const hasCurrentEffort = effortChoices.some((item) => item.id === session.effort);
  const combinedValue = hasCurrentEffort
    ? `effort:${session.effort}` : `tier:${currentTier}`;
  const combinedSelectedValues = [
    ...(hasCurrentEffort ? [`effort:${session.effort}`] : []),
    `tier:${currentTier}`,
  ];
  const selectedTier = tierChoices.find((item) => item.id === currentTier);
  const combinedDisplay = hasCurrentEffort
    ? `${effortLabel(session.effort)}${currentTier === 'standard' ? '' : ` · ${selectedTier ? tierName(selectedTier.id, selectedTier.name) : currentTier}`}`
    : selectedTier ? tierName(selectedTier.id, selectedTier.name) : currentTier;
  const availablePolicyChoices = currentModel?.policies ?? currentProvider?.policies ?? [];
  const isTeamSessionAnchor = teamStructure?.projectId === session.projectId && teamStructure.host.isThisDevice
    && teamStructure.teamSession?.sessionId === session.id;
  const policyChoices = isTeamSessionAnchor
    ? availablePolicyChoices.filter((value) => value === 'supervised' || value === 'full-access')
    : availablePolicyChoices;
  const policyLabels: Record<string, [string, string]> = {
    supervised: ['Supervised', 'Ask before taking actions that change files or run commands.'],
    balanced: ['Auto-accept edits', 'Allow file edits while keeping command approvals.'],
    auto: ['Auto', 'Allow common actions automatically with safety checks.'],
    'full-access': ['Full access', 'Allow all actions without approval prompts.'],
  };
  const caretIndex = Math.min(caretPosition, draft.length);
  const beforeCaret = draft.slice(0, caretIndex);
  const match = beforeCaret.match(/(?:^|\s)(\/[^\s]*|\$[^\s]*)$/);
  const trigger = match?.[1] ?? '';
  const triggerStart = match ? caretIndex - trigger.length : 0;
  const suggestions = trigger.startsWith('/')
    ? [
      ...[
        { name: 'new', description: 'Create a new session', kind: 'local' as const, group: 'Mingle' },
        { name: 'stop', description: 'Interrupt the current run', kind: 'local' as const, group: 'Mingle' },
        { name: 'settings', description: 'Open Settings', kind: 'local' as const, group: 'Mingle' },
        { name: 'model', description: 'Focus model selection', kind: 'local' as const, group: 'Mingle' },
        { name: 'effort', description: 'Focus effort selection', kind: 'local' as const, group: 'Mingle' },
        { name: 'permissions', description: 'Focus approval policy', kind: 'local' as const, group: 'Mingle' },
        { name: 'tier', description: 'Focus service tier', kind: 'local' as const, group: 'Mingle' },
        { name: 'skills', description: 'Choose skills for the next message', kind: 'local' as const, group: 'Mingle' },
        { name: 'usage', description: 'Show provider limits and session totals', kind: 'local' as const, group: 'Mingle' },
        { name: 'import', description: 'Import a local supported provider conversation', kind: 'local' as const, group: 'Mingle' },
        { name: 'status', description: 'Show current provider and settings', kind: 'local' as const, group: 'Mingle' },
        { name: 'diff', description: 'Open the Changes pane', kind: 'local' as const, group: 'Mingle' },
        { name: 'compact', description: 'Compact this conversation using the provider’s local API', kind: 'local' as const, group: 'Mingle' },
        { name: 'help', description: 'List Mingle commands', kind: 'local' as const, group: 'Mingle' },
      ].filter((item) => item.name.startsWith(trigger.slice(1).toLowerCase())),
      ...(catalog?.commands ?? []).filter((item) => !reservedCommands.has(item.name.toLowerCase()) && item.name.toLowerCase().startsWith(trigger.slice(1).toLowerCase())).map((item) => ({ id: item.id, name: item.name, description: item.description, group: item.source[0]!.toUpperCase() + item.source.slice(1), kind: 'provider' as const, argumentHint: item.argumentHint })),
    ].map((item) => ({ ...item, key: `${item.kind}:${'id' in item ? item.id : item.name}`, token: `/${item.name}` }))
      : trigger.startsWith('$') && catalog
        ? catalog.skills.filter((item) => item.enabled && item.name.toLowerCase().startsWith(trigger.slice(1).toLowerCase())).map((item) => ({ name: item.name, description: item.description, group: item.source[0]!.toUpperCase() + item.source.slice(1), kind: 'skill' as const, token: `$${item.name}`, id: item.id, key: `skill:${item.id}` }))
      : [];
  const pickerOpen = Boolean(suggestion && suggestions.length);
  const { present: pickerPresent, closing: pickerClosing } = usePresence(pickerOpen);
  const pickerSnapshot = useRef<{ suggestion: NonNullable<typeof suggestion>; suggestions: typeof suggestions; active: number } | null>(null);
  if (pickerOpen && suggestion) pickerSnapshot.current = { suggestion, suggestions, active: activeSuggestion };
  const displayedPicker = pickerOpen && suggestion ? { suggestion, suggestions, active: activeSuggestion } : pickerSnapshot.current;
  useEffect(() => {
    if (trigger !== dismissedSuggestion.current) dismissedSuggestion.current = null;
    if (focused && suggestions.length && trigger && trigger !== dismissedSuggestion.current) {
      const kind = trigger.startsWith('/') ? 'command' : 'skill';
      if (suggestion?.start !== triggerStart || suggestion.kind !== kind || suggestion.query !== trigger) {
        setActiveSuggestion(0);
        setSuggestion({ kind, start: triggerStart, query: trigger });
      }
    } else setSuggestion(null);
  }, [draft, catalog, trigger, triggerStart, suggestions.length, suggestion, focused, caretPosition]);
  const chooseSuggestion = (index: number) => {
    const item = suggestions[index];
    if (!item) return;
    let prefix = draft.slice(0, triggerStart);
    let suffix = draft.slice(caretIndex);
    if (item.kind === 'skill' && session.provider === 'claude') {
      for (const id of selectedSkills) {
        const prior = catalog?.skills.find((skill) => skill.id === id);
        if (prior) { prefix = removeSkillMarker(prefix, prior.name); suffix = removeSkillMarker(suffix, prior.name); }
      }
    }
    const text = `${prefix}${item.token} ${suffix}`;
    const nextCaret = prefix.length + item.token.length + 1;
    useMingle.getState().setDraft(session.id, text);
    caret.current = nextCaret;
    setCaretPosition(nextCaret);
    setSuggestion(null);
    dismissedSuggestion.current = null;
    if (item.kind === 'skill' && 'id' in item) setSelectedSkills((current) => {
      const next = session.provider === 'claude' ? [item.id] : current.includes(item.id) ? current : [...current, item.id];
      if (session.provider === 'claude' && current.length && !current.includes(item.id)) useMingle.getState().toast('info', 'Claude supports one selected skill per message; the latest choice replaced the previous one.');
      return next;
    });
    requestAnimationFrame(() => { const input = ref.current; input?.focus(); input?.setSelectionRange(nextCaret, nextCaret); });
  };
  useEffect(() => {
    document.getElementById(`${pickerId}-option-${activeSuggestion}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeSuggestion, pickerId, suggestion]);
  return (
    <div className="composer-wrap">
      <QueuedMessages sessionId={session.id} steerable={steerable} items={queuedMessages} />
      {providerFailureCopy ? <div className="composer__note is-error" role="alert">
        <span>{providerFailureCopy}</span>{' '}
        <button type="button" className="link-btn" onClick={() => setModelOpenRequest((value) => value + 1)} disabled={disabled} title={running ? 'Wait for the active run to finish before switching providers.' : 'Choose another available provider.'}>Switch provider</button>
        {canRetryFailedMessage ? <>{' '}<button type="button" className="link-btn" onClick={() => void retryFailedMessage()} disabled={disabled}>Retry with {PROVIDER_NAME[session.provider]}</button></> : null}
      </div> : null}
      {statusBar}
      <div className={cx('composer', blocker && 'is-blocked')}>
        <label htmlFor={`composer-${session.id}`} className="sr-only">Message {session.name}</label>
        <ContextReferenceChips refs={contextRefs} disabled={sending || updating} onRemove={(index) => useMingle.getState().setContextDraft(session.id, contextRefs.filter((_, i) => i !== index))} />
        <AttachmentTray attachments={attachments} busy={attachmentDraft.busy} uploads={attachmentDraft.uploads} onRetry={attachmentDraft.retry} onForget={attachmentDraft.forget} loading={attachmentDraft.loading} loadError={attachmentDraft.loadError} onReload={attachmentDraft.reload} onRemove={(id) => void attachmentDraft.remove(id)} disabled={sending || updating || Boolean(waitingBlocker)} />
        <textarea
          id={`composer-${session.id}`} ref={ref} className="composer__input" rows={1} value={draft}
          role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={Boolean(suggestion && suggestions.length)}
          aria-controls={suggestion && suggestions.length ? pickerId : undefined}
          aria-activedescendant={suggestion && suggestions.length ? `${pickerId}-option-${activeSuggestion}` : undefined}
          placeholder={planningMode ? 'Describe what to plan… or type @/path to add file context' : steerable ? 'Will steer the running agent…' : running ? 'Queued · will send when the agent finishes…' : 'Ask anything, or type @/path to add file context…'}
          onChange={(e) => {
            const nextDraft = e.target.value;
            caret.current = e.target.selectionStart ?? nextDraft.length;
            const pathTrigger = findFileMentionTrigger(nextDraft, caret.current);
            if (pathTrigger && project) {
              fileMentionTrigger.current = pathTrigger;
              filePickerRestoreCaret.current = null;
              setFilePickerQuery(pathTrigger.query);
              setFilePickerOpen(true);
            }
            const fileMarker = project ? nextDraft.slice(0, caret.current).match(/(^|\s)@files?$/i) : null;
            if (fileMarker) {
              const markerStart = caret.current - fileMarker[0].length + fileMarker[1].length;
              const cleaned = `${nextDraft.slice(0, markerStart)}${nextDraft.slice(caret.current)}`;
              fileMentionTrigger.current = null;
              filePickerRestoreCaret.current = null;
              caret.current = markerStart; setCaretPosition(markerStart);
              useMingle.getState().setDraft(session.id, cleaned);
              openFilePicker();
              return;
            }
            setCaretPosition(caret.current);
            if (compactStatus?.status !== 'running') setCompactStatus(null);
            useMingle.getState().setDraft(session.id, nextDraft);
            setSelectedSkills((current) => current.filter((id) => {
              const skill = catalog?.skills.find((item) => item.id === id);
              return Boolean(skill && hasSkillMarker(nextDraft, skill.name));
            }));
          }}
          onFocus={(e) => { setFocused(true); caret.current = e.currentTarget.selectionStart ?? 0; setCaretPosition(caret.current); }}
          onSelect={(e) => { caret.current = e.currentTarget.selectionStart ?? 0; setCaretPosition(caret.current); }}
          onPaste={attachmentDraft.onPaste}
          onBlur={() => { setFocused(false); setSuggestion(null); }}
          onKeyDown={(e) => {
            if (filePickerOpen) {
              if (e.key === 'Escape') { e.preventDefault(); closeFilePicker(); }
              return;
            }
            if (suggestion && suggestions.length && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActiveSuggestion((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return; }
              if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); chooseSuggestion(activeSuggestion); return; }
              if (e.key === 'Escape') { e.preventDefault(); dismissedSuggestion.current = trigger; setSuggestion(null); return; }
            }
            if (e.key === 'Enter' && e.shiftKey && (e.ctrlKey || e.metaKey) && running && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(true); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
          }}
        />
        {draft.startsWith('/subagent') ? <div className="composer-picker-empty" role="status">/subagent starts a delegated task when sent.</div> : null}
        {pickerPresent && displayedPicker ? <div className={cx('composer-picker', pickerClosing && 'is-closing')} id={pickerId} role="listbox" aria-label={displayedPicker.suggestion.kind === 'skill' ? 'Skills' : 'Commands'} aria-hidden={pickerClosing || undefined} inert={pickerClosing}>
          {displayedPicker.suggestions.map((item, index) => <div key={item.key}>
            {index === 0 || displayedPicker.suggestions[index - 1]?.group !== item.group ? <div className="composer-picker__group" role="presentation">{item.group}</div> : null}
            <div role="option" id={`${pickerId}-option-${index}`} aria-selected={index === displayedPicker.active} className={cx('composer-picker__item', index === displayedPicker.active && 'is-active')} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActiveSuggestion(index)} onClick={() => chooseSuggestion(index)}>
              <span className="composer-picker__name">{item.token}{item.kind === 'provider' && item.argumentHint ? <small> {item.argumentHint}</small> : null}</span><span className="composer-picker__description">{item.description}</span>
            </div>
          </div>)}
        </div> : null}
        {focused && trigger.startsWith('$') && !suggestions.length && !catalogError ? <div className="composer-picker-empty" role="status">{!catalog ? 'Loading skills…' : catalog.skills.some((item) => item.enabled) ? 'No matching skills.' : 'No skills are available for this provider and session.'}</div> : null}
        <div className="composer__bar">
          <div className="composer__controls" aria-busy={updating}>
            <button type="button" className={cx('composer__plan-toggle', planningMode && 'is-active')} aria-pressed={planningMode} disabled={disabled} title="Ask the provider for a native read-only plan" onClick={() => { setPlanningMode((value) => !value); setSelectedSkills([]); setError(null); }}>
              {planningMode ? 'Planning on' : 'Plan'}
            </button>
            {session.handoffFromProvider ? <Badge tone="info" title="No extra model call; context is included with your next message.">Handoff pending from {PROVIDER_NAME[session.handoffFromProvider]}</Badge> : null}
            <ModelPicker triggerRef={modelControl} openRequest={modelOpenRequest} className="composer__model-picker" label="Model"
              value={{ provider: session.provider, model: selectedModelId }} providers={providers ?? []}
              title={running ? 'Provider and model selection is disabled while this session is running.' : undefined}
              disabled={disabled} placement="top"
              onChange={({ provider, model }) => { void configure({ provider, model }); }} />
            <SelectMenu triggerRef={reasoningControl} className="composer__select" label="Reasoning effort and service tier" value={combinedValue} selectedValues={combinedSelectedValues} displayValue={combinedDisplay} openRequest={reasoningOpenRequest} disabled={disabled}
              options={combinedOptions}
              onChange={(value) => { const [kind, option] = value.split(':'); if (kind === 'effort') void configure({ effort: option }); else if (kind === 'tier') void configure({ serviceTier: option }); }} placement="top" />
            <SelectMenu triggerRef={policyControl} openRequest={policyOpenRequest} className="composer__select composer__select--policy" label={isTeamSessionAnchor ? 'Team permission level' : 'Approval policy'} value={session.policy} disabled={disabled || policyChoices.length === 0}
              displayValue={policyChoices.length ? policyChoices.includes(session.policy) ? undefined : 'Not available' : 'Native/default'}
              options={policyChoices.map((value) => ({ value, label: policyLabels[value]?.[0] ?? value, description: policyLabels[value]?.[1] }))}
              onChange={(value) => void configure({ policy: value as Session['policy'] })} placement="top" />
          </div>
          <div className="composer__send">
            <button type="button" className="composer__subagent-button" aria-label="Start a subagent" disabled={Boolean(subagentDisabledReason) || connection !== 'online'} title={subagentDisabledReason ?? 'Delegate a task to another provider'} onClick={() => { setSubagentTask(draft); setSubagentOpen((open) => !open); }}><Bot size={14} /> <span>Subagent</span></button>
            <button type="button" className="composer__context-button" onClick={() => openFilePicker()} disabled={!project || disabled} aria-label="Add workspace file context" title="Add a file from this worktree, or type @/path"><FilePlus2 size={15} /></button>
            <AttachmentDrafts scope={{ kind: 'session', id: session.id }} busy={attachmentDraft.busy} onFiles={attachmentDraft.addFiles} disabled={sending || updating || Boolean(blocker)} />
            {compactStatus?.status === 'running' ? (
              <button type="button" className="sendbtn sendbtn--stop" onClick={stopCompaction} aria-label="Request cancellation of this compaction" title="Stop waiting and send a cancellation request"><Square size={12} fill="currentColor" /></button>
            ) : running && !['usage', 'import'].includes(localDraftCommand?.[1]?.toLowerCase() ?? '') ? (
              <button type="button" className="sendbtn sendbtn--stop" onClick={stop} aria-label="Interrupt run" title="Interrupt run"><Square size={12} fill="currentColor" /></button>
            ) : (
          <button type="button" className="sendbtn" onClick={() => void submit()} disabled={Boolean(waitingBlocker) || empty || sending || updating || (attachmentDraft.busy && !compactIntent)} aria-label={compactIntent ? 'Compact conversation' : ['usage', 'import'].includes(localDraftCommand?.[1]?.toLowerCase() ?? '') ? (localDraftCommand?.[1]?.toLowerCase() === 'import' ? 'Import conversation' : 'Open usage') : 'Send message'} title={compactIntent ? blocker ?? 'Compact conversation' : ['usage', 'import'].includes(localDraftCommand?.[1]?.toLowerCase() ?? '') ? (localDraftCommand?.[1]?.toLowerCase() === 'import' ? 'Import conversation' : 'Open usage') : blocker ?? (empty ? 'Write a message first' : `Send (${MOD}+Enter or Enter)`)}>
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      {subagentOpen ? <div className="subagent-launcher" role="dialog" aria-label="Start a subagent">
        <label>Task<textarea autoFocus value={subagentTask} onChange={(event) => setSubagentTask(event.target.value)} /></label>
        <label>Name (optional)<input value={subagentName} onChange={(event) => setSubagentName(event.target.value)} /></label>
        <ModelPicker value={subagentModel} providers={providers ?? []} onChange={(value) => setSubagentModel(value)} placement="top" />
        {subagentDisabledReason ? <p role="status">{subagentDisabledReason}</p> : null}
        <button type="button" disabled={Boolean(subagentDisabledReason) || !subagentTask.trim() || sending} onClick={() => void (async () => {
          setSending(true); setError(null);
          try {
            const input: StartSubagent = { task: subagentTask.trim(), name: subagentName.trim() || undefined, provider: subagentModel.provider as Provider, model: subagentModel.model };
            await api.startSubagent(session.id, input);
            window.localStorage.setItem('mingle.subagent-tip-dismissed', '1');
            setSubagentOpen(false); setSubagentTask(''); setSubagentName('');
            await useMingle.getState().refreshNow();
          } catch (cause) { setError(errorMessage(cause)); }
          finally { setSending(false); }
        })()}>Start subagent</button>
      </div> : null}
      {project ? <GitBar project={project} session={session} /> : null}
      {blocker || error ? (
        <p className={cx('composer__note', error && 'is-error')} role={error ? 'alert' : 'status'}>{error ?? blocker}{!error && provider && !provider.available ? <> <button type="button" className="link-btn" onClick={() => useMingle.getState().openDialog({ kind: 'settings' })}>Open Settings</button></> : null}</p>
      ) : null}
      {compactStatus ? <p className={cx('composer__note', compactStatus.status === 'failed' && 'is-error')} role={compactStatus.status === 'failed' ? 'alert' : 'status'} aria-live="polite" aria-busy={compactStatus.status === 'running'}>{compactStatus.status === 'running' ? 'Compacting conversation…' : compactStatus.status === 'completed' ? compactStatus.message : compactStatus.status === 'unsupported' ? `Manual compaction unavailable: ${compactStatus.message}` : compactStatus.message}</p> : null}
      {catalogError && (trigger.startsWith('/') || trigger.startsWith('$')) ? <p className="composer__note" role="status">Command and skill suggestions unavailable: {catalogError} <button type="button" className="link-btn" onClick={() => setCatalogRevision((value) => value + 1)}>Retry</button></p> : null}
      {catalog?.warnings.length && (suggestion || trigger.startsWith('/') || trigger.startsWith('$')) ? <details className="composer__catalog-note"><summary>Command and skill details · {catalog.warnings.length} notice{catalog.warnings.length === 1 ? '' : 's'}</summary><ul>{catalog.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul><button type="button" className="link-btn" onClick={() => setCatalogRevision((value) => value + 1)}>Refresh</button></details> : null}
      <UsagePanel session={usageOpen ? session : null} onClose={closeUsage} />
      {project ? <FileContextPicker open={filePickerOpen} projectId={project.id} sessionId={session.id} initialQuery={filePickerQuery}
        onClose={closeFilePicker}
        onSelect={(file) => {
          const trigger = fileMentionTrigger.current;
          const currentDraft = useMingle.getState().drafts[session.id] ?? '';
          const replacement = trigger ? removeFileMentionTrigger(currentDraft, trigger) : null;
          if (replacement) {
            useMingle.getState().setDraft(session.id, replacement.draft);
            caret.current = replacement.caret;
            setCaretPosition(replacement.caret);
            filePickerRestoreCaret.current = replacement.caret;
          } else {
            filePickerRestoreCaret.current = caret.current;
          }
          fileMentionTrigger.current = null;
          appendContextReference(session.id, file);
        }} /> : null}
    </div>
  );
}
