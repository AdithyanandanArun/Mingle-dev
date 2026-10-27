#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const webRoot = path.join(root, 'apps/web');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const vite = await import(pathToFileURL(webRequire.resolve('vite')).href);
const { chromium } = serverRequire('playwright');
const output = path.join(os.tmpdir(), `mingle-model-picker-acceptance-${process.pid}`);
const screenshots = { desktop: path.join(output, 'model-picker-desktop.png'), narrow: path.join(output, 'model-picker-360px.png') };
await mkdir(output, { recursive: true });

let server;
let browser;
try {
  server = await vite.createServer({
    configFile: path.join(webRoot, 'vite.config.ts'),
    root,
    appType: 'mpa',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    resolve: {
      alias: [
        { find: 'react', replacement: path.join(webRoot, 'node_modules/react') },
        { find: 'react-dom', replacement: path.join(webRoot, 'node_modules/react-dom') },
      ],
      dedupe: ['react', 'react-dom'],
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === 'object', 'Vite should bind an ephemeral local port.');
  const url = `http://127.0.0.1:${address.port}/scripts/model-picker-browser-fixture.html`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1120, height: 820 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Model picker acceptance' }).waitFor();

  const modelTrigger = page.getByRole('combobox', { name: 'Model', exact: true });
  await modelTrigger.click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search models');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search models', 'opening a large catalog focuses its search field');
  const selected = picker.getByRole('option', { name: /Fixture Codex Search Model 04/ });
  await selected.waitFor();
  assert.equal(await selected.getAttribute('aria-selected'), 'true', 'the configured model is shown as selected with its provider subtitle');
  assert.match(await selected.innerText(), /Codex/);
  assert.match(await picker.getByRole('tab', { name: /OpenCode.*runtime metadata lookup failed/ }).getAttribute('title'), /runtime metadata lookup failed/);
  assert.equal(await picker.getByRole('tab', { name: /OpenCode/ }).isDisabled(), true, 'unavailable provider remains visible and disabled');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-model-id')), 'fixture-codex-search-04', 'Tab moves from search to the selected model option');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-provider-id')), 'codex', 'Tab wraps from the last tabbable option to the active provider rail item');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-model-id')), 'fixture-codex-search-04', 'Shift+Tab wraps back to the last tabbable option');
  await page.screenshot({ path: screenshots.desktop, fullPage: true });

  await page.keyboard.press('Escape');
  assert.equal(await modelTrigger.getAttribute('aria-expanded'), 'false', 'Escape closes the picker');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Model');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Model', 'Escape restores focus to the trigger');

  await modelTrigger.click();
  const search = page.getByRole('searchbox', { name: 'Search models' });
  await search.fill('Search Model 11');
  const searchLength = (await search.inputValue()).length;
  await page.keyboard.press('ArrowLeft');
  assert.equal(await search.evaluate((input) => input.selectionStart), searchLength - 1, 'ArrowLeft moves the search caret without switching providers');
  assert.equal(await picker.getByRole('tab', { name: 'Codex', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Home');
  assert.equal(await search.evaluate((input) => input.selectionStart), 0, 'Home moves to the start of the search query');
  await page.keyboard.press('End');
  assert.equal(await search.evaluate((input) => input.selectionStart), searchLength, 'End moves to the end of the search query');
  const searchResult = picker.getByRole('option', { name: /Fixture Codex Search Model 11/ });
  await searchResult.waitFor();
  assert.equal(await picker.getByRole('option').count(), 1, 'search narrows the active provider catalog');
  await page.getByRole('button', { name: 'Clear model search' }).click();
  assert.equal(await search.inputValue(), '', 'the clear-search action resets the search field');
  await search.fill('Search Model 11');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-model-id')), 'fixture-codex-search-11', 'ArrowDown moves focus from search to the matching model option');
  await page.keyboard.press('Enter');
  await page.getByText('codex · fixture-codex-search-11', { exact: true }).waitFor();
  assert.equal(await modelTrigger.getAttribute('aria-expanded'), 'false', 'Enter chooses the active model and closes');

  const lockedTrigger = page.getByRole('combobox', { name: 'Locked model', exact: true });
  await lockedTrigger.click();
  const lockedPopup = page.getByRole('dialog', { name: 'Choose a model' });
  assert.equal(await lockedPopup.getByRole('tab', { name: /Codex.*Provider changes are locked/ }).isDisabled(), true, 'provider locking also disables the provider rail');
  assert.equal(await lockedPopup.getByRole('tab', { name: 'Claude', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Escape');

  const savedTrigger = page.getByRole('combobox', { name: 'Saved model', exact: true });
  await savedTrigger.click();
  const savedPopup = page.getByRole('dialog', { name: 'Choose a model' });
  const savedUnknown = savedPopup.getByRole('option', { name: /saved-model-not-in-fixture-catalog/ });
  await savedUnknown.waitFor();
  assert.equal(await savedUnknown.getAttribute('aria-selected'), 'true', 'an unknown saved model remains selected and is not replaced');
  assert.match(await savedUnknown.innerText(), /not in current catalog/);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 360, height: 800 });
  await modelTrigger.click();
  await picker.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search models');
  const box = await picker.boundingBox();
  assert.ok(box, 'picker is visible at narrow viewport width');
  assert.ok(box.x >= 0 && box.x + box.width <= 360, `picker should be horizontally clamped: ${JSON.stringify(box)}`);
  assert.ok(box.width <= 344, `picker should fit mobile viewport padding: ${JSON.stringify(box)}`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'fixture has no horizontal page overflow at 360px');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search models', 'opening a large catalog focuses its search field');

  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  assert.equal(await modelTrigger.getAttribute('aria-expanded'), 'true', 'an outer scroll repositions without closing the picker');
  assert.ok(await picker.boundingBox(), 'the popup remains visible after an outer scroll');

  await page.getByRole('listbox', { name: 'Models' }).evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    list.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  assert.equal(await modelTrigger.getAttribute('aria-expanded'), 'true', 'scrolling the model list does not hide the popup');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search models', 'list scrolling does not steal search focus');

  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  const resizedBox = await picker.boundingBox();
  assert.equal(await modelTrigger.getAttribute('aria-expanded'), 'true', 'viewport resize keeps the picker open');
  assert.ok(resizedBox && resizedBox.x >= 0 && resizedBox.x + resizedBox.width <= 390, `resize should recompute the popup bounds: ${JSON.stringify(resizedBox)}`);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  await page.screenshot({ path: screenshots.narrow, fullPage: true });
  await page.keyboard.press('Escape');

  assert.deepEqual(pageErrors, [], 'the picker fixture should not produce uncaught errors');
  console.log(`Model picker browser acceptance passed. Screenshots: ${screenshots.desktop}, ${screenshots.narrow}`);
} finally {
  await browser?.close();
  await server?.close();
}
