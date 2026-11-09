import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { esc } from '../util/html.js';
import { LAB_CSS } from './styles.js';
import { BRAND_TOKENS } from './athlete-html.js';
import { readSpans, summarise, stageUnion, unionDuration, type SpanRecord } from '../telemetry/trace.js';
import type { RunRow, LabDb } from '../store/db.js';
import type { CallRecord } from '../telemetry/ledger.js';
import { runCost } from '../telemetry/ledger.js';

const j = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const ms = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x.toFixed(0)} ms`);
const pill = (s: string) => `<span class="pill state-${esc(s)}">${esc(String(s).replace(/_/g, ' '))}</span>`;
const pre = (x: unknown) => `<pre>${esc(typeof x === 'string' ? x : JSON.stringify(x, null, 2))}</pre>`;
const PROVIDER_SPANS = /^(twelvelabs|pegasus|gemini)\.|_request$/;

function depthMap(spans: SpanRecord[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const d = new Map<string, number>();
  const depth = (s: SpanRecord): number => { if (d.has(s.span_id)) return d.get(s.span_id)!; const p = s.parent_span_id ? byId.get(s.parent_span_id) : null; const v = p ? depth(p) + 1 : 0; d.set(s.span_id, v); return v; };
  spans.forEach(depth); return d;
}

/** Stage groups for the waterfall (docs/03). */
export function stageOf(name: string): string {
  if (/^(queue_wait|prepare|source_snapshot|hashing|ffprobe|decode_check|resize_transcode|playback_transcode)$/.test(name)) return 'Local preparation';
  if (/^twelvelabs\./.test(name)) return 'Provider ingestion';
  if (/^(pegasus\.|response_receive|parse_and_validate)/.test(name)) return 'Discover';
  if (/^(ontology\.|recognition_profiles|candidate_compare|reference_search)/.test(name)) return 'Compare';
  if (/^(planner_request|code_validation|execution_segment|tool_call|denied_tool_call|reviewed_program)$/.test(name) || /^gemini\.planner/.test(name)) return 'Orchestration';
  if (/^(protocol_query|capability_compile|frame_extract|gemini\.|followup)/.test(name)) return 'Inspect';
  if (/^(assess|finding_validate|rubric_eligibility|scoring|drill_filter|claim_check)$/.test(name)) return 'Assess';
  if (/^(report|template_assemble|json_write|html_write|csv_write|pdf_export|final_persist)$/.test(name)) return 'Report';
  if (/^(retry_backoff|timeout|cache_lookup|cache_hit|resume|cleanup)$/.test(name)) return 'Recovery';
  return 'Run';
}

function waterfall(spans: SpanRecord[], wall: number): string {
  if (!spans.length) return '<p class="muted">No spans recorded.</p>';
  const rows = summarise(spans).rows.sort((a, b) => a.start_offset_ms - b.start_offset_ms);
  const depth = depthMap(spans);
  const W = Math.max(wall, 1);
  return `<div class="scroll"><table><tr><th>Span</th><th>Stage</th><th>Waterfall (0 – ${ms(W)})</th><th>Inclusive</th><th>Self</th><th>Status</th></tr>${rows.map((r) => `<tr><td style="padding-left:${8 + (depth.get(r.span_id) ?? 0) * 14}px"><code>${esc(r.name)}</code>${r.attributes?.attempt ? ` <span class="small muted">#${esc(r.attributes.attempt)}</span>` : ''}</td><td class="small">${esc(stageOf(r.name))}</td><td><div class="wf" title="${esc(r.name)} ${ms(r.start_offset_ms)}–${ms(r.end_offset_ms)}"><span class="${r.status === 'error' ? 'error' : 'ok'}${PROVIDER_SPANS.test(r.name) ? ' provider' : ''}" style="left:${((r.start_offset_ms / W) * 100).toFixed(2)}%;width:${Math.max(0.3, (r.duration_ms / W) * 100).toFixed(2)}%"></span></div></td><td>${ms(r.duration_ms)}</td><td>${ms(r.self_ms)}</td><td>${pill(r.status)}</td></tr>`).join('')}</table></div>`;
}

export function renderConsole(o: { run: RunRow; db: LabDb; related: RunRow[] }): string {
  const { run, db } = o;
  const dir = run.run_dir;
  const spans = readSpans(join(dir, 'trace.jsonl'));
  const sum = summarise(spans);
  const manifest = j(join(dir, 'manifest.json'));
  const calls: CallRecord[] = existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : db.calls(run.run_id);
  const internal = j(join(dir, 'assessment.internal.json'));
  const diag = j(join(dir, 'diagnostic.json'));
  const code = j(join(dir, 'codemode.json'));
  const report = j(join(dir, 'report.json'));
  const media = j(join(dir, 'media.manifest.json'));
  const evidenceIdx = j(join(dir, 'evidence.index.json')) ?? [];
  const cache = j(join(dir, 'cache.json'));
  const cost = manifest?.cost ?? runCost(calls);
  const artifacts = existsSync(join(dir, 'artifacts')) ? readdirSync(join(dir, 'artifacts')).sort() : [];
  const a = internal?.assessment;
  const events = db.events(run.run_id);
  const feedback = db.feedback(run.run_id);
  const answered = a ? a.answers.filter((x: any) => x.source === 'protocol' && (x.state === 'supported' || x.state === 'contradicted')).length : null;
  const totalQ = a ? a.answers.filter((x: any) => x.source === 'protocol').length : null;
  const framesSent = (internal?.inspections ?? []).reduce((n: number, i: any) => n + i.frames, 0);
  const bytesSent = (internal?.inspections ?? []).reduce((n: number, i: any) => n + i.bytes, 0);
  const genCalls = calls.filter((c) => c.generation);
  const fixture = report?.provenance?.fixture || manifest?.provider_clients === 'offline-mock';

  const overview = `<div class="metrics">
    <div class="metric">Wall time<b>${ms(manifest?.wall_time_ms ?? run.wall_ms)}</b>root span elapsed (not a sum of spans)</div>
    <div class="metric">Outcome<b>${esc(run.outcome ?? run.state)}</b>${esc(run.error_kind ?? '')}</div>
    <div class="metric">Known cost subtotal<b>${cost.known_subtotal_usd === null ? 'Unknown' : `$${Number(cost.known_subtotal_usd).toFixed(4)}`}</b>${esc(cost.status)} · ${cost.unknown_components.length} unknown component(s)</div>
    <div class="metric">Provider attempts<b>${calls.length}</b>${genCalls.length} generation · ${calls.filter((c) => c.is_retry).length} retries · ${calls.filter((c) => c.cache_hit).length} cache hits</div>
    <div class="metric">Media<b>${media ? `${(media.source.bytes / 1048576).toFixed(1)} MB` : '—'}</b>source; prepared ${media ? `${(media.prepared.bytes / 1048576).toFixed(1)} MB` : '—'}</div>
    <div class="metric">Evidence sent<b>${framesSent} frames</b>${(bytesSent / 1024).toFixed(0)} KB inline</div>
    <div class="metric">Coverage<b>${answered === null ? '—' : `${answered}/${totalQ}`}</b>protocol questions assessed</div>
    <div class="metric">Mode / backend<b style="font-size:16px">${esc(run.mode)}</b>${esc(report?.provenance?.ontology?.backend ?? '—')} · ${esc(run.cache_kind)}</div></div>
    ${fixture ? '<div class="notice fixture"><strong>Offline fixture run.</strong> Provider clients were offline mocks; these results are not a real analysis.</div>' : ''}
    ${cache ? `<div class="notice">Result cache hit: report reused from <a href="/runs/${esc(cache.original_run)}/console">${esc(cache.original_run)}</a>. Not fresh perception; no new provider usage.</div>` : ''}
    ${diag ? `<div class="notice"><strong>Diagnostic:</strong> ${esc(diag.error?.kind)} — ${esc(diag.error?.message)}. ${esc(diag.note)}</div>` : ''}
    <h3>Unknown cost components</h3>${cost.unknown_components.length ? `<ul class="clean small">${cost.unknown_components.slice(0, 30).map((c: string) => `<li><code>${esc(c)}</code></li>`).join('')}</ul>` : '<p class="small muted">None.</p>'}<p class="small muted">${esc(cost.note ?? '')} Prices come from the account pricing table; null rates stay unknown, never zero.</p>
    <h3>Run states</h3><div class="scroll"><table><tr><th>Elapsed</th><th>State</th><th>Detail</th></tr>${events.map((e) => `<tr><td>${ms(e.elapsed_ms)}</td><td>${esc(e.state)}</td><td>${esc(e.detail ?? '')}</td></tr>`).join('')}</table></div>
    ${manifest?.budget ? `<h3>Budgets</h3>${pre(manifest.budget)}` : ''}`;

  const stages = stageUnion(spans);
  const stageRows = Object.entries(groupStages(spans)).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${ms(v.union)}</td><td>${ms(v.sum)}</td><td>${v.count}</td></tr>`).join('');
  const timeline = `<p class="small muted">Parallel work overlaps in the waterfall. Stage union durations remove overlap; span sums double-count and are not wall time. Upload, readiness waiting, local polling waits and request round-trips are separate spans; client-observed readiness is not provider processing time.</p>
    <h3>Stage union</h3><div class="scroll"><table><tr><th>Stage</th><th>Union</th><th>Sum of spans</th><th>Spans</th></tr>${stageRows}</table></div>
    <h3>Waterfall</h3>${waterfall(spans, sum.wall_time_ms)}
    <details><summary>Per-name aggregation</summary>${pre(stages)}</details>`;

  const disc = internal?.discovery;
  const discovery = disc ? `<h3>Candidates</h3><div class="scroll"><table><tr><th>#</th><th>Sport</th><th>Skill</th><th>Uncertainty</th><th>Supporting</th><th>Contradicting</th></tr>${disc.candidates.map((c: any) => `<tr><td>${c.rank}</td><td><code>${esc(c.sport_uid ?? 'out of catalogue')}</code></td><td><code>${esc(c.skill_uid ?? c.skill_label ?? '—')}</code></td><td>${esc(c.uncertainty)}</td><td>${esc(c.supporting_evidence.join('; '))}</td><td>${esc(c.contradicting_evidence.join('; '))}</td></tr>`).join('')}</table></div>
    <h3>Comparison decision</h3><ul class="clean">${(internal.compare?.reasons ?? []).map((r: string) => `<li>${esc(r)}</li>`).join('') || '<li class="muted">No conflicts.</li>'}</ul>
    <h3>Reasons for each additional inspection</h3><ul class="clean">${(internal.additional_inspection_reasons ?? []).map((r: string) => `<li>${esc(r)}</li>`).join('') || '<li class="muted">None.</li>'}</ul>
    <h3>Action windows (approximate)</h3>${pre(disc.action_windows)}<h3>Target</h3>${pre(disc.target)}<h3>Validation notes</h3>${pre(disc.notes)}<p class="small muted">Structured evidence only; no hidden chain-of-thought is requested or stored.</p>` : '<p class="muted">No discovery result.</p>';

  const inspections = (internal?.inspections ?? []).map((ins: any) => `<div class="card"><h3>${esc(ins.inspection_id)} ${ins.followup ? '<span class="badge">follow-up</span>' : ''}</h3>${ins.reason ? `<p class="small">Reason: ${esc(ins.reason)}</p>` : ''}<p class="small muted">Model ${esc(ins.model)} · ${ins.frames} frames · ${(ins.bytes / 1024).toFixed(0)} KB · packets ${esc(ins.packet_ids.join(', '))}</p>
    <div class="thumbs">${evidenceIdx.filter((p: any) => ins.packet_ids.includes(p.packet_id)).flatMap((p: any) => p.frames).slice(0, 24).map((f: any) => `<figure><img src="/evidence/${esc(run.run_id)}/${esc(f.evidence_id)}.jpg" alt="Frame ${esc(f.evidence_id)} at ${f.t.toFixed(3)} s" loading="lazy"><figcaption>${esc(f.evidence_id)} · ${f.t.toFixed(3)} s</figcaption></figure>`).join('')}</div>
    <p>Activity verdict: ${pill(ins.result.activity_verdict.state)} <code>${esc(ins.result.activity_verdict.sport_uid ?? 'none')}</code></p>
    <div class="scroll"><table><tr><th>Question</th><th>Answer</th><th>Visibility</th><th>State</th><th>Observation</th><th>Evidence</th></tr>${ins.result.answers.map((x: any) => `<tr><td><code class="small">${esc(x.question_id)}</code></td><td>${esc(x.answer ?? 'null')}</td><td>${esc(x.visibility)}</td><td>${pill(x.state)}</td><td>${esc(x.observation)}</td><td class="small">${esc(x.evidence_ids.join(', '))}</td></tr>`).join('')}</table></div>
    ${ins.result.rejected.length ? `<h3>Rejected</h3>${pre(ins.result.rejected)}` : ''}</div>`).join('') || '<p class="muted">No inspections.</p>';
  const exclusions = (internal?.plans ?? []).map((p: any) => `<details><summary>Capability exclusions for <code>${esc(p.protocol_uid)}</code> (${p.exclusions.length})</summary><div class="scroll"><table><tr><th>Kind</th><th>ID</th><th>Reason</th></tr>${p.exclusions.map((e: any) => `<tr><td>${esc(e.kind)}</td><td><code class="small">${esc(e.uid)}</code></td><td>${esc(e.reason)}</td></tr>`).join('')}</table></div></details>`).join('');
  const disagreements = a ? a.answers.filter((x: any) => x.disagreement) : [];

  const ontology = `<div class="kv"><div>Backend</div><div>${esc(report?.provenance?.ontology?.backend ?? '—')}</div><div>Graph</div><div><code>${esc(run.graph_name ?? '—')}</code></div><div>Source SHA-256</div><div><code>${esc(run.ontology_hash ?? '—')}</code></div><div>Image digest</div><div><code>${esc(report?.provenance?.ontology?.image_digest ?? 'unavailable')}</code></div><div>Recognition overlay</div><div>${esc(report?.provenance?.ontology?.recognition_overlay ?? '—')} (draft, not validated)</div></div>
    <h3>Protocols used and approval state</h3>${pre(internal?.protocols ?? [])}<p class="small muted">Ontology status/tier is not approval. Approval comes only from the local registry.</p>
    <h3>Retrieved IDs (typed read-only methods)</h3><div class="scroll"><table><tr><th>Method</th><th>Args</th><th>Returned</th><th>Time</th></tr>${(internal?.ontology_log ?? []).map((l: any) => `<tr><td><code>${esc(l.method)}</code></td><td class="small">${esc(JSON.stringify(l.args).slice(0, 160))}</td><td class="small">${l.returned_ids.length}: ${esc(l.returned_ids.slice(0, 12).join(', '))}${l.returned_ids.length > 12 ? '…' : ''}</td><td>${ms(l.ms)}</td></tr>`).join('')}</table></div>
    <h3>Query timings (fixed templates)</h3><div class="scroll"><table><tr><th>Primitive</th><th>Pattern</th><th>Rows</th><th>Time</th></tr>${(internal?.query_stats ?? []).map((q: any) => `<tr><td>${esc(q.primitive)}</td><td><code class="small">${esc(q.label)}</code></td><td>${q.rows}</td><td>${ms(q.ms)}</td></tr>`).join('')}</table></div>`;

  const requests = `<div class="scroll"><table><tr><th>Provider</th><th>Role</th><th>Model</th><th>Attempt</th><th>Outcome</th><th>Request ID</th><th>Finish</th><th>Usage</th><th>Cost</th><th>Time</th></tr>${calls.map((c) => `<tr><td>${esc(c.provider)}</td><td>${esc(c.role)}</td><td><code class="small">${esc(c.model ?? '—')}</code></td><td>${c.attempt}${c.is_retry ? ' (retry)' : ''}${c.cache_hit ? ' (cache)' : ''}</td><td>${pill(c.outcome)} ${esc(c.error_kind ?? '')}</td><td><code class="small">${esc(c.request_id ?? '—')}</code></td><td>${esc(c.finish_reason ?? '—')}</td><td class="small">${c.usage ? esc(Object.entries(c.usage).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join(' ')) : esc(c.usage_source)}</td><td class="small">${c.cost_usd === null ? esc(c.cost_status) : `$${c.cost_usd.toFixed(5)}`}</td><td>${ms(c.duration_ms)}</td></tr>`).join('')}</table></div>
    <h3>Redacted request/response artifacts</h3><ul class="clean small">${artifacts.map((f) => `<li><a href="/runs/${esc(run.run_id)}/artifacts/${encodeURIComponent(f)}">${esc(f)}</a></li>`).join('') || '<li class="muted">None.</li>'}</ul><p class="small muted">Keys and credential-bearing URLs are redacted. Image bytes are not stored in request artifacts; frames are referenced by evidence ID and hash.</p>`;

  const codeTab = code ? `<div class="kv"><div>Status</div><div>${pill(code.status)} ${esc(code.error ?? '')}</div><div>Executor</div><div>${esc(code.executor)} · ${esc(code.executor_version)} · Deno ${esc(code.deno_version ?? '—')}</div><div>Planner turns</div><div>${code.planner_turns}</div></div>
    <h3>Restriction self-test</h3>${pre(code.self_test)}
    <h3>Programs</h3>${code.programs.map((p: any) => `<details><summary>${esc(p.program_id)} · ${esc(p.origin)} · ${p.chars} chars ${p.validation_errors.length ? pill('rejected') : pill('accepted')}</summary>${p.planner_summary ? `<p class="small">Planner summary: ${esc(p.planner_summary)}</p>` : ''}${p.validation_errors.length ? pre(p.validation_errors) : ''}${artifactText(dir, p.artifact)}</details>`).join('')}
    <h3>Execution segments</h3><div class="scroll"><table><tr><th>Program</th><th>Segment</th><th>Status</th><th>Time</th><th>New calls</th><th>Replayed</th><th>Error</th></tr>${code.segments.map((s: any) => `<tr><td>${esc(s.program_id)}</td><td>${s.segment}</td><td>${pill(s.status)}</td><td>${ms(s.duration_ms)}</td><td>${s.tool_calls_new}</td><td>${s.replayed}</td><td class="small">${esc(s.error ?? '')}</td></tr>`).join('')}</table></div>
    <h3>Denied calls</h3>${pre(code.denied_calls)}` : `<p class="muted">${run.mode === 'ontology_fixed' ? 'ontology_fixed run: the reviewed program executed with the same tools; no generated orchestration.' : 'No Code Mode record.'}</p>`;
  const toolLog = internal?.tool_log ?? diag?.partial?.tool_log ?? [];
  const codeTab2 = `${codeTab}<h3>Executed tool calls</h3><div class="scroll"><table><tr><th>#</th><th>Tool</th><th>Origin</th><th>Segment</th><th>Status</th><th>Time</th><th>Error</th></tr>${toolLog.map((t: any) => `<tr><td>${t.seq}</td><td><code>${esc(t.tool)}</code></td><td>${esc(t.origin)}</td><td>${esc(t.segment ?? '—')}</td><td>${pill(t.status)}</td><td>${ms(t.ms)}</td><td class="small">${esc(t.error ?? '')}</td></tr>`).join('')}</table></div>`;

  const validation = a ? `<h3>Rejected claims</h3>${pre(a.validation.rejected_claims)}<h3>Withheld from athlete view</h3>${pre(a.withheld)}<h3>Score exclusions</h3>${pre(a.validation.score_exclusions)}<h3>Validation notes / missing references</h3>${pre(a.validation.notes)}<h3>Report assembly issues</h3>${pre(a.validation.issues)}<p>Report contract valid: ${pill(internal.contract_valid ? 'available' : 'failed')}</p><h3>Template fallbacks</h3>${pre(a.validation.template_fallbacks)}<h3>Inspector disagreements</h3>${pre(disagreements)}<h3>Internal draft drills (not prescribed)</h3><div class="scroll"><table><tr><th>Drill</th><th>Via</th><th>Excluded because</th></tr>${a.drills.internal_drafts.map((d: any) => `<tr><td>${esc(d.name)} <code class="small">${esc(d.uid)}</code></td><td class="small">${esc(d.drill.via.join('; '))}</td><td class="small">${esc(d.reasons.join('; '))}</td></tr>`).join('')}</table></div><p class="small muted">${esc(a.polarity_note)}</p>` : diag ? pre(diag) : '<p class="muted">No assessment.</p>';

  const compareRows = o.related.map((r) => { const m = j(join(r.run_dir, 'manifest.json')); const rep = j(join(r.run_dir, 'report.json')); const fb = db.feedback(r.run_id).length; return `<tr${r.run_id === run.run_id ? ' style="background:var(--pitch-tint)"' : ''}><td><a href="/runs/${esc(r.run_id)}/console">${esc(r.run_id)}</a></td><td>${esc(r.mode)}</td><td>${esc(r.label)}</td><td>${esc(r.cache_kind)}</td><td>${pill(r.outcome ?? r.state)}</td><td>${esc(rep?.activity?.sport_uid ?? '—')} (${esc(rep?.activity?.state ?? '—')})</td><td>${ms(r.wall_ms)}</td><td>${m?.cost?.known_subtotal_usd === null || m?.cost?.known_subtotal_usd === undefined ? 'unknown' : `$${Number(m.cost.known_subtotal_usd).toFixed(4)}`}</td><td>${fb}</td></tr>`; }).join('');
  const compare = `<p class="small muted">Same source clip across configurations. Cold, warm-asset, result-cache and resumed runs are different experiments. Scores from different rubrics/configurations are not charted as athletic progress.</p><div class="scroll"><table><tr><th>Run</th><th>Mode</th><th>Label</th><th>Cache</th><th>Outcome</th><th>Activity</th><th>Wall</th><th>Known cost</th><th>Reviews</th></tr>${compareRows}</table></div>
    <h3>Coach reviews for this run</h3>${pre(feedback)}`;

  const tabs: Array<[string, string, string]> = [['overview', 'Overview', overview], ['timeline', 'Timeline', timeline], ['discovery', 'Discovery / compare', discovery], ['inspection', 'Inspection', inspections + exclusions], ['ontology', 'Ontology', ontology], ['requests', 'Requests', requests], ['codemode', 'Code Mode', codeTab2], ['validation', 'Validation', validation], ['compare', 'Compare runs', compare]];
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Internal console ${esc(run.run_id)}</title><link rel="stylesheet" href="/brand/fonts/fonts.css"><link rel="stylesheet" href="/brand/tokens.css"><style>${BRAND_TOKENS}${LAB_CSS}</style></head><body><div class="wrap">
  <header class="top"><div class="brand"><img src="/brand/striideai-wordmark.svg" alt="StriideAi" width="168" height="38"><span class="endorse">by Striide</span></div><nav class="links"><a class="btn secondary" href="/">Runs</a>${existsSync(join(dir, 'athlete.json')) ? `<a class="btn" href="/runs/${esc(run.run_id)}/report">Athlete report</a>` : ''}</nav></header>
  <p class="eyebrow" style="margin-top:16px">Internal console · excluded from athlete exports</p><h1>Run ${esc(run.run_id)}</h1><p>${pill(run.outcome ?? run.state)} <span class="small muted">${esc(run.source_name)} · ${esc(run.created_at)}</span></p>
  <div class="tabs" role="tablist">${tabs.map(([id, label], i) => `<button type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${i === 0}">${esc(label)}</button>`).join('')}</div>
  ${tabs.map(([id, , body], i) => `<section class="panel card" role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}"${i ? ' hidden' : ''}>${body}</section>`).join('')}
  <div class="footer">Local research lab · internal telemetry · no secrets or credential-bearing URLs are stored.</div></div>
  <script>(() => { const tabs = [...document.querySelectorAll('[role=tab]')]; const show = (t) => { tabs.forEach((x) => { const on = x === t; x.setAttribute('aria-selected', on); document.getElementById(x.getAttribute('aria-controls')).hidden = !on; }); history.replaceState(null, '', '#' + t.id.slice(4)); };
  tabs.forEach((t, i) => { t.addEventListener('click', () => show(t)); t.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; n.focus(); show(n); } }); });
  const h = location.hash.slice(1); const t = h && document.getElementById('tab-' + h); if (t) show(t); })();</script></body></html>`;
}

function groupStages(spans: SpanRecord[]): Record<string, { union: number; sum: number; count: number }> {
  const g: Record<string, SpanRecord[]> = {};
  for (const s of spans) if (s.name !== 'run') (g[stageOf(s.name)] ??= []).push(s);
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { union: unionDuration(v.map((s) => [s.start_offset_ms, s.end_offset_ms] as [number, number])), sum: v.reduce((n, s) => n + s.duration_ms, 0), count: v.length }]));
}

function artifactText(dir: string, rel: string): string {
  const p = join(dir, rel);
  if (!/^artifacts\/[A-Za-z0-9_.-]+$/.test(rel) || !existsSync(p)) return '';
  return pre(readFileSync(p, 'utf8').slice(0, 40000));
}

export function renderDiagnosticNote(): string { return ''; }
