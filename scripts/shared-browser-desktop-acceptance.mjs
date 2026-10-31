// Native Electron acceptance. Run after building apps/web; uses only disposable local Example data.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.i = 0;
        this.pending = new Map();
        ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
        });
    }
    static async open(url) {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });
        return new Cdp(ws);
    }
    call(method, params = {}) {
        const id = ++this.i;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('CDP timeout ' + method));
            }, 12000);
            this.pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(fn, arg) {
        const response = await this.call('Runtime.evaluate', {
            expression: `(${fn})(${JSON.stringify(arg) ?? ''})`,
            returnByValue: true, awaitPromise: true,
        });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
        return response.result.value;
    }
    close() { this.ws.close(); }
}
async function until(fn, label) {
    for (let i = 0; i < 100; i++) {
        const value = await fn();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out: ' + label);
}
(async () => {
    if (process.platform !== 'linux') throw new Error('This native acceptance harness requires Linux and a graphical session.');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const dir = await mkdtemp(join(tmpdir(), 'mingle-browser-native-acceptance-'));
    const checks = [];
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), MINGLE_DATA_DIR: join(dir, 'runtime') };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const site = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>Example browser acceptance</title><body style="font:20px sans-serif;padding:24px;background:#eee;color:#222"><h1>Example browser acceptance</h1><label>Name <input id="name"></label><button onclick="document.querySelector(\'#out\').textContent=document.querySelector(\'#name\').value">Apply</button><p id="out"></p><a href="/next">Next page</a></body>'); });
    await new Promise(r => site.listen(0, '127.0.0.1', r));
    const siteUrl = `http://127.0.0.1:${site.address().port}`;
    const probe = createServer();
    await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const debugPort = probe.address().port;
    await new Promise(r => probe.close(r));
    const child = spawn(join(root, 'apps/desktop/node_modules/electron/dist/electron'), ['--remote-debugging-port=' + debugPort, join(root, 'apps/desktop')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let main, guest;
    let stdout = '';
    child.stdout.on('data', x => stdout = (stdout + x).slice(-4000));
    child.stderr.on('data', () => { });
    try {
        const targets = async () => fetch(`http://127.0.0.1:${debugPort}/json`).then(r => r.json());
        const target = await until(async () => { try {
            return (await targets()).find(t => t.url.startsWith('http://127.0.0.1:'));
        }
        catch {
            return false;
        } }, 'workspace');
        const origin = new URL(target.url).origin;
        main = await Cdp.open(target.webSocketDebuggerUrl);
        const api = async (path, method = 'GET', body) => { const r = await fetch(origin + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) }); const b = await r.json(); if (!r.ok)
            throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(b)}`); return b; };
        const boot = await api('/api/bootstrap');
        const sid = boot.sessions[0].id;
        assert.equal(boot.settings.browserDefaultMode, 'embedded');
        const automaticBase = `/api/sessions/${boot.sessions[1].id}/browser`;
        await api(automaticBase + '/tabs', 'POST', {});
        assert.equal((await api(automaticBase)).mode, 'embedded');
        await api(automaticBase + '/disconnect', 'POST', {});
        checks.push('automatic tab opening honors the desktop default');
        await api('/api/settings', 'PATCH', { onboardingCompletedVersion: 1 });
        await main.call('Page.navigate', { url: `${origin}/?browserPopout=${sid}` });
        const click = async (name) => { await until(() => main.eval(n => [...document.querySelectorAll('button')].some(b => !b.disabled && (b.getAttribute('aria-label') === n || b.textContent.trim() === n)), name), name); return main.eval(n => { [...document.querySelectorAll('button')].find(b => !b.disabled && (b.getAttribute('aria-label') === n || b.textContent.trim() === n)).click(); }, name); };
        await click('Use built-in browser');
        await click('New tab');
        await until(() => main.eval(() => Boolean(document.querySelector('#browser-address'))), 'address');
        await new Promise(r => setTimeout(r, 300));
        await main.eval(() => document.querySelector('#browser-address').focus());
        await main.eval(value => { const e = document.querySelector('#browser-address'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); }, siteUrl);
        await new Promise(r => setTimeout(r, 30));
        await main.eval(() => document.querySelector('#browser-address').form.requestSubmit());
        const base = `/api/sessions/${sid}/browser`;
        const state = () => api(base);
        const s = await until(async () => { const s = await state(); return s.tabs.some(t => t.url === `${siteUrl}/`) && s; }, 'address navigation');
        const tid = s.tabs.find(t => t.url === `${siteUrl}/`).id;
        checks.push('initial native toolbar navigation without stream');
        await click('Keep control');
        await until(async () => (await state()).tabs.find(t => t.id === tid).control.lease === 'hold', 'keep control');
        checks.push('native hold');
        await click('Hand back to agent');
        await until(async () => (await state()).tabs.find(t => t.id === tid).control.holderId === null, 'handback');
        checks.push('native handback');
        const gt = (await targets()).find(t => t.url === `${siteUrl}/`);
        guest = await Cdp.open(gt.webSocketDebuggerUrl);
        assert.equal(await guest.eval(() => typeof require), 'undefined');
        assert.equal(await guest.eval(() => typeof process), 'undefined');
        checks.push('guest Node integration disabled');
        await guest.eval(() => { window.__exampleInputEvents = []; for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'blur', 'focus']) addEventListener(type, event => window.__exampleInputEvents.push({ type, trusted: event.isTrusted, at: event.timeStamp }), true); });
        await guest.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 80, y: 80, button: 'left', clickCount: 1 });
        await until(async () => (await state()).tabs.find(t => t.id === tid).control.holderId === 'desktop-native', 'native touch');
        checks.push('native touch takeover');
        await new Promise(r => setTimeout(r, 2800));
        assert.equal((await state()).tabs.find(t => t.id === tid).control.holderId, 'desktop-native', JSON.stringify(await guest.eval(() => ({events:window.__exampleInputEvents,focused:document.hasFocus()}))));
        checks.push('held native drag does not expire');
        await guest.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 80, y: 80, button: 'left', clickCount: 1 });
        await until(async () => (await state()).tabs.find(t => t.id === tid).control.holderId === null, 'idle handback');
        checks.push('idle resumes agent');
        await main.eval(id => window.mingleBrowserDesktop.embedded.hide(id), sid);
        const hidden = await fetch(origin + base + '/tabs/' + tid + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: { type: 'wait', timeoutMs: 1 }, clientId: 'desktop-native' }) });
        assert.equal(hidden.status, 403);
        checks.push('hidden native ID rejected');
        await main.eval(async ({ sid, targetId }) => { const r = document.querySelector('.browser-native-placeholder').getBoundingClientRect(); return window.mingleBrowserDesktop.embedded.show(sid, targetId, { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }); }, { sid, targetId: s.tabs.find(t => t.id === tid).embeddedTargetId });
        await api(base + '/tabs/' + tid + '/action', 'POST', { action: { type: 'wait', timeoutMs: 1 }, clientId: 'desktop-native' });
        checks.push('exact native presentation restores authorization');
        await click('Open full view');
        await until(() => main.eval(() => !document.querySelector('.browser-native-placeholder')?.classList.contains('is-fallback')), 'native full view');
        await api(base + '/tabs/' + tid + '/action', 'POST', { action: { type: 'wait', timeoutMs: 1 }, clientId: 'desktop-native' });
        checks.push('full-view container preserves native presentation');
        await main.eval(() => {
            const overlay = document.createElement('div');
            overlay.id = 'acceptance-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none';
            document.body.append(overlay);
        });
        await until(() => main.eval(() => {
            const canvas = document.querySelector('.browser-stage__canvas');
            return canvas && !canvas.classList.contains('is-empty');
        }), 'overlay stream frame');
        const point = await main.eval(() => {
            const r = document.querySelector('.browser-stage').getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await main.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await main.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        await until(async () => {
            const holder = (await state()).tabs.find(t => t.id === tid).control.holderId;
            return holder !== null && holder !== 'desktop-native';
        }, 'fallback viewer takeover');
        checks.push('overlay fallback streams and uses its own viewer identity');
        await main.eval(() => document.querySelector('#acceptance-overlay').remove());
        await until(() => main.eval(() => !document.querySelector('.browser-native-placeholder')?.classList.contains('is-fallback')), 'return from overlay');
        await until(async () => (await state()).tabs.find(t => t.id === tid).control.holderId === null, 'fallback release');
        await api(base + '/tabs/' + tid + '/action', 'POST', { action: { type: 'wait', timeoutMs: 1 }, clientId: 'desktop-native' });
        checks.push('overlay dismissal restores native control');
        await writeFile(join(dir, 'native-browser.png'), Buffer.from((await main.call('Page.captureScreenshot')).data, 'base64'));
        await writeFile(join(dir, 'native-page.png'), Buffer.from((await guest.call('Page.captureScreenshot')).data, 'base64'));
        console.log(JSON.stringify({ checks, artifactDir: dir }, null, 2));
    }
    catch (e) {
        console.error('APP', stdout);
        if (main)
            console.error('UI', await main.eval(() => document.body.innerText).catch(() => ''));
        throw e;
    }
    finally {
        main?.close();
        guest?.close();
        if (child.exitCode === null) {
            const exited = new Promise(r => child.once('exit', r));
            child.kill('SIGTERM');
            const force = setTimeout(() => child.kill('SIGKILL'), 35000);
            force.unref();
            await exited;
            clearTimeout(force);
        }
        await new Promise(r => site.close(r));
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
