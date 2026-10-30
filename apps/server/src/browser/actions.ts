import type { BrowserAction } from '@mingle/contracts';
import { BrowserError, withTimeout } from './errors.ts';
import { evaluateExpression } from './evaluate.ts';
import { ACTION_TIMEOUT_MS } from './limits.ts';
import type { TabEntry } from './tab.ts';
import { hasTarget, resolveLocator } from './target.ts';
import { normalizeNavigationUrl } from './url-policy.ts';

// Functions passed to page.evaluate are serialised with toString(). They must not contain named inner functions or
// helper consts, because tsx's keepNames transform would inject helper calls that do not exist in the page.

/** Refreshes the cached viewport size from the page (existing-browser tabs have no fixed Playwright viewport). */
export async function refreshViewport(entry: TabEntry): Promise<void> {
  const fixed = entry.page.viewportSize();
  if (fixed) return void entry.setViewport(fixed.width, fixed.height);
  const live = await withTimeout(
    entry.page.evaluate(() => {
      const scope = globalThis as unknown as { innerWidth: number; innerHeight: number };
      return { width: scope.innerWidth, height: scope.innerHeight };
    }),
    2000,
    'Reading the viewport timed out.',
  ).catch(() => null);
  if (live) entry.setViewport(live.width, live.height);
}

async function ensureInViewport(entry: TabEntry, x: number, y: number): Promise<void> {
  const inside = () => x <= entry.viewport.width + 1 && y <= entry.viewport.height + 1;
  if (inside()) return;
  await refreshViewport(entry);
  if (!inside()) throw new BrowserError(400, `The point (${Math.round(x)}, ${Math.round(y)}) is outside the ${entry.viewport.width}x${entry.viewport.height} viewport.`);
}

const done = { ok: true } as const;

async function pageTitle(entry: TabEntry): Promise<string> {
  return withTimeout(entry.page.title(), 2000, 'Reading the title timed out.').catch(() => entry.title);
}

async function perform(entry: TabEntry, action: BrowserAction): Promise<unknown> {
  const { page } = entry;
  const timeout = ACTION_TIMEOUT_MS;
  switch (action.type) {
    case 'navigate': {
      const response = await page.goto(normalizeNavigationUrl(action.url), { timeout, waitUntil: 'domcontentloaded' });
      return { url: page.url(), title: await pageTitle(entry), status: response?.status() ?? null };
    }
    case 'back':
    case 'forward':
    case 'reload': {
      const response = await (action.type === 'back' ? page.goBack : action.type === 'forward' ? page.goForward : page.reload).call(page, { timeout, waitUntil: 'domcontentloaded' });
      return { url: page.url(), title: await pageTitle(entry), navigated: action.type === 'reload' || response !== null };
    }
    case 'close':
      await page.close({ runBeforeUnload: false });
      return { closed: true };
    case 'click': {
      if (hasTarget(action)) {
        if (action.x !== undefined || action.y !== undefined) throw new BrowserError(400, 'Click either a target or x/y coordinates, not both.');
        await (await resolveLocator(entry, action)).click({ timeout, ...(action.button ? { button: action.button } : {}) });
        return done;
      }
      if (action.x === undefined || action.y === undefined) throw new BrowserError(400, 'Click needs a target or both x and y.');
      await ensureInViewport(entry, action.x, action.y);
      await page.mouse.click(action.x, action.y, action.button ? { button: action.button } : undefined);
      return done;
    }
    case 'hover':
      await (await resolveLocator(entry, action)).hover({ timeout });
      return done;
    case 'type': {
      if (!hasTarget(action)) throw new BrowserError(400, 'Typing needs a target field. Use the text action to insert text where the focus already is.');
      const locator = await resolveLocator(entry, action);
      if (action.clear) await locator.fill(action.text, { timeout });
      else await locator.pressSequentially(action.text, { timeout });
      return done;
    }
    case 'select':
      await (await resolveLocator(entry, action)).selectOption(action.values, { timeout });
      return done;
    case 'press':
      await page.keyboard.press(action.key);
      return done;
    case 'text':
      await page.keyboard.insertText(action.text);
      return done;
    case 'scroll': {
      const x = action.x ?? entry.viewport.width / 2;
      const y = action.y ?? entry.viewport.height / 2;
      await ensureInViewport(entry, x, y);
      await page.mouse.move(x, y);
      await page.mouse.wheel(action.deltaX ?? 0, action.deltaY);
      return done;
    }
    case 'pointer': {
      await ensureInViewport(entry, action.x, action.y);
      const button = action.button ?? 'left';
      if (action.phase === 'move') await page.mouse.move(action.x, action.y);
      else if (action.phase === 'down') { await page.mouse.move(action.x, action.y); entry.pressed.add(button); entry.control.pointer('down'); await page.mouse.down({ button }); }
      else { await page.mouse.move(action.x, action.y); await page.mouse.up({ button }); entry.pressed.delete(button); entry.control.pointer('up'); }
      return done;
    }
    case 'resize':
      await page.setViewportSize({ width: action.width, height: action.height });
      entry.setViewport(action.width, action.height);
      return done;
    case 'wait': {
      const wait = action.timeoutMs ?? timeout;
      if (!hasTarget(action) && !action.text) {
        await new Promise((resolve) => setTimeout(resolve, action.timeoutMs ?? 1000));
        return done;
      }
      if (hasTarget(action)) await (await resolveLocator(entry, action)).waitFor({ state: 'visible', timeout: wait });
      if (action.text) await page.getByText(action.text).first().waitFor({ state: 'visible', timeout: wait });
      return done;
    }
    case 'evaluate': {
      // Runs in the page's JavaScript context only (CDP Runtime.evaluate); there is no access to Node or to Mingle.
      const out = await evaluateExpression(entry, action.expression);
      return { result: out.result, truncated: out.truncated };
    }
    case 'dialog': {
      const open = entry.dialog;
      if (!open) throw new BrowserError(409, 'No JavaScript dialog is open on this tab.');
      try {
        if (action.accept) await open.handle.accept(action.promptText);
        else await open.handle.dismiss();
      } catch {
        // The dialog was already closed natively; clearing our record is the correct outcome either way.
      }
      entry.setDialog(null);
      // An action the dialog interrupted resumes now; let it land before this write counts as finished.
      await entry.settleBegun(ACTION_TIMEOUT_MS);
      return done;
    }
  }
}

