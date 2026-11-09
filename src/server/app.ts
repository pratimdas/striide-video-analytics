import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import type { LabDb, RunRow } from '../store/db.js';
import type { JobRunner } from '../jobs/runner.js';
import { esc } from '../util/html.js';
import { renderAthleteHtml, BRAND_TOKENS } from '../report/athlete-html.js';
import { renderConsole } from '../report/console-html.js';
import { LAB_CSS } from '../report/styles.js';
import { assertInside } from '../util/paths.js';
import { RUN_ID } from '../util/ids.js';
import { sha256Hex } from '../util/hash.js';
import { errorSummary } from '../util/errors.js';
import type { DeclaredContext } from '../orchestration/prompts.js';
import { aggregateRuns } from '../telemetry/aggregate.js';

function dashboardPage(d: ServerDeps): string {
  const a = aggregateRuns(d.db);
  const f = (x: number | null) => (x === null ? '—' : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x.toFixed(0)} ms`);
  const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(0)}%`);
  return page('Optimisation dashboard', `<p class="eyebrow" style="margin-top:16px">Internal · optimisation dashboard</p><h1>Observed performance</h1><div class="notice">${esc(a.note)}</div>
  <div class="metrics"><div class="metric">Runs<b>${a.total_runs}</b>${a.fresh_completed_runs} fresh completed</div><div class="metric">Failure rate<b>${pct(a.failure_rate)}</b>failed or rejected</div><div class="metric">Additional inspections<b>${pct(a.additional_inspection_rate)}</b>runs with a follow-up</div><div class="metric">Known-cost coverage<b>${pct(a.known_cost_coverage)}</b>runs with fully priced usage</div><div class="metric">Report coverage<b>${pct(a.accepted_report_coverage_median)}</b>median assessed questions</div></div>
  <div class="card scroll"><h2>Per-stage union time</h2><table><tr><th>Stage</th><th>n</th><th>Median</th><th>p95</th></tr>${Object.entries(a.stages).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${f(v.median_ms)}</td><td>${f(v.p95_ms)}</td></tr>`).join('')}</table></div>
  <div class="card scroll"><h2>By mode, cache state and ontology</h2><table><tr><th>Group</th><th>Runs</th><th>Median wall</th><th>p95 wall</th></tr>${Object.entries(a.groups).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.runs}</td><td>${f(v.wall_median_ms)}</td><td>${f(v.wall_p95_ms)}</td></tr>`).join('')}</table></div>
  <div class="card"><h2>Suggestions from observed traces</h2><ul class="clean">${a.suggestions.map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">No suggestion yet.</li>'}</ul><p class="small muted">Every performance change must be evaluated against recognition and evidence quality. Parallelism can lower latency while raising total cost.</p></div>`);
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const MIME: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

export interface ServerDeps { lc: LoadedConfig; db: LabDb; runner: JobRunner }

/** Media/evidence resolution through job-owned IDs only; filesystem paths never reach the browser. */
function mediaFor(run: RunRow, db: LabDb, mediaId: string): { file: string; mime: string } | null {
  let r: RunRow | undefined = run;
  for (let i = 0; i < 3 && r; i++) {
    const cp = join(r.run_dir, 'media.checkpoint.json');
    if (existsSync(cp)) {
      const m = JSON.parse(readFileSync(cp, 'utf8'));
      for (const rec of [m.playback, m.prepared]) if (rec?.media_id === mediaId && existsSync(rec.file)) return { file: rec.file, mime: rec.mime || 'video/mp4' };
      return null;
    }
    r = r.reused_from_run ? db.getRun(r.reused_from_run) : undefined;
  }
  return null;
}
function baseRunDir(run: RunRow, db: LabDb): string { return run.cache_kind === 'result_cache_hit' && run.reused_from_run ? db.getRun(run.reused_from_run)?.run_dir ?? run.run_dir : run.run_dir; }

function send(res: ServerResponse, code: number, body: string | Buffer, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", ...extra });
  res.end(body);
}
const json = (res: ServerResponse, code: number, v: unknown) => send(res, code, JSON.stringify(v), 'application/json; charset=utf-8');

/** HTTP range support (RFC 7233 single range) for seekable playback. */
export function serveFileRange(req: IncomingMessage, res: ServerResponse, file: string, mime: string) {
  const size = statSync(file).size;
  const range = req.headers.range;
  const base = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { ...base, 'content-range': `bytes */${size}` }); return res.end(); }
    let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] === '' ? size - 1 : m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start < 0) start = 0;
    if (start > end || start >= size) { res.writeHead(416, { ...base, 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...base, 'content-length': String(size) });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }
}

