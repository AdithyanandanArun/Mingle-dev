import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { TeamStructureMember, TeamStructureSnapshot } from '@mingle/contracts';

export const TEAM_NODE_WIDTH = 292;
export const TEAM_NODE_HEIGHT = 164;
const WORKER_GAP_X = 316;
const WORKER_GAP_Y = 188;

export interface TeamNodeData {
  kind: 'leader' | 'member' | 'lane';
  member?: TeamStructureMember;
  lane?: 'workers' | 'bench';
  title?: string;
  description?: string;
  width?: number;
  height?: number;
  needsLeader?: boolean;
  canEdit?: boolean;
  onPromote?: (member: TeamStructureMember) => void;
  onRoleChange?: (member: TeamStructureMember, role: 'worker' | 'idle') => void;
  onFallback?: (member: TeamStructureMember, rank: number) => void;
  onRemove?: (member: TeamStructureMember) => void;
  fallbackIds?: string[];
  [key: string]: unknown;
}

export type TeamFlowNode = Node<TeamNodeData>;

export interface TeamStructureGraph {
  nodes: TeamFlowNode[];
  edges: Edge[];
}

function stableMembers(members: TeamStructureMember[]): TeamStructureMember[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return [...members].sort((a, b) => compare(a.handle, b.handle) || compare(a.agentId, b.agentId));
}

/** Deterministic, role-driven coordinates; positions are never persisted. */
export function buildTeamStructureGraph(snapshot: TeamStructureSnapshot, actions: Pick<TeamNodeData, 'onPromote' | 'onRoleChange' | 'onFallback' | 'onRemove'> = {}): TeamStructureGraph {
  const canEdit = snapshot.canEdit && Boolean(snapshot.settings);
  const allLeaders = snapshot.members.filter((member) => member.role === 'orchestrator');
  const leader = snapshot.needsLeader ? null : allLeaders[0] ?? null;
  const workers = stableMembers(snapshot.members.filter((member) => member.role === 'worker'));
  // Keep a failed current leader visible as unavailable while presenting the actual empty drop slot.
  const idleMembers = stableMembers(snapshot.members.filter((member) => member.role === 'idle'));
  const bench = snapshot.needsLeader && allLeaders[0] ? [allLeaders[0], ...idleMembers] : idleMembers;
  const columns = Math.max(1, Math.min(3, workers.length));
  const rows = Math.max(1, Math.ceil(workers.length / columns));
  const workerWidth = Math.max(660, columns * WORKER_GAP_X + 28);
  const laneHeight = Math.max(218, rows * WORKER_GAP_Y + 76);
  const benchX = 32 + workerWidth + 28;
  const benchHeight = Math.max(218, bench.length * WORKER_GAP_Y + 76);
  const leaderX = 32 + Math.max(0, (workerWidth - TEAM_NODE_WIDTH) / 2);
  const leaderY = 28;
  const laneY = 270;
  const fallbackIds = snapshot.settings?.fallbackAgentIds ?? [];
  const nodes: TeamFlowNode[] = [
    {
      id: 'lane:workers', type: 'teamLane', position: { x: 32, y: laneY }, draggable: false, selectable: false, connectable: false, zIndex: -1,
      style: { width: workerWidth, height: laneHeight },
      data: { kind: 'lane', lane: 'workers', title: 'Workers', description: 'Agents assigned to receive orchestrated work', width: workerWidth, height: laneHeight },
    },
    {
      id: 'lane:bench', type: 'teamLane', position: { x: benchX, y: laneY }, draggable: false, selectable: false, connectable: false, zIndex: -1,
      style: { width: 310, height: benchHeight },
      data: { kind: 'lane', lane: 'bench', title: 'Idle bench', description: 'Available to move back into the team', width: 310, height: benchHeight },
    },
    {
      id: 'leader-slot', type: 'teamLeader', position: { x: leaderX, y: leaderY }, draggable: Boolean(canEdit && leader), selectable: false, connectable: false,
      style: { width: TEAM_NODE_WIDTH, height: TEAM_NODE_HEIGHT },
      data: { kind: 'leader', member: leader ?? undefined, needsLeader: snapshot.needsLeader, canEdit, fallbackIds, ...actions },
    },
  ];

  workers.forEach((member, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    nodes.push({
      id: `member:${member.agentId}`, type: 'teamMember', position: { x: 48 + column * WORKER_GAP_X, y: laneY + 58 + row * WORKER_GAP_Y },
      draggable: canEdit, selectable: false, connectable: false,
      style: { width: TEAM_NODE_WIDTH, height: TEAM_NODE_HEIGHT },
      data: { kind: 'member', member, canEdit, needsLeader: snapshot.needsLeader, fallbackIds, ...actions },
    });
  });

  bench.forEach((member, index) => {
    nodes.push({
      id: `member:${member.agentId}`, type: 'teamMember', position: { x: benchX + 9, y: laneY + 58 + index * WORKER_GAP_Y },
      draggable: canEdit, selectable: false, connectable: false,
      style: { width: TEAM_NODE_WIDTH, height: TEAM_NODE_HEIGHT },
      data: { kind: 'member', member, canEdit, needsLeader: snapshot.needsLeader, fallbackIds, ...actions },
    });
  });

  const edges: Edge[] = leader ? workers.map((member) => ({
    id: `team:${leader.agentId}:${member.agentId}`,
    source: 'leader-slot', sourceHandle: 'out', target: `member:${member.agentId}`, targetHandle: 'in',
    type: 'smoothstep', className: `team-edge${leader.state === 'working' || member.state === 'working' ? ' team-edge--active' : ''}`,
    animated: leader.state === 'working' || member.state === 'working',
    markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13 },
  })) : [];

  return { nodes, edges };
}
