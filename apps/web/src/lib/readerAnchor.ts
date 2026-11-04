/**
 * Keeps a reader on the same content when rows are inserted above the viewport.
 * The anchor is the first transcript row that is at least partly visible; its distance from the top of the
 * scroll container is restored after the insertion, whatever the browser's own scroll anchoring already did.
 */
export interface ReaderAnchor { node: HTMLElement; top: number }

/** Direct children of the transcript column that are rows (history controls and notes are not). */
function rowsOf(scroller: HTMLElement): HTMLElement[] {
  const column = scroller.querySelector<HTMLElement>('.chat__inner');
  return column ? [...column.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.hasAttribute('data-history') && !child.classList.contains('history-control')) : [];
}

export function captureReaderAnchor(scroller: HTMLElement | null): ReaderAnchor | null {
  if (!scroller) return null;
  const rows = rowsOf(scroller);
  const viewTop = scroller.getBoundingClientRect().top;
  // Rows are in document order, so the first one ending below the top edge is found by bisection.
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid]!.getBoundingClientRect().bottom > viewTop + 1) high = mid; else low = mid + 1;
  }
  const node = rows[low];
  return node ? { node, top: node.getBoundingClientRect().top - viewTop } : null;
}

/** Returns how far the container was scrolled to restore the anchor (0 when it had not moved). */
export function restoreReaderAnchor(scroller: HTMLElement, anchor: ReaderAnchor): number {
  if (!anchor.node.isConnected) return 0;
  const top = anchor.node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const delta = top - anchor.top;
  if (Math.abs(delta) < 0.5) return 0;
  scroller.scrollTop += delta;
  return delta;
}
