export function contextPopoverPosition(anchor: { left: number; right: number; top: number; bottom: number }, viewport: { width: number; height: number; left?: number; top?: number }, height: number) {
  const inset = 12, gap = 8, leftEdge = (viewport.left ?? 0) + inset, topEdge = (viewport.top ?? 0) + inset;
  const width = Math.max(1, Math.min(288, viewport.width - inset * 2));
  const maxHeight = Math.max(1, viewport.height - inset * 2);
  const measuredHeight = Math.min(height, maxHeight);
  const above = anchor.top - gap - measuredHeight;
  return { width, maxHeight, left: Math.max(leftEdge, Math.min(anchor.right - width, leftEdge + viewport.width - inset * 2 - width)),
    top: Math.max(topEdge, Math.min(above >= topEdge ? above : anchor.bottom + gap, topEdge + viewport.height - inset * 2 - measuredHeight)) };
}
