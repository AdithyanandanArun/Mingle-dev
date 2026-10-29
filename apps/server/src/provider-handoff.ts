import type { Message, Provider, SessionPlan, Task } from '@mingle/contracts';
import { redactSecrets } from './util.ts';

export const PROVIDER_HANDOFF_MAX_CHARS = 24_000;
const RECENT_FULL_EXCHANGES = 3;

export interface ProviderHandoffInput {
  fromProvider: Provider;
  fromModel: string;
  toProvider: Provider;
  toModel: string;
  latestPlan?: SessionPlan;
  openTasks: Task[];
  changedFiles: string[];
  diffStat?: string;
  messages: Message[];
  maxChars?: number;
}

function safe(value: unknown, limit: number): string {
  return redactSecrets(typeof value === 'string' ? value : String(value ?? '')).slice(0, limit);
}

function boundedSection(title: string, content: string, limit: number): string {
  const body = content.trim();
  if (!body) return '';
  const section = `${title}\n${body}`;
  return section.length <= limit ? section : section.slice(0, limit);
}

function planText(plan?: SessionPlan): string {
  if (!plan) return '';
  const steps = plan.steps.map((step) => {
    const detail = [step.description, ...step.acceptanceCriteria.map((criteria) => `Acceptance: ${criteria}`)].filter(Boolean).join('\n  ');
    return `- [${step.status}] ${safe(step.title, 200)}${detail ? `\n  ${safe(detail, 800)}` : ''}`;
  }).join('\n');
  return [
    `Revision ${plan.revision} · ${plan.status}`,
    safe(plan.explanation, 1200),
    steps,
  ].filter(Boolean).join('\n');
}

function taskText(tasks: Task[]): string {
  return tasks.filter((task) => task.status !== 'done').slice(0, 40).map((task) => {
    const details = [task.description, task.acceptanceCriteria ? `Acceptance: ${task.acceptanceCriteria}` : ''].filter(Boolean).join('\n  ');
    return `- [${task.status}] ${safe(task.title, 200)}${details ? `\n  ${safe(details, 500)}` : ''}`;
  }).join('\n');
}

interface TranscriptGroup { indexes: number[]; complete: boolean }

function transcriptGroups(messages: Message[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') return;
    if (message.role === 'user' || !groups.length) groups.push({ indexes: [], complete: false });
    const group = groups.at(-1)!;
    group.indexes.push(index);
    if (message.role === 'user' && group.indexes.some((i) => messages[i]?.role === 'assistant')) group.complete = true;
    if (message.role === 'assistant' && group.indexes.some((i) => messages[i]?.role === 'user')) group.complete = true;
  });
  return groups;
}

function renderTranscriptMessage(message: Message): string {
  const role = message.role === 'user' ? 'User' : 'Assistant';
  const timestamp = message.createdAt ? ` · ${safe(message.createdAt, 40)}` : '';
  return `${role}${timestamp}:\n${safe(message.content, 100_000).trim()}`;
}

/** Builds a deterministic, local-only, bounded context block. Tool/system messages are never included. */
export function buildProviderHandoff(input: ProviderHandoffInput): string {
  const maxChars = Math.max(1, Math.min(input.maxChars ?? PROVIDER_HANDOFF_MAX_CHARS, PROVIDER_HANDOFF_MAX_CHARS));
  const header = [
    '[Mingle context handoff — continuing a conversation from another provider]',
    `Previous provider: ${safe(input.fromProvider, 50)} · ${safe(input.fromModel, 150)}`,
    `Current provider: ${safe(input.toProvider, 50)} · ${safe(input.toModel, 150)}`,
    'This is locally assembled context from the existing Mingle session. Treat it as prior conversation and continue from the current user request.',
  ].join('\n');
  const files = [
    ...input.changedFiles.slice(0, 80).map((file) => `- ${safe(file, 500)}`),
    input.diffStat ? safe(input.diffStat, 1800) : '',
  ].filter(Boolean).join('\n');
  const metadata = [
    header,
    boundedSection('Current Mingle plan (latest revision)', planText(input.latestPlan), 4_500),
    boundedSection('Open tasks', taskText(input.openTasks), 3_500),
    boundedSection('Changed worktree files (paths and diff statistics only; no file contents)', files, 3_500),
  ].filter(Boolean).join('\n\n');
  const metadataBudget = Math.min(metadata.length, Math.floor(maxChars * 0.58));
  const prefix = metadata.slice(0, metadataBudget);
  const transcriptTitle = 'Prior user and assistant conversation (most recent first priority)';
  const transcriptBudget = Math.max(0, maxChars - prefix.length - transcriptTitle.length - 3);
  const eligible = input.messages.filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim());
  const groups = transcriptGroups(input.messages);
  const fullRecent = groups.filter((group) => group.complete).slice(-RECENT_FULL_EXCHANGES);
  const trailingIncomplete = groups.at(-1)?.complete ? [] : groups.at(-1) ? [groups.at(-1)!] : [];
  const priorityGroups = [...new Set([...trailingIncomplete, ...fullRecent].reverse())];
  const priorityIndexes = priorityGroups.flatMap((group) => [...group.indexes].reverse());
  const olderIndexes = groups.filter((group) => !priorityGroups.includes(group)).reverse().flatMap((group) => [...group.indexes].reverse());
  const priorityOrder = [...priorityIndexes, ...olderIndexes].filter((index) => {
    const message = input.messages[index];
    return message && (message.role === 'user' || message.role === 'assistant') && message.content.trim();
  });
  const selected = new Map<number, string>();
  let remaining = transcriptBudget;
  for (const index of priorityOrder) {
    if (remaining <= 0) break;
    const message = input.messages[index];
    if (!message || !eligible.includes(message)) continue;
    const rendered = renderTranscriptMessage(message);
    const separator = selected.size ? 2 : 0;
    if (rendered.length + separator <= remaining) {
      selected.set(index, rendered);
      remaining -= rendered.length + separator;
    } else {
      const clipped = rendered.slice(0, Math.max(0, remaining - separator));
      if (clipped) selected.set(index, clipped);
      remaining = 0;
      break;
    }
  }
  const transcript = [...selected.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('\n\n');
  const transcriptSection = transcript ? `${transcriptTitle}\n${transcript}` : '';
  const block = [prefix, transcriptSection].filter(Boolean).join('\n\n');
  return block.length <= maxChars ? block : block.slice(0, maxChars);
}
