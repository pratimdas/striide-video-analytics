import { parseArgs, str, main } from './args.js';
import { loadConfig } from '../config/load.js';
import { LabDb } from '../store/db.js';
import { JobRunner } from '../jobs/runner.js';
import { createApp } from '../server/app.js';

await main(async () => {
  const { flags } = parseArgs(process.argv.slice(2), ['config']);
  if (flags.help) { console.log('npm run ui -- --config config.local.yaml'); return 0; }
  const lc = loadConfig(str(flags, 'config', 'config.local.yaml'));
  const db = LabDb.open(lc.abs.outputRoot);
  const runner = new JobRunner(lc, db);
  runner.recoverCrashed();
  const server = createApp({ lc, db, runner });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(lc.config.server.port, lc.config.server.host, () => resolve()); });
  console.log(`StriideAi local lab UI: http://${lc.config.server.host}:${lc.config.server.port}/  (loopback only; Ctrl+C to stop)`);
  await new Promise<void>((resolve) => process.on('SIGINT', () => { server.close(); resolve(); }));
  db.close();
  return 0;
});