async function readBody(req: IncomingMessage, max = 64 * 1024): Promise<any> {
  return new Promise((resolveP, reject) => {
    let s = ''; req.on('data', (d) => { s += d; if (s.length > max) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolveP(s ? JSON.parse(s) : {}); } catch { reject(new Error('invalid JSON')); } });
  });
}

/** Registered input-root files only (two levels deep); the wider disk is never enumerated. */
export function listInputs(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const walk = (d: string, rel: string, depth: number) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory() && depth < 1) walk(join(d, e.name), r, depth + 1); else if (e.isFile() && VIDEO_EXT.test(e.name)) out.push(r); } };
  walk(root, '', 0); return out.sort().slice(0, 500);
}

function page(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/brand/fonts/fonts.css"><link rel="stylesheet" href="/brand/tokens.css"><style>${BRAND_TOKENS}${LAB_CSS}</style></head><body><div class="wrap"><header class="top"><div class="brand"><img src="/brand/striideai-wordmark.svg" alt="StriideAi" width="168" height="38"><span class="endorse">by Striide</span></div><nav class="links"><a class="btn secondary" href="/">Runs</a><a class="btn secondary" href="/dashboard">Optimisation</a></nav></header>${body}<div class="footer">Local research lab on 127.0.0.1. Decisions stay with people.</div></div>${script}</body></html>`;
}

