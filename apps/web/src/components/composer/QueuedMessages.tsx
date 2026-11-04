import { useEffect, useRef, useState } from 'react';
import type { QueuedMessage } from '@mingle/contracts';
import { ApiError, api, errorMessage } from '../../lib/api';
import { useMingle } from '../../store/store';
import { Button, IconButton } from '../ui';

interface QueuedMessagesProps {
  sessionId: string;
  items: QueuedMessage[];
  active?: boolean;
}

export function QueuedMessages({ sessionId, items, active = false }: QueuedMessagesProps) {
  const refresh = useMingle((state) => state.refreshNow);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<{ id: string; latest: string } | null>(null);
  const originalContent = useRef<string | null>(null);
  const inFlight = useRef(false);
  const actionGeneration = useRef(0);
  const mountedSession = useRef(sessionId);
  mountedSession.current = sessionId;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    actionGeneration.current++;
    setEditing(null);
    setText('');
    setBusy(null);
    setError('');
    setConflict(null);
    originalContent.current = null;
    inFlight.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (!editing || items.some((item) => item.id === editing)) return;
    setEditing(null);
    setText('');
    originalContent.current = null;
    setConflict(null);
    setError('This queued message was removed while you were editing.');
  }, [editing, items]);

  const act = async (id: string, action: () => Promise<unknown>, after?: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const targetSession = sessionId;
    const generation = actionGeneration.current;
    setBusy(id);
    setError('');

    try {
      await action();
      if (!alive.current || mountedSession.current !== targetSession || actionGeneration.current !== generation) return;
      after?.();
      await refresh();
    } catch (cause) {
      if (!alive.current || mountedSession.current !== targetSession || actionGeneration.current !== generation) return;
      setError(errorMessage(cause));
      if (!(cause instanceof ApiError) || cause.status !== 409 || editing !== id) return;

      try {
        await refresh();
        const latest = useMingle.getState().boot?.queuedMessages?.find((item) => item.id === id)?.content
          ?? items.find((item) => item.id === id)?.content;
        if (latest !== undefined && alive.current && mountedSession.current === targetSession) {
          setConflict({ id, latest });
        }
      } catch {
        // Keep the edit visible if refreshing the current queued record also fails.
      }
    } finally {
      if (actionGeneration.current === generation) {
        inFlight.current = false;
        if (alive.current && mountedSession.current === targetSession) setBusy(null);
      }
    }
  };

  const beginEdit = (item: QueuedMessage) => {
    originalContent.current = item.content;
    setText(item.content);
    setEditing(item.id);
    setError('');
    setConflict(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setText('');
    originalContent.current = null;
    setConflict(null);
  };

  if (!items.length) return null;

  return (
    <section aria-label="Queued messages" className="queued-messages">
      <h3>Queued messages · always sent next</h3>
      <p className="queued-messages__note">These messages do not steer the current response. Edit or remove them before they are sent.</p>
      {items.map((item) => {
        const isEditing = editing === item.id;
        const isBusy = busy === item.id;
        return (
          <article key={item.id} className="queued-message">
            <span className="queued-message__state">
              Queued · sends after the current run{item.memory === 'exclude' ? ' · Project memory excluded for this turn' : ''}
            </span>
            {isEditing ? (
              <textarea aria-label="Edit queued message" value={text} maxLength={100_000} disabled={isBusy} onChange={(event) => setText(event.target.value)} />
            ) : (
              <p title={item.content}>
                {item.content || 'Attachment message'}
                {item.attachmentIds.length > 0 && <small>{item.attachmentIds.length} attachments</small>}
                {item.skills.length > 0 && <small>{item.skills.length} skills retained</small>}
                {item.contextRefs.length > 0 && <small>{item.contextRefs.length} context references retained</small>}
              </p>
            )}
            {isEditing ? (
              <>
                <Button
                  disabled={Boolean(busy) || !text.trim()}
                  onClick={() => void act(
                    item.id,
                    () => api.editQueuedMessage(sessionId, item.id, text, originalContent.current ?? item.content),
                    () => { setEditing(null); originalContent.current = null; setConflict(null); },
                  )}
                >{isBusy ? 'Saving…' : 'Save'}</Button>
                <Button variant="secondary" disabled={Boolean(busy)} onClick={cancelEdit}>Cancel</Button>
                {conflict?.id === item.id ? (
                  <div className="queued-message__conflict" role="status">
                    <strong>Latest queued text from the server</strong>
                    <p>{conflict.latest}</p>
                    <Button variant="secondary" disabled={Boolean(busy)} onClick={() => setText(conflict.latest)}>Use latest text</Button>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <Button
                  disabled={Boolean(busy)}
                  title={active ? 'Interrupt the active run after cleanup, then send this queued message' : 'Send this queued message now'}
                  onClick={() => void act(item.id, () => api.sendQueuedNow(sessionId, item.id))}
                >{active ? 'Interrupt and send' : 'Send now'}</Button>
                <IconButton label="Edit queued message" title="Edit" disabled={Boolean(busy)} onClick={() => beginEdit(item)}>✎</IconButton>
                <IconButton label="Remove queued message" title="Remove" disabled={Boolean(busy)} onClick={() => void act(item.id, () => api.removeQueuedMessage(sessionId, item.id))}>×</IconButton>
              </>
            )}
          </article>
        );
      })}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
