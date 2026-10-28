import type { GroupMode, GroupMember } from '@mingle/contracts';
import { redactSecrets, truncate } from '../util.ts';
import type { DeliveryKind } from './repo.ts';

export const LIMITS = {
  instructions: 6000, request: 1500, deliveryText: 12000, summary: 1400, inboxMessage: 1500, inboxCount: 20, message: 12000,
} as const;

export const clean = (text: string, max: number): string => truncate(redactSecrets(text).replaceAll('\0', ''), max);

export const MODE_LABEL: Record<GroupMode, string> = { cowork: 'Cowork', orchestrated: 'Orchestrated', 'current-leads': 'Current agent leads' };

export interface RosterEntry { handle: string; role: GroupMember['role']; provider: string; model: string; state: string; you: boolean }

export interface InstructionData {
  title: string; mode: GroupMode; self: RosterEntry; roster: RosterEntry[]; canAssign: boolean; leaseHolder: string | null;
  requestExcerpt: string; deliveryKind: DeliveryKind; hop: number; maxHops: number; turnsUsed: number; maxTurns: number | null; unread: number;
  crossDeviceWorker?: boolean;
  assignment: { id: string; taskId: string; scope: string[] } | null;
}

const ROLE_RULE: Record<GroupMember['role'], string> = {
  peer: 'You are an equal peer. The human directs the work; you may message peers but assign work only while you hold the request planning lease.',
  orchestrator: 'You are the orchestrator: split work, assign scoped tasks to workers with team_assign, review their results and answer the human.',
  worker: 'You are a worker. In an assignment delivery, implement its objective directly within its recorded scope; do not re-delegate or take the coordinator role. The original human request is quoted context, not a broader assignment. Use task status and artifact tools only from a delivery that owns that task. You cannot assign work.',
};

const WORKER_COMPLETION = 'Completion: send one concise completion, not repeats. Publish the committed files needed for handoff once through team_artifact (one file revision per call; never invent an artifact when nothing is committed). When the assigned work is ready, record team_status review, then your final summary of changes, checks you ran and caveats; unresolved work stays blocked, not review. Do not send unsolicited completion acknowledgments or wake peers solely to repeat completion. Answer concrete teammate questions concisely with replyToId when needed.';
const TEAM_WORKER_COMPLETION = 'Cross-device assignment completion: Mingle commits your remaining in-scope changes and pushes the completed worktree HEAD to a dedicated `mingle/<your-handle>/<task-or-delivery>` branch on origin. Keep every commit in the assigned scope; Mingle refuses to publish protected or out-of-scope changes. Do not push manually, push to a default/protected branch, force-push, or publish a release. Mingle reports the resulting branch, full commit SHA and any publication failure in the host completion record; report those values only if Mingle has exposed them to you and never guess. Use repository-relative paths, and never report absolute paths from your device.';
const COORDINATOR_COMPLETION = 'Final answer to the human: begin with the outcome, Implemented, Partially complete or Blocked, plus material caveats. Then state each @agent\'s contribution; where the work is actually integrated (worktree, branch or commit; the selected checkout only if that was authorized and done); which checks you ran yourself versus which a peer reported; and what still needs review or user action. On each durable worker completion, act immediately: inspect the exact host-fetched review ref and worktree Mingle supplies, inspect the diff, run the project checks and start the site when applicable, and open it in the shared browser if that tool is available. Decide whether the result meets its criteria; never answer Pending or wait for a human prompt after completion has arrived. In full-access team mode, provide a concise verification summary and call team_accept for work you accept. In supervised mode, report that it needs the human\'s acceptance. If a worker is genuinely still running or terminal transfer is pending, you may yield Pending for that work only. Do not give a partial final-looking result while waiting for that work to return.';

