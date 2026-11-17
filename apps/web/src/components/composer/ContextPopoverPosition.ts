export function contextPopoverPosition(anchor: { left: number; right: number; top: number; bottom: number }, viewport: { width: number; height: number; left?: number; top?: number }, height: number) {
  const gap = 8;
  const insetX = Math.min(12, Math.max(0, (viewport.width - 1) / 2));
  const insetY = Math.min(12, Math.max(0, (viewport.height - 1) / 2));
  const leftEdge = (viewport.left ?? 0) + insetX;
  const topEdge = (viewport.top ?? 0) + insetY;
  const width = Math.max(1, Math.min(288, viewport.width - insetX * 2));
  const maxHeight = Math.max(1, viewport.height - insetY * 2);
  const measuredHeight = Math.min(height, maxHeight);
  const above = anchor.top - gap - measuredHeight;
  return { width, maxHeight, left: Math.max(leftEdge, Math.min(anchor.right - width, leftEdge + viewport.width - insetX * 2 - width)),
    top: Math.max(topEdge, Math.min(above >= topEdge ? above : anchor.bottom + gap, topEdge + viewport.height - insetY * 2 - measuredHeight)) };
}