/**
 * Runs one write action. Every action is bounded to ~10s. If an action causes a JavaScript dialog the call returns
 * as soon as it appears (reporting the dialog) instead of hanging behind it; accept or dismiss it with a dialog action.
 */
export async function runAction(entry: TabEntry, action: BrowserAction, actor?: { kind: 'agent' | 'human'; id: string }): Promise<unknown> {
  if (actor?.kind === 'agent') {
    let point: { x: number; y: number } | null = null;
    const targeted = (action.type === 'click' || action.type === 'hover' || action.type === 'type' || action.type === 'select') && hasTarget(action);
    if (action.type === 'click' && action.x !== undefined && action.y !== undefined) point = { x: action.x, y: action.y };
    else if (action.type === 'scroll') point = { x: action.x ?? entry.viewport.width / 2, y: action.y ?? entry.viewport.height / 2 };
    else if (targeted) {
      const locator = await resolveLocator(entry, action).catch(() => null);
      const box = locator ? await withTimeout(locator.boundingBox(), 500, 'Reading target bounds timed out.').catch(() => null) : null;
      if (box) point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    if (point) {
      const kind = action.type === 'click' ? 'click' : action.type === 'type' ? 'type' : action.type === 'scroll' ? 'scroll' : 'move';
      entry.agentPointer = { ...point, kind, at: Date.now() };
      entry.touch();
    }
  }
  if (entry.dialog && action.type !== 'dialog' && action.type !== 'close') {
    throw new BrowserError(409, `A JavaScript ${entry.dialog.type} dialog is open ("${entry.dialog.message.slice(0, 200)}"). Accept or dismiss it with the dialog action first.`);
  }
  const work = withTimeout(perform(entry, action), ACTION_TIMEOUT_MS + 2000, 'The browser did not finish the action in time.');
  if (action.type === 'dialog' || action.type === 'close') return work;
  const watch = entry.watchDialog();
  try {
    const outcome = await Promise.race([work, watch.opened]);
    if (outcome !== true) return outcome;
    // The action had already begun and is parked behind the dialog; it cannot be cancelled and finishes when the dialog is answered.
    entry.begun = work.then(() => undefined, () => undefined);
    const open = entry.dialog;
    return {
      ok: true, pending: true,
      ...(open ? { dialog: { type: open.type, message: open.message } } : {}),
      note: 'The action had already begun and will finish once the dialog is accepted or dismissed.',
    };
  } finally {
    watch.cancel();
  }
}
