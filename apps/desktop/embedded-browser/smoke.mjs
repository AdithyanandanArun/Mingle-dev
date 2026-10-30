import { app, BrowserWindow, WebContentsView, ipcMain, session } from 'electron';
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
  // Stands in for Mingle's main window: background tabs are parked beneath its own content, exactly as in the app.
  const appWindow = new BrowserWindow({ width: 900, height: 700, show: true });
  await appWindow.loadURL('data:text/html,<body style="background:%23111;color:%23eee;font:24px sans-serif">Mingle smoke window</body>');
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
  await identification.send('Target.getTargetInfo');
  await identification.detach();
  const markup = '<input id="input"><button id="button" onclick="document.querySelector(\'#out\').textContent=document.querySelector(\'#input\').value">Write</button><div id="out"></div>';
  await page.goto(`data:text/html,${encodeURIComponent(markup)}`);
  await page.fill('#input', 'mingle-smoke');
  await page.click('#button');
  const value = await page.locator('#out').textContent();
  if (value !== 'mingle-smoke') throw new Error(`Unexpected page value: ${value}`);
  await new Promise(resolve => setTimeout(resolve, 50));
  if (humanInputs.length) throw new Error('Agent-generated page input claimed human control');
  const native = [...host.getSession('smoke').views.values()].find(item => item.url() === page.url());
  if (!native) throw new Error('Native page was not found');
  native.webContentsView.webContents.focus();
  native.webContentsView.webContents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
  native.webContentsView.webContents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
  const inputDeadline = Date.now() + 3000;
  while (!humanInputs.length && Date.now() < inputDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (!humanInputs.some(event => event.kind === 'pointer')) throw new Error('Native input did not reach the authenticated event stream');
  const screenshot = await page.screenshot();
  if (!screenshot.length) throw new Error('Screenshot was empty');
  const aria = await page.locator('body').ariaSnapshot();
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
  await page.close();
  const summary = { value, screenshotBytes: screenshot.length, ariaSnapshot: aria, screencastFrames: frames, cookieRoundTrip: true, independentCdpSessions: true, nativeInputAttribution: true };
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
