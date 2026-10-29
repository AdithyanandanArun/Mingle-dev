import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Bot, ChevronRight, FileCode2, Globe2, LoaderCircle, Search, Terminal, Wrench } from 'lucide-react';
import type { Provider, ToolCall, ToolCategory } from '@mingle/contracts';
import { api } from '../../lib/api';
import { subagentStatusLabel, type SubagentRun } from '../../lib/subagents';
import type { DisplayMessage } from '../../lib/conversation';
import { cx } from '../../lib/format';
import { MessageRow } from '../ConversationParts';
import { Markdown } from '../Markdown';
import { AgentIdentity } from '../group/AgentIdentity';
import './SubagentStyles.css';

function callPrompt(call: ToolCall): string {
  try {
    const input: unknown = JSON.parse(call.input);
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const value = (input as Record<string, unknown>).prompt ?? (input as Record<string, unknown>).task;
      if (typeof value === 'string') return value;
    }
  } catch { /* keep the prompt explicitly unavailable when provider input cannot be read */ }
  return '';
}

function mergeCalls(details: ToolCall[], live: readonly ToolCall[], runId: string): ToolCall[] {
  const merged = new Map(details.filter((call) => call.runId === runId).map((call) => [call.id, call]));
  for (const current of live) {
    if (current.runId !== runId) continue;
    const full = merged.get(current.id);
    merged.set(current.id, full ? {
      ...full, ...current,
      input: full.input,
      output: current.status === 'running' || full.status === 'running' ? current.output || full.output : full.output,
      outputTruncated: full.outputTruncated,
    } : current);
  }
  return [...merged.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function categoryIcon(category: ToolCategory): ReactNode {
  if (category === 'command') return <Terminal size={13} aria-hidden="true" />;
  if (category === 'browser') return <Globe2 size={13} aria-hidden="true" />;
  if (category === 'search') return <Search size={13} aria-hidden="true" />;
  if (category === 'file') return <FileCode2 size={13} aria-hidden="true" />;
  if (category === 'agent') return <Bot size={13} aria-hidden="true" />;
  return <Wrench size={13} aria-hidden="true" />;
}

function ToolDetail({ call, calls, path = new Set<string>() }: { call: ToolCall; calls: readonly ToolCall[]; path?: ReadonlySet<string> }) {
  const seen = new Set(path).add(call.id).add(call.providerId);
    const children = calls.filter((candidate) => candidate.runId === call.runId && candidate.parentProviderId === call.providerId && !seen.has(candidate.providerId));
  const title = call.summary.trim() || call.command?.trim() || call.name || 'Tool activity';
  const status = call.status === 'completed' ? 'Done' : call.status === 'running' ? 'Running' : call.status === 'failed' ? 'Failed' : 'Interrupted';
  return <details className={cx('run-tool', `run-tool--${call.category}`, `is-${call.status}`)}>
    <summary className="run-tool__summary">
      <ChevronRight size={12} className="run-tool__chevron" aria-hidden="true" />
      {categoryIcon(call.category)}
      <span className="run-tool__title" title={title}>{title}</span>
      <span className={cx('run-tool__status', `is-${call.status}`)}>{status}</span>
    </summary>
    <div className="run-tool__body">
      {call.command ? <div className="run-tool__field"><span>Command</span><pre>{call.command}</pre></div> : null}
      {call.cwd ? <div className="run-tool__field"><span>Working directory</span><pre>{call.cwd}</pre></div> : null}
      {call.input ? <div className="run-tool__field"><span>Input</span><pre>{call.input}</pre></div> : null}
      {call.output ? <div className="run-tool__field"><span>{call.outputTruncated ? 'Output tail' : 'Captured output'}</span><pre>{call.output}</pre></div> : null}
      {children.length ? <div className="run-tool__children" aria-label="Nested tool calls">{children.map((child) => <ToolDetail key={child.id} call={child} calls={calls} path={seen} />)}</div> : null}
    </div>
  </details>;
}

function message(subagent: SubagentRun, id: string, role: 'user' | 'assistant', content: string, createdAt: string, live: boolean): DisplayMessage {
  return { id, sessionId: subagent.parentCall.sessionId, role, content, createdAt, runId: subagent.runId, live };
}

export function SubagentChatView({
  subagent, provider, calls, onBack,
}: {
  subagent: SubagentRun;
  provider: Provider;
  calls: readonly ToolCall[];
  onBack: () => void;
}) {
  const backButton = useRef<HTMLButtonElement>(null);
  const [fullParent, setFullParent] = useState<ToolCall | null>(null);
  const [fullCalls, setFullCalls] = useState<ToolCall[]>([]);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    backButton.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onBack();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onBack]);
  useEffect(() => {
    let active = true;
    setFullParent(null);
    setFullCalls([]);
    setLoadError(false);
    void Promise.all([api.toolCall(subagent.id), api.runTools(subagent.runId)]).then(([parent, runCalls]) => {
      if (!active) return;
      setFullParent(parent);
      setFullCalls(runCalls);
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [subagent.id, subagent.runId, subagent.status]);

  const parentCall = useMemo(() => {
    if (!fullParent) return subagent.parentCall;
    const liveParent = subagent.parentCall;
    return {
      ...fullParent,
      ...liveParent,
      input: fullParent.input,
      output: liveParent.status === 'running' ? liveParent.output : fullParent.output,
      outputTruncated: fullParent.outputTruncated,
      subagentMessages: subagent.messages,
    };
  }, [fullParent, subagent.parentCall, subagent.messages]);
  const allCalls = useMemo(() => mergeCalls(fullCalls, calls, subagent.runId), [fullCalls, calls, subagent.runId]);
  const prompt = callPrompt(parentCall) || subagent.prompt;
  const roots = allCalls.filter((call) => call.parentProviderId === subagent.providerId);
  const timeline = [
    ...subagent.messages.map((entry, index) => ({ kind: 'message' as const, id: `message:${entry.id}`, at: entry.createdAt, index, entry })),
    ...roots.map((call, index) => ({ kind: 'tool' as const, id: `tool:${call.id}`, at: call.startedAt, index, call })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index);
  const status = subagentStatusLabel(subagent.status);

  return <section className="single-subagent-view" aria-label={`@${subagent.handle} subagent chat`}>
    <header className="single-subagent-view__head">
      <button ref={backButton} type="button" className="single-subagent-view__back" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" /> Back to conversation</button>
      <div className="single-subagent-view__title">
        <AgentIdentity handle={subagent.handle} identityKey={subagent.id} provider={provider} />
        <span className={cx('single-subagent-view__status', `is-${subagent.status}`)}>
          {subagent.status === 'running' ? <LoaderCircle size={13} className="single-subagents__spinner" aria-hidden="true" /> : null}{status}
        </span>
      </div>
      <small>{subagent.model} · {subagent.type}</small>
    </header>
    <div className="single-subagent-view__scroll">
      <div className="chat__inner single-subagent-view__inner">
        <MessageRow m={message(subagent, `${subagent.id}:prompt`, 'user', prompt || 'Prompt not reported by the provider.', parentCall.startedAt, false)} provider={provider} />
        {timeline.map((item) => item.kind === 'message'
          ? <MessageRow key={item.id} m={message(subagent, item.entry.id, 'assistant', item.entry.content, item.entry.createdAt, subagent.status === 'running')} provider={provider} />
          : <ToolDetail key={item.id} call={item.call} calls={allCalls} />)}
        {subagent.status === 'running' && subagent.messages.length === 0 && roots.length === 0 ? <div className="working" role="status"><span className="activity-shimmer">Subagent is working…</span></div> : null}
        {loadError ? <p className="single-subagent-view__notice" role="status">Some full tool details could not be loaded. Showing the available activity.</p> : null}
        {subagent.status !== 'running' ? <section className="single-subagent-view__result" aria-label="Final result">
          <strong>Final result</strong>
          {parentCall.output ? <Markdown text={parentCall.output} /> : <p>No final result was reported by the provider.</p>}
        </section> : null}
      </div>
    </div>
  </section>;
}