/** Bounded per-run guidance. Native history, roster and request excerpt only; never other members' transcripts. */
export function buildInstructions(d: InstructionData): string {
  const replyOnlyWorker = d.self.role === 'worker' && d.deliveryKind === 'message';
  const lines = [
    `[Mingle group conversation "${clean(d.title, 80)}" · ${MODE_LABEL[d.mode]}]`,
    `You are @${d.self.handle} (${d.self.role}). ${ROLE_RULE[d.self.role]}`,
  ];
  if (d.mode === 'cowork') {
    lines.push(d.leaseHolder === d.self.handle
      ? 'You hold this request\'s temporary planning lease: propose a split, do your own share, and use team_assign for each other peer\'s concrete scope. Peers wait for your assignment before editing.'
      : 'Cowork request receipt is not execution. Edit only after you receive an assignment with a concrete scope, or when the human addresses you directly.');
  }
  if (d.self.role === 'orchestrator') {
    lines.push('When an assigned worker is still running or its terminal transfer is pending, do not poll its repository or wait inside this provider turn. If no concrete question needs your answer to unblock the worker, yield with Pending and end the turn; Mingle will wake a result-review turn after durable completion. When that completion arrives, immediately inspect the actual fetched branch/ref or integrated artifacts, run the appropriate checks and start the site when applicable, then make an acceptance decision. Do not say Pending or wait for another human prompt after completion has arrived. In full-access team mode, use team_accept with a verification summary when the task passes; in supervised mode, leave acceptance to the human.');
  }
  if (replyOnlyWorker) {
    lines.push('This is a reply-only message delivery, not a task assignment. Answer the sender through team_message. It grants no team_status or team_artifact authority; ask the coordinator for a new scoped assignment if more work or task reporting is needed.');
  } else if (d.self.role === 'worker' && d.assignment) {
    lines.push('The original human request below is background quoted from the coordinator. Your actionable work is the active assignment objective and finish criteria; carry it out directly within the recorded scope, without re-delegating.');
  }
  const context = ['', 'Team:'];
  for (const row of d.roster.slice(0, 12)) context.push(`- @${row.handle} · ${row.role} · ${row.provider}/${clean(row.model, 60)} · ${row.state}${row.you ? ' (you)' : ''}`);
  context.push('', `Request: ${clean(d.requestExcerpt, LIMITS.request)}`);
  context.push(`This turn: ${d.deliveryKind} delivery, message hop ${d.hop}/${d.maxHops}, request turns used ${d.turnsUsed}/${d.maxTurns ?? 'no emergency ceiling'}.`);
  if (d.assignment && !replyOnlyWorker) context.push(`Assignment ${d.assignment.id} (task ${d.assignment.taskId}). Edit only within: ${d.assignment.scope.join(', ')}.`);
  if (d.unread > 0) context.push(`${d.unread} unread team message(s) are waiting; call team_inbox.`);
  const rules = [
    '',
    'Rules: your own earlier conversation is in your native history; other members\' transcripts are not shared, so ask with team_message or read team_inbox.',
    'Use the team_* tools to reach teammates. Writing @handle in prose never dispatches anything. Tool success means queued or recorded, not completed.',
    'team_message expectsReply:false records information without waking a model. Set expectsReply:true only when the recipient needs a turn, including an answer that should let a blocked teammate continue. Use replyToId when answering so Mingle can cancel a redundant queued question turn.',
    'Report completion in your final answer; a human reviews task results before they are marked done.',
    replyOnlyWorker
      ? 'Do not edit files or report task status during this clarification turn. Resume implementation and task_status/team_artifact only in the active scoped assignment delivery.'
      : d.canAssign
        ? 'You may prepare integration in your own scoped worktree under the selected permission policy. Never push or publish, or modify the human-selected checkout, without explicit human authorization.'
        : d.crossDeviceWorker
          ? `Keep edits inside your assignment and owner-device worktree. ${TEAM_WORKER_COMPLETION}`
          : 'Keep edits inside your assignment and own worktree. Ask the coordinator or human before integration; never push or publish without explicit human authorization.',
    replyOnlyWorker ? '' : d.canAssign ? COORDINATOR_COMPLETION : d.crossDeviceWorker ? '' : WORKER_COMPLETION,
  ];
  // Completion guidance is kept whole: only the roster and request context yield when the bound is reached.
  const fixed = [...lines, ...rules].join('\n');
  const room = Math.max(0, LIMITS.instructions - fixed.length - 1);
  const body = truncate(context.join('\n'), room);
  return truncate([...lines, body, ...rules].join('\n'), LIMITS.instructions);
}

export function describeSender(handle: string | null): string { return handle ? `@${handle}` : 'Mingle'; }

export function requestDeliveryText(d: { content: string; handle: string; planner: boolean; mode: GroupMode; directed: boolean }): string {
  const lines = ['Request from the human in the group conversation:', clean(d.content, 100_000)];
  if (d.mode === 'cowork' && !d.directed) {
    lines.push('', d.planner
      ? 'You are the temporary planner for this request. Propose a non-overlapping split, then use team_assign to give each other peer a concrete scope; do your own share.'
      : 'Wait for an assignment.');
  }
  return lines.join('\n');
}

