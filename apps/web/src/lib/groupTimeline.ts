import type { GroupDelivery, GroupMember, GroupMessage, GroupSnapshot, Message, Session, SessionPlan, SessionRun, ToolCall, UserQuestion } from '@mingle/contracts';
import type { StreamEntry } from '../store/store';
import type { DisplayMessage } from './conversation';

export interface Speaker { memberId: string; sessionId: string; handle: string; role: GroupMember['role']; removed: boolean }
export interface NativeItem { type: 'native'; key: string; at: number; message: DisplayMessage; sessionId: string; speaker: Speaker | null; hidden: boolean }
export interface GroupItem { type: 'group'; key: string; at: number; message: GroupMessage; sender: Speaker | null; recipients: Speaker[]; deliveries: GroupDelivery[] }
export interface FailureItem { type: 'failure'; key: string; at: number; delivery: GroupDelivery; member: Speaker | null }
type ActivityItem = { type: 'activity'; key: string; at: number; run: SessionRun };
type ChangesItem = { type: 'changes'; key: string; at: number; run: SessionRun };
type QuestionItem = { type: 'question'; key: string; at: number; question: UserQuestion };
type PlanItem = { type: 'plan'; key: string; at: number; plan: SessionPlan; reviewReady: boolean };
export type TimelineItem = NativeItem | GroupItem | FailureItem | ActivityItem | ChangesItem | QuestionItem | PlanItem;

/** The server marks the human's delivery to a member with this kind; the group message already shows it once. */
export const HIDDEN_NATIVE_KIND = 'group-delivery';
const LIVE_UNTIL_SETTLED = Number.MAX_SAFE_INTEGER;

const time = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : LIVE_UNTIL_SETTLED;
};

export function speakers(snapshot: GroupSnapshot): { byMember: Map<string, Speaker>; bySession: Map<string, Speaker> } {
  const byMember = new Map<string, Speaker>();
  const bySession = new Map<string, Speaker>();
  for (const member of snapshot.members) {
    const speaker: Speaker = { memberId: member.id, sessionId: member.sessionId, handle: member.handle, role: member.role, removed: Boolean(member.removedAt) };
    byMember.set(member.id, speaker);
    const current = bySession.get(member.sessionId);
    if (!current || (current.removed && !speaker.removed)) bySession.set(member.sessionId, speaker);
  }
  return { byMember, bySession };
}

/** Last moment a removed member's session still belongs to this conversation; null while it is a member. */
function cutoffs(snapshot: GroupSnapshot): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const member of snapshot.members) {
    const current = out.get(member.sessionId);
    if (current === null) continue;
    out.set(member.sessionId, member.removedAt ? Math.max(current ?? 0, time(member.removedAt)) : null);
  }
  return out;
}

export function memberSessionIds(snapshot: GroupSnapshot): Set<string> {
  return new Set(snapshot.members.map((member) => member.sessionId));
}

