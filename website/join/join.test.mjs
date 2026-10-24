import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { appLinkFromFragment } from './join.mjs';

test('valid invitations become an app link with no automatic execution', () => {
  for (const token of ['A'.repeat(43), '_-Ab01'.repeat(20), 'Z'.repeat(128)]) {
    assert.equal(appLinkFromFragment(`#token=${token}`), `mingle://join?token=${token}`);
  }
});

test('malformed, duplicated, oversized and injected invitations reject', () => {
  for (const fragment of ['', 'token=' + 'a'.repeat(43), '#token=short', '#token=' + 'A'.repeat(42), '#token=' + 'A'.repeat(129),
    '#token=' + 'a'.repeat(43) + '&token=' + 'b'.repeat(43), '#token=' + 'a'.repeat(43) + '&redirect=https://evil.test',
    '#token=javascript:alert(1)', '#token=' + 'a'.repeat(43) + '%0A', '#other=' + 'a'.repeat(43), '#token=' + 'a'.repeat(2048)]) {
    assert.equal(appLinkFromFragment(fragment), null, fragment.slice(0, 80));
  }
});

test('landing page blocks connections, referrers and third-party resources', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /id="actions" hidden/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
});
