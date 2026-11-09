import { resolve } from 'node:path';
import { parseArgs, str, main } from './args.js';
import { loadConfig } from '../config/load.js';
import { LabDb } from '../store/db.js';
import { JobRunner, loadContext } from '../jobs/runner.js';
import { LabError } from '../util/errors.js';

await main(async () => {
  const { flags } = parseArgs(process.argv.slice(2), ['config', 'video', 'context', 'case-id', 'resume', 'mode'], ['no-result-cache']);
  if (flags.help) { console.log('npm run analyse -- --config config.local.yaml --video "C:/StriideAiLab/videos/clip.mp4" [--context context.local.json] [--resume <run_id>] [--no-result-cache]'); return 0; }
  const lc = loadConfig(str(flags, 'config', 'config.local.yaml'));
  if (typeof flags.mode === 'string') { if (!['ontology_fixed', 'ontology_code'].includes(flags.mode)) throw new LabError('config', '--mode must be ontology_fixed or ontology_code'); lc.config.experiment.mode = flags.mode as any; }
  const db = LabDb.open(lc.abs.outputRoot);
  const runner = new JobRunner(lc, db);
  const crashed = runner.recoverCrashed();
  if (crashed.length) console.log(`Recovered ${crashed.length} interrupted run(s) as failed/interrupted: ${crashed.join(', ')}`);
  runner.on('state', (e) => { if (e.state !== 'finished') console.log(`[${(e.elapsed_ms / 1000).toFixed(1)} s] ${e.state}${e.detail ? ` — ${e.detail}` : ''}`); });
  process.on('SIGINT', () => { for (const r of db.unfinishedRuns()) runner.cancel(r.run_id); });
  const context = typeof flags.context === 'string' ? loadContext(resolve(flags.context)) : undefined;
  const r = await runner.run({ videoPath: resolve(str(flags, 'video')), context, caseId: typeof flags['case-id'] === 'string' ? flags['case-id'] : null, resumeFrom: typeof flags.resume === 'string' ? flags.resume : null, disableResultCache: flags['no-result-cache'] === true });
  console.log(JSON.stringify({ run_id: r.runId, outcome: r.outcome, error: r.error, run_dir: r.runDir, report: r.reportPath, view: `npm run ui -- --config ${str(flags, 'config', 'config.local.yaml')}  then open http://${lc.config.server.host}:${lc.config.server.port}/runs/${r.runId}/report` }, null, 2));
  db.close();
  return r.outcome === 'failed' || r.outcome === 'rejected' ? 1 : 0;
});
