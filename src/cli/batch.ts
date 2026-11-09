import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { parseArgs, str, main } from './args.js';
import { loadConfig } from '../config/load.js';
import { LabDb } from '../store/db.js';
import { JobRunner } from '../jobs/runner.js';
import { LabError } from '../util/errors.js';
import { toCsv } from '../util/csv.js';
import { aggregateRuns } from '../telemetry/aggregate.js';
import type { DeclaredContext } from '../orchestration/prompts.js';

interface Case { case_id: string; video: string; context: Partial<DeclaredContext> | null; expected_activity?: string | null; review_notes?: string }

/**
 * Batch evaluation. Expected labels and review notes stay in the batch record only; they are never passed to
 * providers, prompts or filenames. Activity agreement is a heuristic flag for coach review, not ground truth.
 */
await main(async () => {
  const { flags } = parseArgs(process.argv.slice(2), ['config', 'manifest', 'repeat', 'modes'], ['no-result-cache']);
  if (flags.help) { console.log('npm run batch -- --config config.local.yaml --manifest evaluation/cases.example.json [--modes ontology_fixed,ontology_code] [--repeat 1] [--no-result-cache]'); return 0; }
  const lc = loadConfig(str(flags, 'config', 'config.local.yaml'));
  const manifest = JSON.parse(readFileSync(resolve(str(flags, 'manifest')), 'utf8'));
  if (manifest.labels_are_not_model_inputs !== true) throw new LabError('config', 'Manifest must declare labels_are_not_model_inputs: true');
  const modes = (typeof flags.modes === 'string' ? flags.modes : lc.config.experiment.mode).split(',').map((s) => s.trim());
  for (const m of modes) if (!['ontology_fixed', 'ontology_code'].includes(m)) throw new LabError('config', `Unknown mode ${m}`);
  const repeat = Math.max(1, Math.min(10, Number(flags.repeat ?? 1)));
  const db = LabDb.open(lc.abs.outputRoot);
  const runner = new JobRunner(lc, db);
  runner.recoverCrashed();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join(lc.abs.outputRoot, '_batch', stamp); mkdirSync(out, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  for (const c of manifest.cases as Case[]) {
    const video = isAbsolute(c.video) ? c.video : join(lc.abs.inputRoot, c.video);
    for (const mode of modes) for (let i = 1; i <= repeat; i++) {
      if (!existsSync(video)) { rows.push({ case_id: c.case_id, mode, repeat: i, run_id: null, outcome: 'missing_video', note: `video not found under the input root: ${c.video}` }); console.log(`${c.case_id}: missing video (${c.video})`); continue; }
      lc.config.experiment.mode = mode as any;
      const ctx = c.context ? ({ sport: null, discipline: null, skill: null, format: null, age_years: null, athlete_id: null, target_person_hint: null, goal: null, handedness: null, ball_type: null, consent_confirmed: false, ...c.context } as DeclaredContext) : null;
      console.log(`${c.case_id} [${mode} #${i}] running…`);
      const r = await runner.run({ videoPath: video, caseId: c.case_id, context: ctx, disableResultCache: flags['no-result-cache'] === true || i > 1 });
      const rep = existsSync(join(r.runDir, 'report.json')) ? JSON.parse(readFileSync(join(r.runDir, 'report.json'), 'utf8')) : null;
      const m = JSON.parse(readFileSync(join(r.runDir, 'manifest.json'), 'utf8'));
      const predicted = rep?.activity?.sport_uid ?? null;
      const exp = c.expected_activity ?? null;
      const agree = exp === null ? (predicted === null ? 'abstained_on_unlabelled' : 'unlabelled') : predicted === null ? 'abstained' : exp.toLowerCase().includes(String(predicted).replace(/^sport:/, '').replace(/_/g, ' ')) ? 'heuristic_match' : 'heuristic_mismatch';
      rows.push({ case_id: c.case_id, mode, repeat: i, run_id: r.runId, outcome: r.outcome, error_kind: r.error?.kind ?? null, cache_kind: db.getRun(r.runId)?.cache_kind, predicted_sport: predicted, activity_state: rep?.activity?.state ?? null, expected_activity: exp, agreement_flag: agree, wall_ms: m.wall_time_ms, known_cost_usd: m.cost.known_subtotal_usd, cost_status: m.cost.status, followups: m.budget.followup_model_requests, generated_requests: m.budget.generated_model_requests, review_notes: c.review_notes ?? '' });
      console.log(`  -> ${r.outcome}${r.error ? ` (${r.error.kind})` : ''} ${r.runId}`);
    }
  }
  const runIds = rows.map((r) => r.run_id).filter((x): x is string => typeof x === 'string');
  const agg = aggregateRuns(db, runIds);
  writeFileSync(join(out, 'batch.json'), JSON.stringify({ manifest: str(flags, 'manifest'), modes, repeat, rows, aggregate: agg, note: 'Agreement flags are string heuristics for coach review, not accuracy. Labels were not provided to any model.' }, null, 2));
  writeFileSync(join(out, 'batch.csv'), toCsv(Object.keys(rows[0] ?? { case_id: '' }), rows));
  console.log(JSON.stringify({ batch_dir: out, runs: runIds.length, missing: rows.filter((r) => r.outcome === 'missing_video').length, aggregate: { completed_runs: agg.completed_runs, failure_rate: agg.failure_rate, stage_note: agg.note } }, null, 2));
  db.close();
  return 0;
});
