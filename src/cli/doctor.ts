import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs, str, main } from './args.js';
import { loadConfig, missingInputs, loadEnvFile, type LoadedConfig } from '../config/load.js';
import { toolVersion, runProcess } from '../media/proc.js';
import { loadOntologySource } from '../ontology/source.js';
import { connectFalkor, composeImageDigest } from '../ontology/falkor-conn.js';
import { checkReadyImport } from '../ontology/importer.js';
import { loadApprovals, loadOverlay } from '../ontology/service.js';
import { loadPricing } from '../telemetry/ledger.js';
import { resolveDeno, sandboxSelfTest } from '../orchestration/codemode/executor.js';
import { listInputs } from '../server/app.js';
import { fromRoot } from '../util/paths.js';
import { errorSummary } from '../util/errors.js';

type Status = 'ok' | 'warn' | 'fail' | 'skip';
const results: Array<{ check: string; status: Status; detail: string }> = [];
const add = (check: string, status: Status, detail: string) => results.push({ check, status, detail });

async function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((r) => { const s = createServer(); s.once('error', () => r(false)); s.listen(port, host, () => s.close(() => r(true))); });
}

await main(async () => {
  const { flags } = parseArgs(process.argv.slice(2), ['config'], ['setup', 'json']);
  if (flags.help) { console.log('npm run doctor -- --config config.local.yaml [--setup] [--json]\nLocal checks only; no paid inference. --setup allows a database without a verified import.'); return 0; }
  const setup = flags.setup === true;
  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
  add('node', maj > 22 || (maj === 22 && min >= 13) ? 'ok' : 'fail', `Node ${process.versions.node} (requires >= 22.13 for node:sqlite and loadEnvFile)`);
  let lc: LoadedConfig | null = null;
  try { lc = loadConfig(str(flags, 'config', 'config.local.yaml')); add('config', 'ok', `valid; resolved-config hash ${lc.resolvedConfigHash.slice(0, 12)} (secrets excluded); mode ${lc.config.experiment.mode}`); }
  catch (e) { add('config', 'fail', errorSummary(e).message); loadEnvFile(); }

  if (lc) {
    const missing = missingInputs(lc, 'doctor');
    if (missing.length) add('inputs', 'fail', `missing for analysis (all listed):\n      - ${missing.join('\n      - ')}`); else add('inputs', 'ok', 'API keys and model IDs present (values not printed; access is verified only by provider:smoke)');
    const ff = await toolVersion(lc.env.ffmpeg); const fp = await toolVersion(lc.env.ffprobe);
    add('ffmpeg', ff ? 'ok' : 'fail', ff ?? `not runnable (${lc.env.ffmpeg})`);
    add('ffprobe', fp ? 'ok' : 'fail', fp ?? `not runnable (${lc.env.ffprobe})`);
    if (ff) { const enc = await runProcess(lc.env.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 15000 }); add('ffmpeg.libx264', /libx264/.test(enc.stdout.toString()) ? 'ok' : 'fail', /libx264/.test(enc.stdout.toString()) ? 'H.264 encoder available' : 'libx264 encoder missing (needed for provider/playback normalisation)'); }
    const deno = resolveDeno(lc.env.deno);
    const dv = await toolVersion(deno, ['--version']);
    add('deno', dv ? 'ok' : lc.config.code_mode.enabled ? 'fail' : 'warn', dv ? `${dv} (${deno.includes('node_modules') ? 'pinned npm package' : 'DENO_BIN'})` : `not runnable (${deno}); Code Mode cannot run`);
    if (dv) {
      const wd = join(lc.abs.outputRoot, '_doctor'); mkdirSync(wd, { recursive: true });
      const st = await sandboxSelfTest(deno, wd);
      add('code_mode.sandbox', st.ok ? 'ok' : 'fail', st.ok ? `restricted executor denies ${Object.keys(st.results).filter((k) => k !== 'broker').length} capabilities; broker reachable` : `${st.error}: ${JSON.stringify(st.results)}`);
    }
    try { mkdirSync(lc.abs.outputRoot, { recursive: true }); const t = join(lc.abs.outputRoot, '.doctor-write-test'); writeFileSync(t, 'x'); rmSync(t); add('output_root', 'ok', `${lc.config.paths.output_root} writable`); } catch (e) { add('output_root', 'fail', `not writable: ${(e as Error).message}`); }
    if (existsSync(lc.abs.inputRoot)) { try { accessSync(lc.abs.inputRoot, constants.R_OK); add('input_root', 'ok', `${listInputs(lc.abs.inputRoot).length} video file(s) registered under ${lc.config.paths.input_root}`); } catch { add('input_root', 'fail', 'not readable'); } }
    else add('input_root', 'warn', `${lc.config.paths.input_root} does not exist (the UI lists videos only from here; the CLI accepts explicit paths)`);
    let srcSha: string | null = null;
    try { const s = loadOntologySource(lc.abs.ontologyFile, fromRoot('data/ontology-manifest.json')); srcSha = s.sha256; add('ontology.source', 'ok', `sha256 ${s.sha256.slice(0, 16)}…, ${s.nodes.length} nodes, ${s.edges.length} relationships (matches bundled manifest)`); }
    catch (e) { add('ontology.source', 'fail', errorSummary(e).message); }
    try { const o = loadOverlay(lc.abs.overlay); add('ontology.overlay', 'ok', `recognition overlay ${o.version} (${o.review_status}; not validated)`); } catch (e) { add('ontology.overlay', 'fail', errorSummary(e).message); }
    try { const a = loadApprovals(lc.abs.approvedContent); add('approvals', 'ok', `${a.version}: ${a.approved_drill_uids.length} drills, ${a.approved_rubric_ids.length} rubrics approved${a.approved_rubric_ids.length ? '' : ' (scores stay unavailable)'}`); } catch (e) { add('approvals', 'fail', errorSummary(e).message); }
    try {
      const p = loadPricing(lc.abs.pricing);
      const nulls = Object.values(p.rates).flatMap((r) => Object.values(r)).filter((v) => v === null).length;
      if (lc.config.budgets.max_estimated_run_cost_usd !== null && nulls) add('pricing', 'fail', 'a monetary cap is configured but the pricing table is incomplete; costs cannot be conservatively bounded');
      else if (lc.config.budgets.require_known_prices && nulls) add('pricing', 'fail', 'require_known_prices is true but rates are missing');
      else add('pricing', nulls ? 'warn' : 'ok', `${p.version}: ${nulls} unknown rate(s); unknown costs are reported as unknown, never zero`);
    } catch (e) { add('pricing', 'fail', errorSummary(e).message); }
    if (lc.config.ontology.backend === 'falkordb') {
      try {
        const db = await connectFalkor(lc.env.falkor, lc.config.ontology.query_timeout_ms);
        add('falkordb.connect', 'ok', `connected to ${lc.env.falkor.host}:${lc.env.falkor.port}`);
        if (srcSha) {
          const r = await checkReadyImport(db, lc.abs.importManifest, srcSha);
          if (r.ok) add('ontology.import', 'ok', `graph ${r.manifest!.graph_name}: ${r.live_node_count} nodes / ${r.live_edge_count} relationships live; imported ${r.manifest!.imported_at}; image digest ${r.manifest!.image_digest ?? `unavailable (${r.manifest!.image_digest_reason})`}`);
          else add('ontology.import', setup ? 'warn' : 'fail', `${r.problems.join('; ')}${setup ? ' (allowed in --setup mode)' : ''}`);
        }
        await db.close();
      } catch (e) { add('falkordb.connect', 'fail', errorSummary(e).message); }
      const img = composeImageDigest();
      add('falkordb.image', img.digest ? 'ok' : 'warn', img.digest ? `${img.digest} — pin FALKORDB_IMAGE to this digest before comparable runs` : `digest unavailable: ${img.reason}`);
    } else add('ontology.backend', 'warn', 'json_snapshot backend selected: diagnostics only; analysis is refused');
    const free = await portFree(lc.config.server.host, lc.config.server.port);
    add('server.port', free ? 'ok' : 'warn', free ? `${lc.config.server.host}:${lc.config.server.port} available` : `${lc.config.server.port} in use (the UI may already be running)`);
    add('reference_search', 'ok', 'disabled (no curated index)');
    add('scoring', lc.config.assessment.experimental_scoring ? 'warn' : 'ok', lc.config.assessment.experimental_scoring ? 'experimental scoring enabled: scores still require an approved rubric' : 'disabled until a reviewed rubric is configured');
  }
  const d = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', shell: false, timeout: 15000 });
  add('docker', d.status === 0 ? 'ok' : 'warn', d.status === 0 ? `Docker server ${d.stdout.trim()}` : 'Docker not reachable (needed for the local FalkorDB container)');

  if (flags.json) console.log(JSON.stringify(results, null, 2));
  else {
    console.log('StriideAi local lab doctor (no paid inference)\n');
    for (const r of results) console.log(`${r.status === 'ok' ? 'OK  ' : r.status === 'warn' ? 'WARN' : r.status === 'skip' ? 'SKIP' : 'FAIL'}  ${r.check.padEnd(20)} ${r.detail}`);
  }
  const failed = results.filter((r) => r.status === 'fail');
  console.log(`\n${failed.length ? `${failed.length} check(s) failed.` : 'All required checks passed.'}`);
  return failed.length ? 1 : 0;
});
void readFileSync;
