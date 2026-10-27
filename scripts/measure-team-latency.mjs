#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const USAGE = `Usage:
  node scripts/measure-team-latency.mjs --from-url URL --from-project ID --to-url URL --to-project ID

Sends ten marked team-chat probes and reports the time until each appears in the other server's transcript.
`;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return null;
    if (!['--from-url', '--from-project', '--to-url', '--to-project'].includes(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Invalid or incomplete command-line arguments.');
    }
    parsed[key.slice(2)] = argv[++index];
  }
  if (Object.keys(parsed).length !== 4) throw new Error('All four server URL and project ID options are required.');
  for (const key of ['from-url', 'to-url']) {
    const url = new URL(parsed[key]);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URLs must use HTTP or HTTPS.');
    parsed[key] = url.toString().replace(/\/$/, '');
  }
  return parsed;
}

async function requestJson(url, init = {}) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error('A local Mingle server request failed or timed out.');
  }
  if (!response.ok) throw new Error(`A local Mingle server returned HTTP ${response.status}.`);
  try { return await response.json(); }
  catch { throw new Error('A local Mingle server returned an invalid response.'); }
}

function endpoint(baseUrl, projectId, query = '') {
  return `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/team-chat${query}`;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitUntilVisible(baseUrl, projectId, marker) {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const snapshot = await requestJson(endpoint(baseUrl, projectId, '?limit=200'));
    if (Array.isArray(snapshot?.messages) && snapshot.messages.some((message) => message?.body === marker)) return;
    await sleep(25);
  }
  throw new Error('A team-chat probe did not appear before the 15-second deadline.');
}

function percentile(samples, fraction) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(USAGE);
    return;
  }
  const measurements = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const marker = `Mingle latency probe ${randomUUID()}`;
    const startedAt = performance.now();
    await requestJson(endpoint(options['from-url'], options['from-project'], '/messages'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: marker, mentions: [] }),
    });
    await waitUntilVisible(options['to-url'], options['to-project'], marker);
    measurements.push(performance.now() - startedAt);
  }
  process.stdout.write(`Team-chat delivery latency (10 messages): p50 ${percentile(measurements, 0.5).toFixed(1)} ms, p90 ${percentile(measurements, 0.9).toFixed(1)} ms\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Latency measurement failed.'}\n`);
  process.exitCode = 1;
});