export function createApp(d: ServerDeps): Server {
  const { lc, db, runner } = d;
  const allowedHosts = new Set([`127.0.0.1:${lc.config.server.port}`, `localhost:${lc.config.server.port}`, `[::1]:${lc.config.server.port}`]);
  return createServer(async (req, res) => {
    try {
      // DNS-rebinding and cross-site protection for a loopback-only service.
      if (!allowedHosts.has(String(req.headers.host))) return send(res, 421, 'Misdirected request', 'text/plain');
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'cross-origin request refused' });
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'JSON required' });
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;
      let m: RegExpExecArray | null;

      if (p.startsWith('/brand/')) {
        const rel = p.slice('/brand/'.length);
        if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(rel) || rel.includes('..')) return send(res, 404, 'Not found', 'text/plain');
        const f = resolve(lc.abs.brand, rel);
        if (!f.startsWith(resolve(lc.abs.brand)) || !existsSync(f) || !statSync(f).isFile() || !(extname(f) in MIME)) return send(res, 404, 'Not found', 'text/plain');
        return send(res, 200, readFileSync(f), MIME[extname(f)]!, { 'cache-control': 'max-age=3600' });
      }
      if (p === '/' && req.method === 'GET') return send(res, 200, indexPage(d));
      if (p === '/dashboard' && req.method === 'GET') return send(res, 200, dashboardPage(d));
      if (p === '/api/runs' && req.method === 'GET') return json(res, 200, db.listRuns(200).map(publicRun));
      if (p === '/api/runs' && req.method === 'POST') {
        const b = await readBody(req);
        if (typeof b.file !== 'string' || !VIDEO_EXT.test(b.file)) return json(res, 400, { error: 'choose a registered video file' });
        let file: string;
        try { file = assertInside(lc.abs.inputRoot, resolve(lc.abs.inputRoot, b.file)); } catch (e) { return json(res, 400, { error: errorSummary(e).message }); }
        if (!listInputs(lc.abs.inputRoot).includes(b.file)) return json(res, 400, { error: 'file is not in the registered input list' });
        const ctx = contextFrom(b.context);
        if (runner.isActive()) return json(res, 409, { error: 'a run is already in progress (one job at a time)' });
        const started = new Promise<string>((r) => { const h = (e: any) => { runner.off('state', h); r(e.runId); }; runner.on('state', h); });
        runner.run({ videoPath: file, context: ctx, caseId: null }).catch(() => undefined);
        return json(res, 202, { run_id: await started });
      }
      if ((m = /^\/api\/runs\/([^/]+)\/(cancel|feedback|events|ui-metrics)$/.exec(p))) {
        const runId = m[1]!; if (!RUN_ID.test(runId)) return json(res, 404, { error: 'unknown run' });
        const run = db.getRun(runId); if (!run) return json(res, 404, { error: 'unknown run' });
        if (m[2] === 'cancel' && req.method === 'POST') return json(res, runner.cancel(runId) ? 202 : 409, { cancelled: true });
        if (m[2] === 'events' && req.method === 'GET') return sse(req, res, d, run);
        if (m[2] === 'ui-metrics' && req.method === 'POST') {
          const b = await readBody(req, 8192);
          const rec = { at: new Date().toISOString(), kind: 'ui_observed', time_to_first_report_ms: num(b.time_to_first_report_ms), replay_ready_ms: num(b.replay_ready_ms), note: 'browser-observed; distinct from server completion time' };
          appendFileSync(join(run.run_dir, 'ui-metrics.jsonl'), JSON.stringify(rec) + '\n');
          return json(res, 204, {});
        }
        if (m[2] === 'feedback' && req.method === 'POST') {
          const b = await readBody(req);
          const dto = readJsonSafe(join(baseRunDir(run, db), 'athlete.json'));
          if (!dto) return json(res, 409, { error: 'no report to review' });
          const reportSha = sha256Hex(readFileSync(join(baseRunDir(run, db), 'athlete.json')));
          if (b.report_version !== dto.report_version) return json(res, 409, { error: 'report version mismatch' });
          const kind = b.target_kind; const id = String(b.target_id ?? '');
          const valid = kind === 'finding' ? dto.findings.some((f: any) => f.finding_id === id) : kind === 'interval' ? Number.isInteger(Number(id)) && Number(id) >= 0 && Number(id) < dto.timeline.length : false;
          if (!valid) return json(res, 400, { error: 'target must be one finding or event interval in this report' });
          if (typeof b.correction !== 'string' || !b.correction.trim() || b.correction.length > 300) return json(res, 400, { error: 'correction required (<= 300 chars)' });
          const fid = db.addFeedback({ run_id: run.run_id, report_version: dto.report_version, report_sha256: reportSha, target_kind: kind, target_id: id, correction: { text: b.correction.trim() }, note: typeof b.note === 'string' ? b.note.slice(0, 1000) : null });
          appendFileSync(join(run.run_dir, 'feedback.jsonl'), JSON.stringify({ id: fid, report_version: dto.report_version, report_sha256: reportSha, target_kind: kind, target_id: id, correction: b.correction.trim(), note: b.note ?? null, at: new Date().toISOString() }) + '\n');
          return json(res, 201, { saved: true, id: fid, report_version: dto.report_version });
        }
        return json(res, 405, { error: 'method not allowed' });
      }
      if ((m = /^\/media\/([^/]+)\/(med_[0-9a-f]{12})$/.exec(p))) {
        const run = RUN_ID.test(m[1]!) ? db.getRun(m[1]!) : undefined; if (!run) return send(res, 404, 'Not found', 'text/plain');
        const md = mediaFor(run, db, m[2]!); if (!md) return send(res, 404, 'Not found', 'text/plain');
        return serveFileRange(req, res, md.file, md.mime);
      }
      if ((m = /^\/evidence\/([^/]+)\/(pk\d{1,3}_f\d{2})\.jpg$/.exec(p))) {
        const run = RUN_ID.test(m[1]!) ? db.getRun(m[1]!) : undefined; if (!run) return send(res, 404, 'Not found', 'text/plain');
        const f = join(baseRunDir(run, db), 'evidence', `${m[2]}.jpg`);
        return existsSync(f) ? send(res, 200, readFileSync(f), 'image/jpeg') : send(res, 404, 'Not found', 'text/plain');
      }
      if ((m = /^\/runs\/([^/]+)(?:\/(report|console|live|export\/athlete\.(json|csv|html)|artifacts\/([A-Za-z0-9_.-]{1,160})))?$/.exec(p))) {
        const run = RUN_ID.test(m[1]!) ? db.getRun(m[1]!) : undefined; if (!run) return send(res, 404, page('Not found', '<h1>Run not found</h1>'));
        const view = m[2] ?? 'report';
        const dir = baseRunDir(run, db);
        if (view === 'live') return send(res, 200, livePage(run));
        if (view === 'console') return send(res, 200, renderConsole({ run, db, related: run.clip_key ? db.runsForClip(run.clip_key) : [run] }));
        if (m[4]) { const f = join(run.run_dir, 'artifacts', m[4]); return existsSync(f) ? send(res, 200, readFileSync(f), 'text/plain; charset=utf-8') : send(res, 404, 'Not found', 'text/plain'); }
        const dtoPath = join(dir, 'athlete.json');
        if (m[3]) {
          if (!existsSync(dtoPath)) return send(res, 404, 'No report for this run', 'text/plain');
          const file = join(dir, `athlete.${m[3]}`);
          const type = m[3] === 'json' ? 'application/json' : m[3] === 'csv' ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8';
          return send(res, 200, readFileSync(file), type, { 'content-disposition': `attachment; filename="striideai-${run.run_id}.${m[3]}"` });
        }
        if (!existsSync(dtoPath)) return send(res, 200, page('Run diagnostic', `<h1>No athlete report</h1><p>This run ended as <strong>${esc(run.outcome ?? run.state)}</strong>${run.error_kind ? ` (${esc(run.error_kind)})` : ''}. ${esc(run.error_message ?? '')}</p><p>No report is fabricated when analysis fails. Internal diagnostics remain available.</p><p><a class="btn" href="/runs/${esc(run.run_id)}/console">Open internal console</a></p>`));
        const dto = JSON.parse(readFileSync(dtoPath, 'utf8'));
        const html = renderAthleteHtml(dto, { mode: 'live', runId: run.run_id, videoUrl: `/media/${run.run_id}/${dto.video.media_id}`, evidenceUrl: (id) => `/evidence/${run.run_id}/${id}.jpg`, consoleUrl: lc.config.reports.include_internal_dashboard ? `/runs/${run.run_id}/console` : undefined, reportSha: sha256Hex(readFileSync(dtoPath)) });
        const metrics = `<script>(() => { const t0 = performance.timeOrigin; const v = document.getElementById('player'); const post = (b) => fetch('/api/runs/${run.run_id}/ui-metrics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); let sent = false; const first = performance.now(); const go = (replay) => { if (sent) return; sent = true; post({ time_to_first_report_ms: first, replay_ready_ms: replay }); }; if (v) { v.addEventListener('canplay', () => go(performance.now()), { once: true }); setTimeout(() => go(null), 15000); } else go(null); })();</script>`;
        return send(res, 200, html.replace('</body>', `${metrics}</body>`));
      }
      return send(res, 404, page('Not found', '<h1>Not found</h1>'));
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  });
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
function readJsonSafe(p: string) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function publicRun(r: RunRow) { return { run_id: r.run_id, created_at: r.created_at, mode: r.mode, label: r.label, state: r.state, outcome: r.outcome, source_name: r.source_name, cache_kind: r.cache_kind, wall_ms: r.wall_ms, error_kind: r.error_kind }; }

