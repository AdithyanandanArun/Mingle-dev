import { Fragment, memo, useCallback, useLayoutEffect, useMemo } from 'react';
import type { Provider, QuoteCitation } from '@mingle/contracts';
import type { DisplayMessage } from '../lib/conversation';
import { useMingle } from '../store/store';
import { overlayStream, type RunBlock, type TranscriptLayout, type TranscriptRow } from '../lib/transcript';
import { InternalDeliveryDisclosure, LegacyToolGroup, MessageRow } from './ConversationParts';
import { appendContextReference } from './MessageContextControls';
import { RunActivity } from './RunActivity';
import { RunChanges } from './RunChanges';
import { SubagentTranscriptLinks } from './subagents/SubagentTranscriptLinks';

const MemoRunActivity = memo(RunActivity);
const MemoRunChanges = memo(RunChanges);
const MemoSubagentLinks = memo(SubagentTranscriptLinks);

/**
 * The one component that follows a live stream buffer: token deltas re-render this row only, never the
 * surrounding history. `tracked` stays a prop (not a different component type) so the row keeps its DOM when
 * the stream finishes.
 */
const StreamAwareMessageRow = memo(function StreamAwareMessageRow({ m, tracked, provider, onAskAboutThis, onGrow }: {
  m: DisplayMessage; tracked: boolean; provider: Provider; onAskAboutThis: (quote: QuoteCitation) => void; onGrow: () => void;
}) {
  const entry = useMingle((state) => tracked ? state.streams[m.id] : undefined);
  const shown = useMemo(() => overlayStream(m, entry), [m, entry]);
  useLayoutEffect(() => { if (tracked) onGrow(); }, [shown.content, tracked, onGrow]);
  return <MessageRow m={shown} provider={provider} onAskAboutThis={onAskAboutThis} />;
});

const RunBlockView = memo(function RunBlockView({ block, onOpenSubagent }: { block: RunBlock; onOpenSubagent: (id: string) => void }) {
  return <>
    <MemoRunActivity run={block.run} initialCalls={block.calls} />
    <MemoSubagentLinks subagents={block.subagents} onOpen={onOpenSubagent} />
  </>;
});

const TranscriptEntry = memo(function TranscriptEntry({ row, provider, onAskAboutThis, onOpenSubagent, onGrow }: {
  row: TranscriptRow; provider: Provider; onAskAboutThis: (quote: QuoteCitation) => void; onOpenSubagent: (id: string) => void; onGrow: () => void;
}) {
  if (row.kind === 'tools') return <LegacyToolGroup messages={row.messages} />;
  if (row.kind === 'delivery') {
    return <>
      <InternalDeliveryDisclosure message={row.message} />
      {row.runs.map((block) => <RunBlockView key={block.run.id} block={block} onOpenSubagent={onOpenSubagent} />)}
    </>;
  }
  return <>
    <StreamAwareMessageRow m={row.message} tracked={row.streamed} provider={provider} onAskAboutThis={onAskAboutThis} onGrow={onGrow} />
    {row.runs.map((block) => <RunBlockView key={block.run.id} block={block} onOpenSubagent={onOpenSubagent} />)}
    {row.changes.map((run) => <MemoRunChanges key={run.id} runId={run.id} summary={run.changes} />)}
  </>;
});

/** Messages, their run activity and change cards, then runs whose user message is not in the transcript. */
export const TranscriptList = memo(function TranscriptList({ layout, sessionId, provider, onOpenSubagent, onGrow }: {
  layout: TranscriptLayout; sessionId: string; provider: Provider; onOpenSubagent: (id: string) => void; onGrow: () => void;
}) {
  const onAskAboutThis = useCallback((quote: QuoteCitation) => appendContextReference(sessionId, quote), [sessionId]);
  return <>
    {layout.rows.map((row) => <TranscriptEntry key={row.key} row={row} provider={provider} onAskAboutThis={onAskAboutThis} onOpenSubagent={onOpenSubagent} onGrow={onGrow} />)}
    {layout.unplaced.map((block) => <Fragment key={block.run.id}>
      <RunBlockView block={block} onOpenSubagent={onOpenSubagent} />
      {block.run.status !== 'running' ? <MemoRunChanges runId={block.run.id} summary={block.run.changes} /> : null}
    </Fragment>)}
  </>;
});
