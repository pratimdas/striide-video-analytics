import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LabDb, RunRow } from '../store/db.js';
import { readSpans, unionDuration } from './trace.js';
import { stageOf } from '../report/console-html.js';

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const pos = (s.length - 1) * q; const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Optimisation dashboard aggregates over a stated set of runs (median / p95 per stage, coverage, failure rate). */
export function aggregateRuns(db: LabDb, runIds?: string[]) {
  const runs = (runIds ? runIds.map((id) => db.getRun(id)).filter((r): r is RunRow => !!r) : db.listRuns(500));
  const completed = runs.filter((r) => r.outcome === 'completed' || r.outcome === 'completed_partial' || r.outcome === 'needs_context');
  const fresh = completed.filter((r) => r.cache_kind !== 'result_cache_hit');
  const stageVals: Record<string, number[]> = {};
  let uploads = 0, warm = 0, followupRuns = 0, knownCostRuns = 0, coverage: number[] = [];
  const groups: Record<string, { runs: number; wall: number[] }> = {};
  for (const r of fresh) {
    const spans = readSpans(join(r.run_dir, 'trace.jsonl'));
    const by: Record<string, Array<[number, number]>> = {};
    for (const s of spans) if (s.name !== 'run') (by[stageOf(s.name)] ??= []).push([s.start_offset_ms, s.end_offset_ms]);
    for (const [k, v] of Object.entries(by)) (stageVals[k] ??= []).push(unionDuration(v));
    uploads += spans.filter((s) => s.name === 'twelvelabs.upload' && s.status === 'ok').length;
    if (r.cache_kind === 'warm_asset') warm++;
    const m = existsSync(join(r.run_dir, 'manifest.json')) ? JSON.parse(readFileSync(join(r.run_dir, 'manifest.json'), 'utf8')) : null;
    if (m?.budget?.followup_model_requests > 0) followupRuns++;
    if (m?.cost?.status === 'estimated') knownCostRuns++;
    const rep = existsSync(join(r.run_dir, 'report.json')) ? JSON.parse(readFileSync(join(r.run_dir, 'report.json'), 'utf8')) : null;
    const cov = rep?.sections?.criterion_breakdown?.coverage; if (cov?.protocol_questions) coverage.push(cov.assessed / cov.protocol_questions);
    const key = `${r.mode} · ${r.cache_kind} · ontology ${String(r.ontology_hash ?? '').slice(0, 8)}`;
    (groups[key] ??= { runs: 0, wall: [] }).runs++; if (r.wall_ms) groups[key]!.wall.push(r.wall_ms);
  }
  const stages = Object.fromEntries(Object.entries(stageVals).map(([k, v]) => [k, { n: v.length, median_ms: quantile(v, 0.5), p95_ms: quantile(v, 0.95) }]));
  const suggestions: string[] = [];
  if (fresh.length && uploads >= fresh.length && warm === 0) suggestions.push('Every run uploaded its media; enable or check provider-upload reuse for repeated clips (warm asset reuse).');
  if (followupRuns / Math.max(1, fresh.length) > 0.5) suggestions.push('Most runs needed a follow-up inspection; consider denser first-pass evidence or better recognition questions — evaluate against recognition quality before changing.');
  const ins = stages['Inspect']?.median_ms ?? 0, ing = stages['Provider ingestion']?.median_ms ?? 0;
  if (ing > ins && ing > 0) suggestions.push('Provider ingestion dominates; reuse ready assets and keep optional HLS/thumbnails disabled. Readiness time is client-observed, not provider compute.');
  if ((stages['Compare']?.median_ms ?? 0) > 1000) suggestions.push('Graph context retrieval is slow; cache catalogue/protocol context keyed by graph hash.');
  return {
    total_runs: runs.length, completed_runs: completed.length, fresh_completed_runs: fresh.length, failure_rate: runs.length ? runs.filter((r) => r.outcome === 'failed' || r.outcome === 'rejected').length / runs.length : null,
    additional_inspection_rate: fresh.length ? followupRuns / fresh.length : null, known_cost_coverage: fresh.length ? knownCostRuns / fresh.length : null,
    accepted_report_coverage_median: quantile(coverage, 0.5), stages, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { runs: v.runs, wall_median_ms: quantile(v.wall, 0.5), wall_p95_ms: quantile(v.wall, 0.95) }])),
    suggestions, note: `Statistics over ${fresh.length} fresh completed run(s); small samples (e.g. p95 of three clips) are not stable production evidence. Result-cache hits are excluded.`,
  };
}
