import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, str, main } from './args.js';
import { loadConfig } from '../config/load.js';
import { LabDb } from '../store/db.js';
import { TraceStore } from '../telemetry/trace.js';
import { Budget } from '../telemetry/budget.js';
import { loadPricing, type CallRecord } from '../telemetry/ledger.js';
import { makeArtifactWriter, type RunContext } from '../jobs/context.js';
import { TwelveLabsProvider, realTwelveLabsClient, accountFingerprint } from '../providers/twelvelabs.js';
import { LabError } from '../util/errors.js';
import { PROJECT_ROOT } from '../util/paths.js';

/**
 * Cleanup of local caches and provider assets this lab uploaded. Only assets recorded in the local
 * asset registry for the current account fingerprint are touched, and each deletion is verified.
 */
await main(async () => {
  const { flags } = parseArgs(process.argv.slice(2), ['config'], ['local-cache', 'provider-assets', 'dry-run', 'yes']);
  if (flags.help || (!flags['local-cache'] && !flags['provider-assets'])) { console.log('npm run cleanup -- --config config.local.yaml [--local-cache] [--provider-assets --yes] [--dry-run]'); return flags.help ? 0 : 2; }
  const lc = loadConfig(str(flags, 'config', 'config.local.yaml'));
  const db = LabDb.open(lc.abs.outputRoot);
  const dry = flags['dry-run'] === true;
  const report: Record<string, unknown> = { dry_run: dry };
  if (flags['local-cache']) {
    report.result_cache_entries_cleared = dry ? 'not cleared (dry run)' : db.clearResultCache();
    const denoCache = join(PROJECT_ROOT, '.cache', 'deno');
    if (existsSync(denoCache) && !dry) rmSync(denoCache, { recursive: true, force: true });
    report.note = 'Run folders are immutable records and are not deleted by cleanup.';
  }
  if (flags['provider-assets']) {
    if (!lc.env.twelvelabsKey) throw new LabError('config', 'TWELVE_LABS_API_KEY is required to delete provider assets');
    const owned = db.ownedAssets('twelvelabs', accountFingerprint(lc.env.twelvelabsKey));
    report.owned_assets = owned.length;
    if (!dry) {
      if (flags.yes !== true) throw new LabError('config', 'Pass --yes to delete provider assets');
      const runDir = join(lc.abs.outputRoot, '_cleanup', new Date().toISOString().replace(/[:.]/g, '-'));
      const calls: CallRecord[] = [];
      const ctx: RunContext = { runId: 'cleanup', runDir, lc, trace: new TraceStore({ runId: 'cleanup', outputFile: join(runDir, 'trace.jsonl'), redactValues: lc.secretValues }), budget: new Budget(lc.config.budgets, lc.config.code_mode), pricing: loadPricing(lc.abs.pricing), signal: new AbortController().signal, calls, artifact: makeArtifactWriter(runDir, lc.secretValues, false) };
      const tl = new TwelveLabsProvider(realTwelveLabsClient(lc.env.twelvelabsKey, lc.config.providers.twelvelabs.base_url), lc.config.providers.twelvelabs);
      const results: Array<{ owner_run: string; deleted: boolean; status: string }> = [];
      await ctx.trace.span('cleanup', { assets: owned.length }, async (root) => {
        for (const a of owned) {
          const r = await tl.deleteAsset(ctx, root, a.asset_id);
          if (r.deleted) db.markAssetDeleted(a.asset_id, r.status);
          results.push({ owner_run: a.owner_run, deleted: r.deleted, status: r.status });
        }
      });
      report.deletions = results;
    }
  }
  console.log(JSON.stringify(report, null, 2));
  db.close();
  return 0;
});
