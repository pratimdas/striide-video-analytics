import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { loadConfig, loadEnvFile } from '../src/config/load.js';
import { LabDb } from '../src/store/db.js';
import { JobRunner } from '../src/jobs/runner.js';
import { createApp } from '../src/server/app.js';
import { connectFalkor } from '../src/ontology/falkor-conn.js';
import { fromRoot } from '../src/util/paths.js';
import { mockGemini, mockTwelveLabs } from './mocks.js';
import { makeFixtureClip, tmp, writeTestConfig } from './helpers.js';

loadEnvFile();
process.env.GEMINI_INSPECTOR_MODEL = 'gemini-offline-mock-inspector'; process.env.GEMINI_API_KEY = 'ui-test-secret-key-abcdef'; process.env.TWELVE_LABS_API_KEY = 'ui-test-secret-key-tl';
let skip: string | false = false;
if (!existsSync(fromRoot('data/ontology-import.local.json'))) skip = 'no verified ontology import';
else { try { const db = await connectFalkor({ host: process.env.FALKORDB_HOST ?? null, port: Number(process.env.FALKORDB_PORT), username: null, password: process.env.FALKORDB_PASSWORD || null, tls: false }, 2000); await db.close(); } catch { skip = 'FalkorDB not reachable'; } }
let playwright: any = null;
try { playwright = createRequire(import.meta.url)('playwright'); } catch { /* optional */ }

const STEP = 4;
const port = 19000 + Math.floor(Math.random() * 500);
let base = ''; let server: any; let db: LabDb; let runId = ''; let failedRunId = ''; let runDir = '';

