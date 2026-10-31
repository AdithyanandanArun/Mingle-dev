import { app, BrowserWindow, WebContentsView, ipcMain, session } from 'electron';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createEmbeddedBrowserHost } from './host.mjs';

const desktopDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(desktopDir, '../../../');
const serverPackage = resolve(repoRoot, 'apps/server/package.json');
const requireServer = createRequire(serverPackage);
let host;
let browser;
let inputAbort;

async function run() {
  await app.whenReady();
  // Stands in for the workspace window: like main.mjs, its UI runs in an opaque child view, and background tabs are
  // parked beneath that view (hidden, still rendering). They must never sit above the UI.
  const appWindow = new BrowserWindow({ width: 900, height: 700, show: true });
  const uiView = new WebContentsView();
  uiView.setBackgroundColor('#111111');
  appWindow.contentView.addChildView(uiView);
  const [uiWidth, uiHeight] = appWindow.getContentSize();
  uiView.setBounds({ x: 0, y: 0, width: uiWidth, height: uiHeight });
  appWindow.mingleUi = uiView;
  await uiView.webContents.loadURL('data:text/html,<body style="background:%23111;color:%23eee;font:24px sans-serif">Mingle smoke window</body>');
  host = createEmbeddedBrowserHost({ electron: { app, BrowserWindow, WebContentsView, ipcMain, session }, ws: requireServer('ws'), getHostWindow: () => appWindow });
  const base = await host.ready;
  const response = await fetch(`${base}/sessions/smoke/browser`, { method: 'POST', headers: { authorization: `Bearer ${host.token}` } });
  if (!response.ok) throw new Error(`Session create failed: HTTP ${response.status}`);
  const { wsUrl } = await response.json();
  inputAbort = new AbortController();
  const events = await fetch(`${base}/sessions/smoke/browser/events`, { headers: { authorization: `Bearer ${host.token}` }, signal: inputAbort.signal });
  const reader = events.body.getReader();
  const humanInputs = [];
  const inputReading = (async () => {
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += new TextDecoder().decode(value);
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (block.startsWith('data: ')) humanInputs.push(JSON.parse(block.slice(6)));
      }
    }
  })().catch(error => { if (!inputAbort.signal.aborted) throw error; });
  const { chromium } = requireServer('playwright');
  browser = await chromium.connectOverCDP(wsUrl, { headers: { Authorization: `Bearer ${host.token}` } });
  const context = browser.contexts()[0];
  await context.addCookies([{ name: 'a', value: 'b', url: 'https://example.com' }, { name: '__Host-mingle-test', value: 'fixture', url: 'https://example.com/', secure: true }]);
  const cookies = await context.cookies('https://example.com');
  if (!cookies.some(cookie => cookie.name === 'a' && cookie.value === 'b')) throw new Error('Cookie round-trip failed');
  if (!cookies.some(cookie => cookie.name === '__Host-mingle-test' && cookie.value === 'fixture' && cookie.domain === 'example.com' && cookie.secure)) throw new Error('Host-only prefixed cookie round-trip failed');
  const page = await context.newPage();
  // BrowserSessionRuntime briefly attaches a CDP session to identify the tab. Detaching that
  // session must leave the page's main Playwright session alive.
  const identification = await context.newCDPSession(page);
  const info = await identification.send('Target.getTargetInfo');
  await identification.detach();
  const native = host.getSession('smoke').views.get(info.targetInfo.targetId);
  assert.ok(native, 'Native page exists');
  const stackIndex = view => appWindow.contentView.children.indexOf(view);
  const assertParked = (item, label) => {
    assert.equal(item.webContentsView.parentWindow, appWindow, `${label}: parked in the workspace window`);
    assert.ok(stackIndex(item.webContentsView) >= 0, `${label}: is a child of the workspace window`);
    assert.ok(stackIndex(item.webContentsView) < stackIndex(uiView), `${label}: sits beneath the UI view, so it cannot cover the interface`);
    assert.deepEqual(item.webContentsView.getBounds(), { x: 0, y: 0, width: 1280, height: 800 });
  };
  assertParked(native, 'new agent tab');
  const background = await context.newPage();
  await background.goto('data:text/html,<title>Example background tab</title><p>Background page</p>');
  const other = [...host.getSession('smoke').views.values()].find(item => item.url() === background.url());
  assert.ok(other, 'A second native tab exists');
  assertParked(other, 'second tab');
  const backgroundScreenshot = await background.screenshot();
  assert.ok(backgroundScreenshot.length, 'Parked tabs still produce screenshots');
  const markup = '<input id="input"><button id="button" onclick="document.querySelector(\'#out\').textContent=document.querySelector(\'#input\').value">Write</button><div id="out"></div>';
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await page.fill('#input', 'mingle-smoke');
  await page.click('#button');
  const value = await page.locator('#out').textContent();
  if (value !== 'mingle-smoke') throw new Error(`Unexpected page value: ${value}`);
  await new Promise(resolve => setTimeout(resolve, 50));
  if (humanInputs.length) throw new Error('Agent-generated page input claimed human control');
  assert.equal(host.setPresented('smoke', native.targetId, appWindow, native.webContentsView, { x: 100, y: 120, width: 700, height: 450 }), true);
  assert.deepEqual(native.webContentsView.getBounds(), { x: 100, y: 120, width: 700, height: 450 });
  assert.ok(stackIndex(native.webContentsView) > stackIndex(uiView), 'The presented tab is drawn above the UI, inside its pane');
  assertParked(other, 'background tab while another is presented');
  appWindow.focus();
  native.webContentsView.webContents.focus();
  native.webContentsView.webContents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
  native.webContentsView.webContents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
  const inputDeadline = Date.now() + 3000;
  while (!humanInputs.length && Date.now() < inputDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (!humanInputs.some(event => event.kind === 'pointer')) throw new Error('Native input did not reach the authenticated event stream');
  for (let index = 0; index < 3; index++) {
    host.park(native.webContentsView);
    assertParked(native, `repeated hide ${index}`);
    assert.equal(host.setPresented('smoke', native.targetId, appWindow, native.webContentsView, { x: 100, y: 120, width: 700, height: 450 }), true);
  }
  host.park(native.webContentsView);
  assertParked(native, 'hidden before screenshot and screencast');
  const screenshot = await page.screenshot();
  if (!screenshot.length) throw new Error('Screenshot was empty');
  const aria = await page.locator('body').ariaSnapshot();
  // Parked tabs keep rendering beneath the UI, so the stream works whether or not the tab is shown.
  assert.equal(host.setPresented('smoke', native.targetId, appWindow, native.webContentsView, { x: 100, y: 120, width: 700, height: 450 }), true);
  const cdp = await context.newCDPSession(page);
  let frames = 0;
  const framePromise = new Promise((resolveFrame, reject) => {
    const timer = setTimeout(() => reject(new Error('No screencast frame within 5 seconds')), 5000);
    cdp.on('Page.screencastFrame', async event => {
      frames++;
      await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
      clearTimeout(timer); resolveFrame();
    });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, everyNthFrame: 1 });
  await framePromise;
  await cdp.send('Page.stopScreencast');
  host.park(native.webContentsView);
  await background.close();
  await page.close();
  assert.deepEqual(appWindow.contentView.children, [uiView], 'Closing tabs leaves only the workspace UI');
  const summary = { value, screenshotBytes: screenshot.length, ariaSnapshot: aria, screencastFrames: frames, cookieRoundTrip: true, independentCdpSessions: true, nativeInputAttribution: true, parkedBeneathUi: true, repeatedPresentation: true, backgroundScreenshotBytes: backgroundScreenshot.length };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  inputAbort.abort();
  await inputReading;
  await browser.close(); browser = null;
  await host.dispose(); host = null;
  app.quit();
}

run().catch(async error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  inputAbort?.abort();
  try { await browser?.close(); } catch {}
  try { await host?.dispose(); } catch {}
  app.exit(1);
});
