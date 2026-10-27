export type TeamLiveUpdateKind = 'structure' | 'chat';
export type TeamLiveUpdateEvent = { type: string; projectId: string | null };

const UPDATE_EVENTS: Record<TeamLiveUpdateKind, string> = {
  structure: 'mingle:team-structure-updated',
  chat: 'mingle:team-chat-updated',
};

/** Map only durable team mutations to the narrower UI events that own their refreshes. */
export function dispatchTeamUpdate(event: TeamLiveUpdateEvent, target: EventTarget = window): void {
  if (event.type === 'team.structure.updated' || event.type === 'team.session.updated') {
    target.dispatchEvent(new CustomEvent(UPDATE_EVENTS.structure, { detail: { projectId: event.projectId } }));
    if (event.type === 'team.session.updated') {
      target.dispatchEvent(new CustomEvent('mingle:team-session-updated', { detail: { projectId: event.projectId } }));
    }
  } else if (event.type === 'team.chat.updated') {
    target.dispatchEvent(new CustomEvent(UPDATE_EVENTS.chat, { detail: { projectId: event.projectId } }));
  }
}

/** Subscribe to project-scoped team updates, coalescing event bursts into one refresh. */
export function subscribeToTeamUpdates(
  projectId: string,
  onUpdate: () => void,
  options: { kinds?: readonly TeamLiveUpdateKind[]; target?: EventTarget; debounceMs?: number } = {},
): () => void {
  const target = options.target ?? window;
  const kinds = options.kinds ?? ['structure', 'chat'];
  const delay = options.debounceMs ?? 80;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ projectId?: string | null }>).detail;
    if (detail?.projectId !== projectId) return;
    // A continuous stream must not postpone refresh forever. Coalesce within
    // a bounded window starting with the first relevant event.
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onUpdate();
    }, delay);
  };
  for (const kind of kinds) target.addEventListener(UPDATE_EVENTS[kind], listener);
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const kind of kinds) target.removeEventListener(UPDATE_EVENTS[kind], listener);
  };
}