test.before(async () => {
  if (skip) return;
  const dir = tmp('ui-');
  const cfg = writeTestConfig(dir, (c) => { c.ontology.import_manifest = fromRoot('data/ontology-import.local.json'); c.experiment.mode = 'ontology_fixed'; c.server.port = port; c.providers.twelvelabs.poll_interval_ms = 250; });
  const lc = loadConfig(cfg);
  // VFR clip with a 5 s container start offset: frame k is shown at k/30 + k^2/1500 s and has luma k*STEP.
  const clip = await makeFixtureClip(join(dir, 'inputs'), { name: 'vfr.mp4', frames: 60, width: 640, height: 360, offset: 5, lumaStep: STEP });
  db = new LabDb(join(dir, 'runs', 'lab.sqlite'));
  const runner = new JobRunner(lc, db, { twelvelabs: mockTwelveLabs().client, gemini: mockGemini().client, label: 'offline-mock' });
  const r = await runner.run({ videoPath: clip });
  assert.equal(r.error, null, JSON.stringify(r.error));
  runId = r.runId; runDir = r.runDir;
  const bad = join(dir, 'inputs', 'bad.mp4'); writeFileSync(bad, 'xx');
  failedRunId = (await runner.run({ videoPath: bad })).runId;
  server = createApp({ lc, db, runner });
  await new Promise<void>((res) => server.listen(port, '127.0.0.1', () => res()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

test('media route supports byte ranges with the correct MIME type', { skip }, async () => {
  const dto = await (await fetch(`${base}/runs/${runId}/export/athlete.json`)).json();
  const url = `${base}/media/${runId}/${dto.video.media_id}`;
  const full = await fetch(url);
  assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'video/mp4'); assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const size = Number(full.headers.get('content-length')); await full.arrayBuffer();
  const part = await fetch(url, { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 100-199/${size}`); assert.equal((await part.arrayBuffer()).byteLength, 100);
  const tail = await fetch(url, { headers: { range: 'bytes=-50' } });
  assert.equal(tail.status, 206); assert.equal((await tail.arrayBuffer()).byteLength, 50);
  assert.equal((await fetch(url, { headers: { range: `bytes=${size + 10}-` } })).status, 416);
});

test('path restrictions: no traversal, unknown media IDs or arbitrary files', { skip }, async () => {
  for (const p of [`/media/${runId}/../../package.json`, `/media/${runId}/med_000000000000`, '/brand/../package.json', `/evidence/${runId}/..%2f..%2fpackage.json`, `/runs/${runId}/artifacts/..%2fmanifest.json`, '/runs/run_x/report']) {
    const r = await fetch(base + p); assert.ok([404, 400].includes(r.status), `${p} -> ${r.status}`); await r.text();
  }
  const status = await new Promise<number>((res, rej) => { const q = httpRequest(base + '/', { headers: { host: 'evil.example' } }, (rr) => { rr.resume(); res(rr.statusCode ?? 0); }); q.on('error', rej); q.end(); });
  assert.equal(status, 421, 'DNS-rebinding Host header refused');
  const x = await fetch(`${base}/api/runs/${runId}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' }); assert.equal(x.status, 403);
});

test('athlete export endpoints exclude internal data; console and diagnostics render', { skip }, async () => {
  for (const ext of ['json', 'csv', 'html']) {
    const r = await fetch(`${base}/runs/${runId}/export/athlete.${ext}`); const s = await r.text();
    assert.equal(r.status, 200); assert.ok(!s.includes('ui-test-secret-key') && !s.includes('trace_id') && !s.includes('asset-mock') && !s.includes('/tmp/'), ext);
  }
  const html = await (await fetch(`${base}/runs/${runId}/export/athlete.html`)).text();
  assert.ok(html.includes('Offline fixture'), 'fixture runs are visibly labelled in exports');
  const consoleHtml = await (await fetch(`${base}/runs/${runId}/console`)).text();
  for (const tab of ['Overview', 'Timeline', 'Discovery / compare', 'Inspection', 'Ontology', 'Requests', 'Code Mode', 'Validation', 'Compare runs']) assert.ok(consoleHtml.includes(`>${tab}</button>`), tab);
  assert.ok(!consoleHtml.includes('ui-test-secret-key'));
  const diag = await (await fetch(`${base}/runs/${failedRunId}/report`)).text();
  assert.ok(/No athlete report/.test(diag) && /rejected/.test(diag));
  assert.ok((await (await fetch(`${base}/runs/${failedRunId}/console`)).text()).includes('Diagnostic'));
  assert.ok((await (await fetch(`${base}/dashboard`)).text()).includes('Per-stage union time'));
});

test('coach feedback is saved against the exact report version and validated', { skip }, async () => {
  const dto = await (await fetch(`${base}/runs/${runId}/export/athlete.json`)).json();
  const post = (b: unknown) => fetch(`${base}/api/runs/${runId}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const ok = await post({ target_kind: 'finding', target_id: dto.findings[0].finding_id, correction: 'answer should be partly', note: null, report_version: dto.report_version });
  assert.equal(ok.status, 201);
  assert.equal((await post({ target_kind: 'finding', target_id: 'nope', correction: 'x', report_version: dto.report_version })).status, 400);
  assert.equal((await post({ target_kind: 'interval', target_id: '0', correction: 'interval 0.4-1.2 s', report_version: 99 })).status, 409);
  const fb = db.feedback(runId);
  assert.equal(fb.length, 1); assert.equal(fb[0].report_version, dto.report_version); assert.match(fb[0].report_sha256, /^[0-9a-f]{64}$/);
});

test('clicking an evidence timestamp seeks the browser video to the matching source frame', { skip: skip || (!playwright && 'playwright not installed') }, async () => {
  const idx = JSON.parse(readFileSync(join(runDir, 'evidence.index.json'), 'utf8'));
  const frameAt = new Map<string, { t: number; frame_index: number }>(idx.flatMap((p: any) => p.frames.map((f: any) => [f.t.toFixed(3), f])));
  const dto = JSON.parse(readFileSync(join(runDir, 'athlete.json'), 'utf8'));
  assert.ok(Math.abs(dto.video.playback_offset_s) < 0.002, 'normalised playback starts at zero');
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/runs/${runId}/report`);
    await page.waitForFunction(() => (window as any).__seekReady === true);
    await page.waitForFunction(() => (document.getElementById('player') as HTMLVideoElement).readyState >= 1);
    const buttons = await page.locator('button.ts[data-seek]:not([data-until])').all();
    assert.ok(buttons.length >= 2, 'evidence buttons present');
    // Freeze playback so the frame shown is the one the seek selected.
    await page.evaluate(() => { (window as any).__play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; });
    let checked = 0;
    for (const b of buttons.slice(0, 4)) {
      const t = await b.getAttribute('data-seek');
      const expected = frameAt.get(Number(t).toFixed(3));
      if (!expected) continue;
      await page.evaluate(() => { const v = document.getElementById('player') as HTMLVideoElement; (window as any).__seeked = false; v.addEventListener('seeked', () => { v.pause(); (window as any).__seeked = true; }, { once: true }); });
      await b.click();
      await page.waitForFunction(() => (window as any).__seeked === true);
      const r = await page.evaluate(() => {
        const v = document.getElementById('player') as HTMLVideoElement; v.pause();
        const c = document.createElement('canvas'); c.width = 32; c.height = 18; const g = c.getContext('2d')!; g.drawImage(v, 0, 0, 32, 18);
        const d = g.getImageData(0, 0, 32, 18).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
        return { current: v.currentTime, luma: s / (d.length / 4) };
      });
      assert.ok(Math.abs(r.current - Number(t) - dto.video.playback_offset_s) < 0.01, `currentTime ${r.current} vs ${t}`);
      const shown = Math.round(r.luma / STEP);
      assert.ok(Math.abs(shown - expected.frame_index) <= 1, `button ${t}s showed fixture frame ${shown}, expected ${expected.frame_index}`);
      checked++;
    }
    assert.ok(checked >= 2, 'at least two evidence seeks verified by decoded pixels');
    await page.evaluate(() => { HTMLMediaElement.prototype.play = (window as any).__play; });
    // Interval playback stops at the window end.
    const iv = page.locator('button.ts[data-until]').first();
    const until = Number(await iv.getAttribute('data-until'));
    await iv.click();
    await page.waitForFunction(() => (document.getElementById('player') as HTMLVideoElement).paused && (document.getElementById('player') as HTMLVideoElement).currentTime > 0.1, null, { timeout: 15000 });
    const end = await page.evaluate(() => (document.getElementById('player') as HTMLVideoElement).currentTime);
    assert.ok(end - dto.video.playback_offset_s >= until - 0.05 && end - dto.video.playback_offset_s < until + 0.6, `interval playback stopped at ${end}, window end ${until}`);
    // Keyboard focus and narrow layout.
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 380 && !e.closest('.scroll')).slice(0, 5).map((e) => `${e.tagName}.${(e as HTMLElement).className}:${Math.round(e.getBoundingClientRect().right)}`));
    assert.ok(overflow <= 1, `no horizontal scroll at 375 px (overflow ${overflow}; ${wide.join(', ')})`);
    await page.screenshot({ path: join(runDir, 'ui-report-375.png'), fullPage: false });
  } finally { await browser.close(); }
});
