import { TeamOrchestrationHost } from './host/service.ts';
import { registerTeamOrchestrationHostRoutes } from './host/routes.ts';
import type {
  TeamOrchestrationAccount, TeamOrchestrationChat, TeamOrchestrationCollaboration,
  TeamOrchestrationDeviceDependencies, TeamOrchestrationDeviceSide, TeamOrchestrationDeviceSideFactory,
  TeamOrchestrationGroups, TeamOrchestrationTransport, TeamRouteAdder, TeamMcpProxy,
} from './types.ts';
import type { Store } from '../store.ts';
import type { SessionRuntime } from '../runtime.ts';
import type { RecoveryService } from '../recovery/service.ts';
import type { Hub } from '../hub.ts';

export interface TeamOrchestrationOptions {
  store: Store;
  runtime: SessionRuntime;
  hub: Hub;
  transport: TeamOrchestrationTransport;
  account: TeamOrchestrationAccount;
  distributed: TeamOrchestrationDeviceDependencies['distributed'];
  collaboration: TeamOrchestrationCollaboration;
  groups: TeamOrchestrationGroups;
  teamChat: TeamOrchestrationChat;
  teamMcp: TeamMcpProxy;
  recovery: Pick<RecoveryService, 'recordFailure' | 'clearFailure'>;
  changed?: () => void;
  now?: () => number;
  deliveryTimeoutMs?: number;
  deliveryMaxDurationMs?: number;
  deviceSide?: TeamOrchestrationDeviceSide;
  deviceSideFactory?: TeamOrchestrationDeviceSideFactory;
}

/** Constructs the local host and, when supplied by the device implementation, its owner-side executor. */
export function createTeamOrchestration(options: TeamOrchestrationOptions): {
  host: TeamOrchestrationHost;
  deviceSide: TeamOrchestrationDeviceSide | undefined;
  routes(add: TeamRouteAdder): void;
  close(): Promise<void>;
} {
  let deviceSide = options.deviceSide;
  if (!deviceSide && options.deviceSideFactory) {
    deviceSide = options.deviceSideFactory({
      store: options.store, runtime: options.runtime, hub: options.hub, transport: options.transport, account: options.account,
      distributed: options.distributed, collaboration: options.collaboration, teamChat: options.teamChat,
      changed: options.changed ?? (() => undefined),
    });
  }
  const host = new TeamOrchestrationHost({
    store: options.store, git: {
      exportTeamArtifact: (input) => options.distributed.git.exportTeamArtifact(input),
      importTeamArtifact: (input) => options.distributed.importTeamArtifact(input),
    }, account: options.account, transport: options.transport,
    authorizeTeam: (input) => options.distributed.authorizeTeam(input), collaboration: options.collaboration,
    groups: options.groups, teamMcp: options.teamMcp, recovery: options.recovery,
    deviceSide, changed: options.changed, now: options.now, deliveryTimeoutMs: options.deliveryTimeoutMs,
    deliveryMaxDurationMs: options.deliveryMaxDurationMs,
    publishLocalAgents: (input) => options.distributed.execution.publishAgents(input),
  });
  host.setTeamChat(options.teamChat);
  return {
    host,
    deviceSide,
    routes(add) {
      registerTeamOrchestrationHostRoutes(add, host);
      deviceSide?.routes(add);
    },
    async close() {
      await host.close();
      await deviceSide?.close();
    },
  };
}

export type TeamOrchestrationSubsystem = ReturnType<typeof createTeamOrchestration>;

export type { TeamOrchestrationDeviceDependencies, TeamOrchestrationDeviceSide, TeamOrchestrationDeviceSideFactory } from './types.ts';
export { TeamOrchestrationHost } from './host/service.ts';
