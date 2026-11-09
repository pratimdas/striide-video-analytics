import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { parseArgs, str, main } from './args.js';
import { loadConfig, missingInputs } from '../config/load.js';
import { TraceStore, summarise } from '../telemetry/trace.js';
import { Budget } from '../telemetry/budget.js';
import { loadPricing, runCost, type CallRecord } from '../telemetry/ledger.js';
import { makeArtifactWriter, type RunContext } from '../jobs/context.js';
import { TwelveLabsProvider, realTwelveLabsClient } from '../providers/twelvelabs.js';
import { GeminiProvider, realGeminiClient } from '../providers/gemini.js';
import { runProcess } from '../media/proc.js';
import { LabError, errorSummary } from '../util/errors.js';

/**
 * Explicit, billable live check. Uploads a small synthetic test-pattern clip (not sports footage),
 * waits for readiness, makes one Pegasus 1.6 request and one Gemini request per configured role,
 * then deletes the uploaded asset and verifies deletion. All calls, timings and usage are recorded.
 */
await main(async () => {
  const { flags } = parseArgs(process.argv.slice(2), ['config', 'video'], ['yes', 'keep-asset']);
  if (flags.help || flags.yes !== true) {
    console.log('npm run provider:smoke -- --config config.local.yaml --yes [--video path] [--keep-asset]\nThis makes billable TwelveLabs and Gemini requests with your keys. Pass --yes to confirm.');
    return flags.help ? 0 : 2;
  }
  const lc = loadConfig(str(flags, 'config', 'config.local.yaml'));
  const missing = missingInputs(lc, 'smoke');
  if (missing.length) throw new LabError('config', `Cannot run the live smoke test:\n  - ${missing.join('\n  - ')}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(lc.abs.outputRoot, '_smoke', stamp); mkdirSync(dir, { recursive: true });
  const trace = new TraceStore({ runId: `smoke-${stamp}`, outputFile: join(dir, 'trace.jsonl'), redactValues: lc.secretValues });
  const calls: CallRecord[] = [];
  const ctx: RunContext = { runId: `smoke-${stamp}`, runDir: dir, lc, trace, budget: new Budget({ ...lc.config.budgets, max_generated_model_requests: 3, max_generation_attempts_including_retries: 6 }, { ...lc.config.code_mode, max_planner_turns: 1 }), pricing: loadPricing(lc.abs.pricing), signal: new AbortController().signal, calls, artifact: makeArtifactWriter(dir, lc.secretValues, true) };
  const results: Record<string, unknown> = {};
  let clip = typeof flags.video === 'string' ? resolve(flags.video) : join(dir, 'smoke-testpattern.mp4');
  await trace.span('provider_smoke', { note: 'billable live check' }, async (root) => {
    if (typeof flags.video !== 'string') {
      const r = await runProcess(lc.env.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip], { timeoutMs: 60000 });
      if (r.code !== 0) throw new LabError('media', 'Could not generate the smoke-test clip');
    }
    const tl = new TwelveLabsProvider(realTwelveLabsClient(lc.env.twelvelabsKey!, lc.config.providers.twelvelabs.base_url), lc.config.providers.twelvelabs);
    try {
      const up = await tl.upload(ctx, root, clip, 'smoke-testpattern.mp4');
      const ready = await tl.waitReady(ctx, root, up.asset_id);
      results.twelvelabs_upload = { status: 'passed', polls: ready.polls, observed_wait_ms: Math.round(ready.observed_wait_ms) };
      ctx.budget.reserveModelRequest('discovery');
      const schema = { type: 'object', required: ['description', 'visible_objects'], properties: { description: { type: 'string' }, visible_objects: { type: 'array', items: { type: 'string' } } }, additionalProperties: false };
      const a = await tl.analyze(ctx, root, { assetId: up.asset_id, prompt: 'Describe this synthetic test video in one sentence and list visible objects. This is an access check.', schema, role: 'discovery', spanName: 'pegasus.smoke_request' });
      results.pegasus = { status: 'passed', model: lc.config.providers.twelvelabs.model, finish_reason: a.finish_reason, usage: a.usage, parsed_keys: Object.keys((a.parsed as object) ?? {}) };
      if (flags['keep-asset'] !== true) { const del = await tl.deleteAsset(ctx, root, up.asset_id); results.twelvelabs_delete = del; }
    } catch (e) { results.twelvelabs = { status: 'failed', error: errorSummary(e) }; }
    const gm = new GeminiProvider(realGeminiClient(lc.env.geminiKey!), lc.config.providers.gemini, { planner: lc.env.plannerModel, inspector: lc.env.inspectorModel });
    const frame = join(dir, 'smoke-frame.jpg');
    await runProcess(lc.env.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', '1', '-i', clip, '-frames:v', '1', '-vf', 'scale=320:-2', frame], { timeoutMs: 30000 });
    const schema = { type: 'object', required: ['description'], properties: { description: { type: 'string' } }, additionalProperties: false };
    for (const role of ['inspector', 'planner'] as const) {
      if (role === 'planner' && !lc.env.plannerModel) { results.gemini_planner = { status: 'unrun', reason: 'planner model not configured' }; continue; }
      try {
        ctx.budget.reserveModelRequest(role === 'planner' ? 'planner' : 'inspection');
        const r = await gm.generate(ctx, root, { role, system: 'Access check. Reply with the requested JSON only.', parts: [{ text: 'Describe the image in one short sentence.' }, { inlineData: { mimeType: 'image/jpeg', data: readFileSync(frame).toString('base64') } }], schema, spanName: `gemini.smoke_${role}`, maxOutputTokens: 256, artifactSummary: ['smoke-frame.jpg'] });
        results[`gemini_${role}`] = { status: 'passed', model: role === 'planner' ? lc.env.plannerModel : lc.env.inspectorModel, model_version: r.model_version, finish_reason: r.finish_reason, usage: r.usage };
      } catch (e) { results[`gemini_${role}`] = { status: 'failed', error: errorSummary(e) }; }
    }
  }).catch((e) => { results.fatal = errorSummary(e); });
  const summary = { results, wall_time_ms: summarise(trace.spans).wall_time_ms, calls: calls.length, cost: runCost(calls), trace: join(dir, 'trace.jsonl') };
  writeFileSync(join(dir, 'smoke.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(dir, 'calls.jsonl'), calls.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
  const failed = JSON.stringify(results).includes('"status":"failed"') || 'fatal' in results;
  return failed ? 1 : 0;
});