function contextFrom(c: any): DeclaredContext | null {
  if (!c || typeof c !== 'object') return null;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
  const age = c.age_years === '' || c.age_years === null || c.age_years === undefined ? null : Number(c.age_years);
  const out: DeclaredContext = { sport: s(c.sport), discipline: null, skill: s(c.skill), format: s(c.format), age_years: age !== null && Number.isInteger(age) && age >= 3 && age <= 100 ? age : null, athlete_id: null, target_person_hint: s(c.target_person_hint), goal: s(c.goal), handedness: null, ball_type: s(c.ball_type), consent_confirmed: false };
  return [out.sport, out.skill, out.format, out.age_years, out.target_person_hint, out.goal, out.ball_type].every((v) => v === null) ? null : out;
}

function sse(req: IncomingMessage, res: ServerResponse, d: ServerDeps, run: RunRow) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const write = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const e of d.db.events(run.run_id)) write('state', { state: e.state, elapsed_ms: e.elapsed_ms, detail: e.detail });
  const onState = (e: any) => { if (e.runId === run.run_id) write('state', { state: e.state, elapsed_ms: e.elapsed_ms, detail: e.detail ?? e.outcome ?? null }); };
  const onSpan = (e: any) => { if (e.runId === run.run_id && e.event.event === 'span_end') write('span', { name: e.event.name, status: e.event.status, duration_ms: e.event.duration_ms, end_offset_ms: e.event.end_offset_ms }); };
  d.runner.on('state', onState); d.runner.on('span', onSpan);
  req.on('close', () => { d.runner.off('state', onState); d.runner.off('span', onSpan); });
}

