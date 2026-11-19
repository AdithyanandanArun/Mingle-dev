import type { GroupDelivery, GroupMember, GroupMessage, GroupSnapshot, Message, Session, SessionRun, ToolCall } from '@mingle/contracts';
import type { StreamEntry } from '../store/store';
import type { DisplayMessage } from './conversation';

export interface Speaker { memberId: string; sessionId: string; handle: string; role: GroupMember['role']; removed: boolean }
export interface NativeItem { type: 'native'; key: string; at: number; message: DisplayMessage; sessionId: string; speaker: Speaker | null; hidden: boolean }
export interface GroupItem { type: 'group'; key: string; at: number; message: GroupMessage; sender: Speaker | null; recipients: Speaker[]; deliveries: GroupDelivery[] }
export interface FailureItem { type: 'failure'; key: string; at: number; delivery: GroupDelivery; member: Speaker | null }
export type TimelineItem = NativeItem | GroupItem | FailureItem;

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

export function buildTimeline({ snapshot, sessions, messages, streams }: {
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

  const failures: FailureItem[] = snapshot.deliveries
    .filter((delivery) => delivery.status === 'failed' && delivery.error)
    .map((delivery) => ({ type: 'failure' as const, key: `f:${delivery.id}`, at: time(delivery.updatedAt), delivery, member: byMember.get(delivery.memberId) ?? null }))
    .sort((a, b) => a.at - b.at);
  for (const failure of failures) {
    let index = merged.length;
    for (let i = 0; i < merged.length; i++) if (merged[i]!.at > failure.at) { index = i; break; }
    merged.splice(index, 0, failure);
  }
  return merged;
}

export interface RunPlacement { activityAfter: Map<string, SessionRun[]>; changesAfter: Map<string, SessionRun[]>; unplaced: SessionRun[] }

/** Runs and changed-file cards belong beside the member row that produced them, as in a single session. */
export function placeRuns(items: readonly TimelineItem[], runs: readonly SessionRun[]): RunPlacement {
  const natives = items.filter((item): item is NativeItem => item.type === 'native');
  const byMessage = new Map(natives.map((item) => [item.message.id, item]));
  const activityAfter = new Map<string, SessionRun[]>();
  const changesAfter = new Map<string, SessionRun[]>();
  const unplaced: SessionRun[] = [];
  const push = (map: Map<string, SessionRun[]>, key: string, run: SessionRun): void => { const list = map.get(key) ?? []; list.push(run); map.set(key, list); };
  for (const run of runs) {
    const origin = byMessage.get(run.userMessageId);
    if (!origin) { unplaced.push(run); continue; }
    push(activityAfter, origin.key, run);
    const own = natives.filter((item) => item.message.runId === run.id && item.message.role !== 'tool');
    // A change summary describes the completed run, so anchor it to the last
    // transcript row at or before completion (rather than the last assistant
    // row, which can precede later tool output or other members' messages).
    const finishedAt = time(run.finishedAt);
    const target = Number.isFinite(finishedAt)
      ? [...natives].reverse().find((item) => item.at <= finishedAt && (item.sessionId === run.sessionId || item.at > origin.at)) ?? origin
      : [...own].reverse().find((item) => item.message.role === 'assistant') ?? own.at(-1) ?? origin;
    push(changesAfter, target.key, run);
  }
  unplaced.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { activityAfter, changesAfter, unplaced };
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
