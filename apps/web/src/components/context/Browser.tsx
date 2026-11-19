import { Globe } from 'lucide-react';
import { useActiveGroup, useActiveSession, useMingle } from '../../store/store';
import { useBrowserStore } from '../../store/browser';
import { EmptyState } from '../ui';
import { BrowserPane } from '../browser/BrowserPane';

/** The shared browser of the active session. It polls and streams only while this tab is on screen. */
export function Browser({ active }: { active: boolean }) {
  const conversation = useActiveSession();
  const group = useActiveGroup();
  const viewerId = useBrowserStore((s) => conversation ? s.viewerSessions[conversation.id] : undefined);
  const member = useMingle((s) => viewerId ? s.boot?.sessions.find((session) => session.id === viewerId) : undefined);
  const isMember = member && group?.members.some((row) => row.sessionId === member.id && !row.removedAt);
  const session = isMember ? member : conversation;
  if (!session) return <EmptyState icon={<Globe size={20} />} title="No session selected">Select a session to see and share its browser.</EmptyState>;
  return <BrowserPane key={session.id} session={session} active={active} />;
}