function livePage(run: RunRow): string {
  return page(`Run ${run.run_id}`, `<h1>Run in progress</h1><p class="small muted"><code>${esc(run.run_id)}</code> · ${esc(run.source_name)} · mode ${esc(run.mode)}</p>
  <div class="card"><p>State: <strong id="state">${esc(run.state)}</strong> · elapsed <span id="elapsed">–</span></p><p class="small muted">Real stage events and measured durations; no estimated percentage is shown.</p><button type="button" id="cancel" class="secondary">Cancel run</button> <a class="btn" id="open" href="/runs/${esc(run.run_id)}/report" hidden>Open report</a> <a class="btn secondary" href="/runs/${esc(run.run_id)}/console">Internal console</a></div>
  <div class="card"><h2>Completed steps</h2><div class="scroll"><table><thead><tr><th>Step</th><th>Status</th><th>Duration</th><th>At</th></tr></thead><tbody id="spans"></tbody></table></div></div>`,
  `<script>(() => { const es = new EventSource('/api/runs/${esc(run.run_id)}/events'); const fmt = (ms) => ms >= 1000 ? (ms/1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
  es.addEventListener('state', (e) => { const d = JSON.parse(e.data); document.getElementById('state').textContent = d.state + (d.detail ? ' — ' + d.detail : ''); document.getElementById('elapsed').textContent = fmt(d.elapsed_ms); if (d.state === 'finished') { document.getElementById('open').hidden = false; es.close(); } });
  es.addEventListener('span', (e) => { const d = JSON.parse(e.data); if (/^(tool_call|response_receive|hashing)$/.test(d.name)) return; const tr = document.createElement('tr'); for (const v of [d.name, d.status, fmt(d.duration_ms), fmt(d.end_offset_ms)]) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); } document.getElementById('spans').prepend(tr); });
  document.getElementById('cancel').addEventListener('click', () => fetch('/api/runs/${esc(run.run_id)}/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })); })();</script>`);
}

function indexPage(d: ServerDeps): string {
  const runs = d.db.listRuns(100);
  const inputs = listInputs(d.lc.abs.inputRoot);
  return page('StriideAi local lab', `<p class="eyebrow" style="margin-top:16px">Local research lab · mode ${esc(d.lc.config.experiment.mode)} · label ${esc(d.lc.config.experiment.label)}</p><h1>Analyse a clip</h1>
  <form class="card feedback" id="new"><label>Video from the registered input folder
  <select name="file" required>${inputs.map((f) => `<option>${esc(f)}</option>`).join('') || '<option value="" disabled selected>No videos found in the input folder</option>'}</select></label>
  <details><summary>Optional declared context (leave blank for a no-context run)</summary><div class="grid" style="margin-top:8px"><label>Sport <input name="sport" maxlength="60"></label><label>Skill <input name="skill" maxlength="60"></label><label>Age (years) <input name="age_years" inputmode="numeric" pattern="[0-9]*" maxlength="3"></label><label>Format <input name="format" maxlength="60"></label><label>Goal <input name="goal" maxlength="120"></label><label>Target athlete hint <input name="target_person_hint" maxlength="120"></label></div></details>
  <button type="submit">Start analysis</button><p class="small muted" id="msg" aria-live="polite">Video and selected frames are sent to TwelveLabs and Gemini when a run starts.</p></form>
  <h2>Runs</h2><div class="card scroll"><table><tr><th>Run</th><th>Clip</th><th>Mode</th><th>Cache</th><th>Outcome</th><th>Wall</th><th></th></tr>${runs.map((r) => `<tr><td><code class="small">${esc(r.run_id)}</code><div class="small muted">${esc(r.created_at)}</div></td><td>${esc(r.source_name)}</td><td>${esc(r.mode)}</td><td>${esc(r.cache_kind)}</td><td><span class="pill state-${esc(r.outcome ?? r.state)}">${esc(r.outcome ?? r.state)}</span></td><td>${r.wall_ms ? `${(r.wall_ms / 1000).toFixed(1)} s` : '—'}</td><td><a href="/runs/${esc(r.run_id)}/report">Report</a> · <a href="/runs/${esc(r.run_id)}/console">Console</a></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No runs yet.</td></tr>'}</table></div>`,
  `<script>document.getElementById('new').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); const context = {}; for (const k of ['sport','skill','age_years','format','goal','target_person_hint']) { const v = f.get(k); if (v) context[k] = v; }
  const r = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: f.get('file'), context }) }); const b = await r.json(); if (r.ok) location.href = '/runs/' + b.run_id + '/live'; else document.getElementById('msg').textContent = b.error; });</script>`);
}
