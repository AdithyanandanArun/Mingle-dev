import { memo } from 'react';
import { Loader2 } from 'lucide-react';
import { HISTORY_OPEN_LIMIT, type SessionHistory } from '../lib/sessionHistory';
import { Button } from './ui';

/**
 * Top of a long conversation: the person decides when older messages load. The button keeps focus while a page
 * loads (it is aria-disabled, not disabled) and doubles as Retry after a failure.
 */
export const SessionHistoryControl = memo(function SessionHistoryControl({ history, onLoad }: { history: SessionHistory; onLoad: () => void }) {
  const loading = history.phase === 'loading';
  const failed = history.phase === 'error';
  if (!history.hasMore) {
    return history.older.length > 0 ? <p className="history-note" role="status" data-history="start">Start of conversation</p> : null;
  }
  if (history.older.length >= HISTORY_OPEN_LIMIT) {
    return <p className="history-note" role="status" data-history="limit">{history.notice ? `${history.notice} ` : ''}{`Showing ${HISTORY_OPEN_LIMIT.toLocaleString()} earlier messages, the most this view keeps. Reopening resets the cache so you can load older messages again.`}</p>;
  }
  return (
    <div className="history-control" data-history={loading ? 'loading' : failed ? 'error' : 'ready'}>
      {history.notice ? <p className="history-note" role="status">{history.notice}</p> : null}
      {failed ? <p className="history-note history-note--error" role="alert">{`Could not load older messages: ${history.error ?? 'unknown error'}`}</p> : null}
      <Button size="sm" variant="secondary" aria-disabled={loading || undefined} aria-busy={loading || undefined} onClick={() => { if (!loading) onLoad(); }}>
        {loading ? <><Loader2 className="spin" size={13} aria-hidden="true" /> Loading older messages…</> : failed ? 'Retry' : history.older.length > 0 ? 'Load more' : 'Load older messages'}
      </Button>
      {loading ? <span className="sr-only" role="status">Loading older messages</span> : null}
    </div>
  );
});