export function buildTimeline({ snapshot, sessions, messages, streams, runs = [], questions = [], plans = [] }: {
  runs?: readonly SessionRun[]; questions?: readonly UserQuestion[]; plans?: readonly SessionPlan[];
  snapshot: GroupSnapshot; sessions: readonly Session[]; messages: readonly Message[]; streams: Record<string, StreamEntry>;
}): TimelineItem[] {
  const { byMember, bySession } = speakers(snapshot);
  const cutoff = cutoffs(snapshot);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const withinGroup = (sessionId: string, at: number): boolean => {
    if (!cutoff.has(sessionId)) return false;
    const end = cutoff.get(sessionId);
    return end === null || end === undefined || at <= end;
  };

  const natives: NativeItem[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const at = time(message.createdAt);
    if (!withinGroup(message.sessionId, at)) continue;
    seen.add(message.id);
    const stream = streams[message.id];
    const streamed = stream ? stream.base + stream.text : '';
    const session = sessionById.get(message.sessionId);
    natives.push({
      type: 'native', key: `n:${message.id}`, at, sessionId: message.sessionId, speaker: bySession.get(message.sessionId) ?? null,
      hidden: message.role === 'user' && message.kind === HIDDEN_NATIVE_KIND,
      message: {
        id: message.id, sessionId: message.sessionId, role: message.role, content: streamed.length > message.content.length ? streamed : message.content, createdAt: message.createdAt,
        kind: message.kind, runId: message.runId, live: (Boolean(stream) || message.kind === 'streaming') && session?.status === 'running', attachments: message.attachments, contextRefs: message.contextRefs,
      },
    });
  }
  // Streams whose row the snapshot has not reached yet stay live and distinct per message.
  for (const [id, stream] of Object.entries(streams)) {
    if (seen.has(id) || !cutoff.has(stream.sessionId) || cutoff.get(stream.sessionId) !== null) continue;
    natives.push({
      type: 'native', key: `n:${id}`, at: LIVE_UNTIL_SETTLED, sessionId: stream.sessionId, speaker: bySession.get(stream.sessionId) ?? null, hidden: false,
      message: { id, sessionId: stream.sessionId, role: 'assistant', content: stream.base + stream.text, createdAt: '', live: sessionById.get(stream.sessionId)?.status === 'running' },
    });
  }
  const order = new Map(natives.map((item, index) => [item.key, index]));
  natives.sort((a, b) => a.at - b.at || order.get(a.key)! - order.get(b.key)!);

  // Hide only agent mirrors of native rows. Status and delivery rows carry durable routing state.
  const displayed = new Set(natives.filter((item) => !item.hidden).map((item) => item.message.id));
  const deliveriesByMessage = new Map<string, GroupDelivery[]>();
  for (const delivery of snapshot.deliveries) {
    const list = deliveriesByMessage.get(delivery.messageId) ?? [];
    list.push(delivery);
    deliveriesByMessage.set(delivery.messageId, list);
  }
  const groupItems: GroupItem[] = snapshot.messages
    .filter((message) => !(message.kind === 'agent' && message.sourceMessageId && displayed.has(message.sourceMessageId)))
    .sort((a, b) => a.seq - b.seq)
    .map((message) => ({
      type: 'group' as const, key: `g:${message.id}`, at: time(message.createdAt), message,
      sender: message.senderMemberId ? byMember.get(message.senderMemberId) ?? null : null,
      recipients: message.recipientMemberIds.flatMap((id) => byMember.get(id) ?? []),
      deliveries: deliveriesByMessage.get(message.id) ?? [],
    }));

  const merged: TimelineItem[] = [];
  let g = 0;
  let n = 0;
  while (g < groupItems.length || n < natives.length) {
    const group = groupItems[g];
    const native = natives[n];
    if (group && (!native || group.at <= native.at)) { merged.push(group); g++; } else { merged.push(native!); n++; }
  }

  const runById = new Map(runs.map(run => [run.id, run]));
  const byMessageId = new Map(natives.map(item => [item.message.id, item]));
  const latestNativeAt = new Map<string, number>();
  for (const item of natives) if (item.message.runId) latestNativeAt.set(item.message.runId, item.at);
  const dated: TimelineItem[] = snapshot.deliveries
    .filter((delivery) => delivery.status === 'failed' && delivery.error)
    .map((delivery) => ({ type: 'failure', key: `f:${delivery.id}`, at: time(delivery.updatedAt), delivery, member: byMember.get(delivery.memberId) ?? null }));
  for (const run of runs) {
    const started = time(run.startedAt);
    if (!withinGroup(run.sessionId, started)) continue;
    const originAt = byMessageId.get(run.userMessageId)?.at ?? started;
    dated.push({ type: 'activity', key: `activity:${run.id}`, at: Math.max(started, originAt), run });
    if (run.status !== 'running') {
      const last = latestNativeAt.get(run.id) ?? originAt;
      dated.push({ type: 'changes', key: `changes:${run.id}`, at: Math.max(originAt, last, run.finishedAt ? time(run.finishedAt) : last), run });
    }
  }
  for (const question of questions) {
    const at = time(question.createdAt);
    if (withinGroup(question.sessionId, at)) dated.push({ type: 'question', key: `question:${question.id}`, at, question });
  }
  for (const plan of plans) {
    if (!withinGroup(plan.sessionId, time(plan.createdAt))) continue;
    const run = runById.get(plan.runId);
    dated.push({ type: 'plan', key: `plan:${plan.id}`, at: time(run?.finishedAt ?? plan.createdAt), plan, reviewReady: run?.status === 'completed' });
  }
  dated.sort((a, b) => a.at - b.at);
  const result: TimelineItem[] = [];
  let next = 0;
  for (const item of merged) {
    while (dated[next] && dated[next]!.at < item.at) result.push(dated[next++]!);
    result.push(item);
  }
  return result.concat(dated.slice(next));
}

export function groupRuns(snapshot: GroupSnapshot, runs: readonly SessionRun[]): SessionRun[] {
  const cutoff = cutoffs(snapshot);
  return runs.filter((run) => {
    if (!cutoff.has(run.sessionId)) return false;
    const end = cutoff.get(run.sessionId);
    return end === null || end === undefined || time(run.startedAt) <= end;
  });
}

export function toolCallsByRun(calls: readonly ToolCall[], sessionIds: ReadonlySet<string>): Map<string, ToolCall[]> {
  const grouped = new Map<string, ToolCall[]>();
  for (const call of calls) {
    if (!sessionIds.has(call.sessionId)) continue;
    const rows = grouped.get(call.runId) ?? [];
    rows.push(call);
    grouped.set(call.runId, rows);
  }
  return grouped;
}
