import type { GroupSnapshot } from '@mingle/contracts';
import { useMingle } from '../store/store';
import { api, errorMessage } from './api';

async function settle(action: () => Promise<GroupSnapshot>): Promise<boolean> {
  const store = useMingle.getState();
  try {
    store.applyGroup(await action());
    void store.refreshNow();
    return true;
  } catch (cause) {
    store.toast('error', errorMessage(cause));
    void store.refreshNow();
    return false;
  }
}

async function groupAction(id: string, action: () => Promise<GroupSnapshot>): Promise<boolean> {
  const store = useMingle.getState();
  if (store.groupActionBusyId) {
    store.toast('info', 'A group action is already in progress.');
    return false;
  }
  store.setGroupActionBusy(id);
  try { return await settle(action); }
  finally {
    if (useMingle.getState().groupActionBusyId === id) useMingle.getState().setGroupActionBusy(null);
  }
}

export const pauseGroup = (id: string): Promise<boolean> => groupAction(id, () => api.pauseGroup(id));
export const resumeGroup = (id: string): Promise<boolean> => groupAction(id, () => api.resumeGroup(id));
export const interruptMember = (groupId: string, memberId: string): Promise<boolean> => settle(() => api.interruptGroupMember(groupId, memberId));
export const removeMember = (groupId: string, memberId: string): Promise<boolean> => settle(() => api.removeGroupMember(groupId, memberId));

/** The server pauses dispatch and interrupts all members atomically. Queued work needs explicit Resume. */
export async function stopGroup(snapshot: GroupSnapshot): Promise<void> {
  if (await groupAction(snapshot.group.id, () => api.stopGroup(snapshot.group.id))) {
    useMingle.getState().toast('info', 'Active runs interrupted; queued group work is paused. Resume explicitly to continue.');
  }
}
export const resumeMember = (groupId: string, memberId: string): Promise<boolean> => settle(() => api.resumeGroupMember(groupId, memberId));
