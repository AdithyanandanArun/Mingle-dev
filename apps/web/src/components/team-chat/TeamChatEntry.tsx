import { useCallback, useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import type { ProjectCollaborationSnapshot } from '@mingle/contracts';
import { useProject, useMingle } from '../../store/store';
import { api } from '../../lib/api';
import { TeamChatPanel } from './TeamChatPanel';

/** Shows the project-level chat link only after the server confirms a shared-project binding. */
export function TeamChatEntry() {
  const project = useProject();
  const connection = useMingle((state) => state.connection);
  const openProjectId = useMingle((state) => state.teamChatProjectId);
  const [collaboration, setCollaboration] = useState<ProjectCollaborationSnapshot | null>(null);
  const [checkedProjectId, setCheckedProjectId] = useState<string | null>(null);
  const bindingKnown = project?.id === checkedProjectId && Boolean(collaboration?.project);
  const closeChat = useCallback(() => useMingle.getState().closeTeamChat(), []);

  useEffect(() => {
    if (!project || connection !== 'online') return;
    let active = true;
    const projectId = project.id;
    const refresh = () => void api.projectCollaboration(projectId).then((snapshot) => {
      if (active) { setCollaboration(snapshot); setCheckedProjectId(projectId); }
    }).catch(() => { if (active) setCheckedProjectId(projectId); });
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    let stateTimer: number | undefined;
    const onStateChange = () => {
      if (bindingKnown) return;
      window.clearTimeout(stateTimer);
      stateTimer = window.setTimeout(refresh, 250);
    };
    window.addEventListener('mingle:state-changed', onStateChange);
    return () => { active = false; window.clearInterval(timer); window.clearTimeout(stateTimer); window.removeEventListener('mingle:state-changed', onStateChange); };
  }, [project?.id, connection, openProjectId, bindingKnown]);

  const bound = bindingKnown;
  return <>
    {bound && project ? <button
      type="button" className={`team-chat-nav${openProjectId === project.id ? ' is-active' : ''}`}
      aria-current={openProjectId === project.id ? 'page' : undefined}
      onClick={() => useMingle.getState().openTeamChat(project.id)}
    ><MessageCircle size={14} aria-hidden="true" /><span>Team chat</span><span className="team-chat-nav__count">{collaboration?.members.length ?? 0}</span></button> : null}
    {project && openProjectId === project.id ? <TeamChatPanel projectId={project.id} onClose={closeChat} /> : null}
  </>;
}
