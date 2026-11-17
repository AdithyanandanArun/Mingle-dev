import { expect, it } from 'vitest';
import { contextPopoverPosition } from './ContextPopoverPosition';
it('keeps context details in narrow and offset visual viewports', () => {
  const anchor = { left: 355, right: 383, top: 800, bottom: 828 };
  const narrow = contextPopoverPosition(anchor, { width: 390, height: 844 }, 210);
  expect(narrow.left).toBeGreaterThanOrEqual(12); expect(narrow.left + narrow.width).toBeLessThanOrEqual(378);
  expect(narrow.top).toBeLessThan(anchor.top);
  const offset = contextPopoverPosition({ ...anchor, top: 30, bottom: 58 }, { width: 390, height: 400, top: 100, left: 25 }, 800);
  expect(offset.top).toBeGreaterThanOrEqual(112); expect(offset.maxHeight).toBe(376);
  expect(offset.left).toBeGreaterThanOrEqual(37);
});

it('shrinks the gutters when the visual viewport is smaller than the usual padding', () => {
  const position = contextPopoverPosition({ left: 1, right: 6, top: 1, bottom: 6 }, { width: 18, height: 20, left: 40, top: 50 }, 200);
  expect(position.left + position.width).toBeLessThanOrEqual(58);
  expect(position.top + position.maxHeight).toBeLessThanOrEqual(70);
});
