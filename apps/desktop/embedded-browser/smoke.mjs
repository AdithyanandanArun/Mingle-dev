import { app, BrowserWindow, WebContentsView, ipcMain, nativeImage, session } from 'electron';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
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

async function verifySoftNavigation(page) {
  const site = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>Example browser navigation</title>
      <button>Next view</button><main style="font-size:54px">Example start view</main>
      <script>
        let view = 0;
        window.navigationTimes = [];
        new PerformanceObserver(list => {
          navigationTimes.push(...list.getEntries().map(entry => entry.startTime));
        }).observe({type: 'soft-navigation', buffered: true});
        document.querySelector('button').onclick = () => {
          history.pushState({}, '', '/view-' + (++view));
          document.querySelector('main').outerHTML =
            '<main style="font-size:54px">Example new contents for view ' + view + '</main>';
        };
      </script>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${site.address().port}/`);
    const cdp = await page.context().newCDPSession(page);
    try {
      cdp.on('Page.screencastFrame', frame => { void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}); });
      await cdp.send('Page.startScreencast', { format: 'jpeg', maxFramesInFlight: 1, maxWidth: 960, maxHeight: 600 });
      for (let turn = 1; turn <= 2; turn++) {
        await page.locator('button').click({ timeout: 5000 });
        await page.waitForURL(`**/view-${turn}`, { timeout: 5000 });
        await page.waitForFunction(count => navigationTimes.length >= count, turn, { timeout: 5000 });
      }
      const [first, second] = await page.evaluate(() => navigationTimes);
      assert.ok(first > 0 && second > first, 'Soft-navigation timing increases across interactions');
      await cdp.send('Page.stopScreencast');
    } finally {
      await cdp.detach();
    }
  } finally {
    site.close();
  }
}

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
    assert.equal(item.webContentsView.getVisible(), false, `${label}: excluded from workspace hit testing`);
    assert.deepEqual(item.webContentsView.getBounds(), { x: 0, y: 0, width: 1920, height: 1200 });
  };
  assertParked(native, 'new agent tab');
  const background = await context.newPage();
  await background.goto('data:text/html,<title>Example background tab</title><p>Background page</p>');
  const other = [...host.getSession('smoke').views.values()].find(item => item.url() === background.url());
  assert.ok(other, 'A second native tab exists');
  assertParked(other, 'second tab');
  const backgroundScreenshot = await background.screenshot();
  assert.ok(backgroundScreenshot.length, 'Parked tabs still produce screenshots');
  // Floating presentation streams the parked page from beneath the workspace UI.
  const cdp = await context.newCDPSession(page);
  await page.setContent('<title>Example screencast pressure</title><div style="position:fixed;inset:0;animation:pulse 0.2s alternate infinite"></div><style>@keyframes pulse{from{background:red}to{background:blue}}</style>');
  let frames = 0;
  let firstFrame;
  const framePromise = new Promise((resolveFrame, reject) => {
    const timer = setTimeout(() => reject(new Error('No screencast frame within 5 seconds')), 5000);
    cdp.on('Page.screencastFrame', event => {
      frames++;
      if (frames !== 1) return;
      firstFrame = event.sessionId;
      clearTimeout(timer);
      resolveFrame(nativeImage.createFromBuffer(Buffer.from(event.data, 'base64')).getSize());
    });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1, maxFramesInFlight: 1 });
  const screencastSize = await framePromise;
  assert.deepEqual(screencastSize, { width: 1920, height: 1200 }, 'Parked page streams at the higher floating resolution');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(frames, 1, 'An animating page waits for the real viewer to acknowledge the frame');
  const resumed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Screencast did not resume after the viewer acknowledged')), 5000);
    cdp.once('Page.screencastFrame', () => { clearTimeout(timer); resolve(); });
  });
  await cdp.send('Page.screencastFrameAck', { sessionId: firstFrame });
  await resumed;
  await cdp.send('Page.stopScreencast');
  const backingStorage = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).backingStorageSize;
  };
  const beforeConsole = await backingStorage();
  await page.evaluate(() => {
    for (let index = 0; index < 96; index++) {
      console.log('Example console payload', new Uint8Array(128 * 1024).fill(index));
    }
  });
  const consoleDeadline = Date.now() + 2000;
  let retainedConsoleBytes;
  do {
    retainedConsoleBytes = await backingStorage() - beforeConsole;
    if (retainedConsoleBytes < 8 * 1024 * 1024) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < consoleDeadline);
  assert.ok(retainedConsoleBytes < 8 * 1024 * 1024, `Chromium retained ${retainedConsoleBytes} bytes from the example console burst`);
  await cdp.detach();
  process.stdout.write(`Parked screencast: ${screencastSize.width} × ${screencastSize.height}\n`);
  const markup = '<input id="input"><button id="button" onclick="window.lastClickTime=event.timeStamp;document.querySelector(\'#out\').textContent=document.querySelector(\'#input\').value">Write</button><div id="out"></div>';
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await page.fill('#input', 'mingle-smoke');
  await page.click('#button');
  const value = await page.locator('#out').textContent();
  if (value !== 'mingle-smoke') throw new Error(`Unexpected page value: ${value}`);
  assert.ok(await page.evaluate(() => window.lastClickTime > 0), 'Browser control preserves a valid event timestamp');
  await new Promise(resolve => setTimeout(resolve, 50));
  if (humanInputs.length) throw new Error('Agent-generated page input claimed human control');
  assert.equal(host.setPresented('smoke', native.targetId, appWindow, native.webContentsView, { x: 100, y: 120, width: 700, height: 450 }), true);
  assert.deepEqual(native.webContentsView.getBounds(), { x: 100, y: 120, width: 700, height: 450 });
  assert.equal(native.webContentsView.getVisible(), true);
  assert.ok(stackIndex(native.webContentsView) > stackIndex(uiView), 'The presented tab is drawn above the UI, inside its pane');
  assertParked(other, 'background tab while another is presented');
  await page.click('#button');
  await page.press('#input', 'End');
  await page.mouse.wheel(0, 30);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(humanInputs, [], 'Debugger input never claims native control even when the page is presented');
  appWindow.focus();
  native.webContentsView.webContents.focus();
  native.webContentsView.webContents.sendInputEvent({ type: 'mouseWheel', x: 20, y: 20, deltaY: 30 });
  native.webContentsView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
  native.webContentsView.webContents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
  const waitForNativePointer = async phase => {
    const deadline = Date.now() + 3000;
    while (!humanInputs.some(event => event.kind === 'pointer' && event.phase === phase) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(humanInputs.some(event => event.kind === 'pointer' && event.phase === phase), `Native pointer ${phase} reached the authenticated event stream`);
  };
  await waitForNativePointer('down');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(humanInputs.some(event => event.kind === 'wheel'), 'Native scroll reaches the input stream');
  assert.ok(humanInputs.some(event => event.kind === 'key'), 'Native keyboard input reaches the input stream');
  host.park(native.webContentsView);
  await waitForNativePointer('up');
  assert.equal(host.setPresented('smoke', native.targetId, appWindow, native.webContentsView, { x: 100, y: 120, width: 700, height: 450 }), true);
  native.webContentsView.webContents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
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
  await verifySoftNavigation(page);
  host.park(native.webContentsView);
  await background.close();
  await page.close();
  assert.deepEqual(appWindow.contentView.children, [uiView], 'Closing tabs leaves only the workspace UI');
  const summary = { value, screenshotBytes: screenshot.length, ariaSnapshot: aria, screencastFrames: frames, screencastSize, cookieRoundTrip: true, independentCdpSessions: true, nativeInputAttribution: true, parkedBeneathUi: true, repeatedPresentation: true, backgroundScreenshotBytes: backgroundScreenshot.length };
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