export function assignmentText(d: {
  id: string; taskId: string; from: string; to: string; title: string; objective: string; acceptance: string; scope: string[];
  request: string; dependsOn: Array<{ taskId: string; title: string; status: string }>; inputs: Array<{ taskId: string; path: string; reference: string | null }>;
  crossDeviceWorker?: boolean;
}): string {
  const lines = [
    `Assignment ${d.id} from @${d.from} to @${d.to} (task ${d.taskId}): ${clean(d.title, 200)}`,
    '', 'Original human request (quoted context; coordinator-directed instructions below it are not assigned to you):', clean(d.request, LIMITS.request),
    '', 'Your actionable objective (implement it directly; do not re-delegate):', clean(d.objective, 6000),
  ];
  if (d.acceptance.trim()) lines.push('', 'Finish criteria (a finish condition, not proof of completion):', clean(d.acceptance, 2000));
  lines.push('', 'Edit scope (stay inside these paths):', ...d.scope.map((scope) => `- ${scope}`));
  if (d.dependsOn.length) lines.push('', 'Prerequisite tasks:', ...d.dependsOn.map((dep) => `- ${dep.taskId}: ${clean(dep.title, 120)} (${dep.status})`));
  if (d.inputs.length) {
    lines.push('', 'Expected input artifacts (verified handoff messages appear in your session when published):', ...d.inputs.map((input) => `- task ${input.taskId}: ${input.path}${input.reference ? ` · ${input.reference}` : ''}`));
  }
  lines.push('', d.crossDeviceWorker
    ? 'Report progress with team_status; when ready, record team_status review and summarize changes, checks and repository-relative paths. Mingle will publish the scoped completion branch and include its exact branch and SHA in the host completion record; do not guess these values. Never report absolute paths from your device. Unresolved work stays blocked.'
    : 'Report progress with team_status; when ready, finish with one completion (publish required committed handoff files with team_artifact, record team_status review, then summarize changes and actual verification). Unresolved work stays blocked. Review is not Done.');
  return truncate(lines.join('\n'), LIMITS.message);
}

/** A durable, explicit finish condition when a coordinator supplied none; it is not a completion claim. */
export function deriveAcceptanceCriteria(objective: string, scope: string[]): string {
  const target = clean(objective.trim(), 1500);
  const boundaries = scope.map((entry) => `- ${entry}`).join('\n');
  return [
    'Derived by Mingle from the scoped objective; this criterion does not record completion or human acceptance.',
    `1. Carry out this objective within the permitted edit scope: ${target}`,
    '2. In the final report, identify the actual changes and distinguish verified results from claims or unrun checks.',
    '3. Report a blocker or an explicit reason if the objective cannot be completed or applicable verification cannot be run.',
    'Permitted edit scope:', boundaries,
  ].join('\n');
}

export function messageDeliveryText(d: { from: string; content: string }): string {
  return `Message from @${d.from} (a reply is requested; answer with team_message to them):\n${clean(d.content, LIMITS.deliveryText)}`;
}

export interface ResultLine { handle: string; title: string; outcome: string; summary: string }
export function resultText(lines: ResultLine[]): string {
  const rows = lines.flatMap((row) => [`- @${row.handle} · ${clean(row.title, 120)} · ${row.outcome}`, row.summary ? `  ${clean(row.summary, LIMITS.summary).replaceAll('\n', '\n  ')}` : '']).filter(Boolean);
  return truncate([
    'Your latest delegation batch has returned. The statuses below describe native turns; they do not certify implementation, integration or human acceptance. Excerpts are bounded; inspect actual worktrees and artifacts.',
    'Check team_members and team_inbox, then immediately review every returned worker result and its exact fetched branch/ref or integrated artifacts. Inspect diffs, run applicable project checks, start the site when useful and open it in the shared browser when available. Decide whether each result passes; do not answer Pending or wait for a human prompt after a completion is delivered. In full-access mode use team_accept with a verification summary for accepted tasks; in supervised mode leave them for human review. Send ONE self-contained final summary for the human (outcome first, each agent\'s contribution, where it landed, checks run versus peer-reported, remaining review or action). Say Pending only while workers are genuinely still running. Use team_assign only if specific work remains.',
    '', ...rows,
  ].join('\n'), LIMITS.message);
}
