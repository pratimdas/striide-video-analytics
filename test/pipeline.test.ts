import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadEnvFile } from '../src/config/load.js';
import { LabDb } from '../src/store/db.js';
import { JobRunner } from '../src/jobs/runner.js';
import { readSpans } from '../src/telemetry/trace.js';
import { validateContract } from '../src/contracts.js';
import { connectFalkor } from '../src/ontology/falkor-conn.js';
import { fromRoot } from '../src/util/paths.js';
import { mockGemini, mockTwelveLabs, cricketDiscovery, HttpError } from './mocks.js';
import { makeFixtureClip, tmp, writeTestConfig } from './helpers.js';

loadEnvFile();
const manifest = fromRoot('data/ontology-import.local.json');
let skip: string | false = false;
if (!existsSync(manifest)) skip = 'no verified ontology import (run npm run ontology:import); pipeline tests skipped';
else { try { const db = await connectFalkor({ host: process.env.FALKORDB_HOST ?? null, port: Number(process.env.FALKORDB_PORT), username: process.env.FALKORDB_USERNAME || null, password: process.env.FALKORDB_PASSWORD || null, tls: false }, 2000); await db.close(); } catch { skip = 'FalkorDB not reachable; pipeline tests skipped'; } }

// Labels for the mocked models only (never real model IDs).
process.env.GEMINI_INSPECTOR_MODEL = 'gemini-offline-mock-inspector';
process.env.GEMINI_PLANNER_MODEL = 'gemini-offline-mock-planner';
const FAKE_SECRET = 'sk-test-SECRET-should-never-appear-123456';
process.env.GEMINI_API_KEY = FAKE_SECRET; process.env.TWELVE_LABS_API_KEY = FAKE_SECRET + '-tl';

async function setup(patch: (c: any) => void = () => {}) {
  const dir = tmp('pipe-');
  const cfg = writeTestConfig(dir, (c) => { c.ontology.import_manifest = manifest; c.experiment.mode = 'ontology_fixed'; c.providers.twelvelabs.poll_interval_ms = 250; c.budgets.max_job_wall_time_ms = 120000; patch(c); });
  const lc = loadConfig(cfg);
  const clip = await makeFixtureClip(join(dir, 'inputs'), { name: 'clip.mp4', frames: 90, width: 640, height: 360, vfr: false, audio: true });
  const db = new LabDb(join(dir, 'runs', 'lab.sqlite'));
  return { dir, lc, clip, db };
}

function readJson(p: string) { return JSON.parse(readFileSync(p, 'utf8')); }

test('fixed mode end-to-end with offline mocks: contract-valid report, honest sections, separate athlete export', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const tl = mockTwelveLabs(); const gm = mockGemini();
  const r = await new JobRunner(lc, db, { twelvelabs: tl.client, gemini: gm.client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.ok(['completed', 'completed_partial'].includes(r.outcome), r.outcome);
  const report = readJson(join(r.runDir, 'report.json'));
  assert.deepEqual(validateContract('lab-contract', report).errors, []);
  assert.equal(report.scores.overall, null, 'no reviewed rubric means no score');
  assert.equal(report.scores.eligible, false);
  assert.equal(report.sections.radar.state, 'not_available');
  assert.equal(report.provenance.provider_clients, 'offline-mock');
  for (const k of ['header', 'video_and_context', 'summary', 'overall_grade', 'criterion_breakdown', 'radar', 'strengths', 'priorities', 'action_timeline', 'detailed_findings', 'technique', 'tactics_and_outcomes', 'strength_mental_nutrition', 'drills_and_content', 'next_session_plan', 'limitations', 'recording_guidance', 'review_and_feedback']) assert.ok(report.sections[k]?.state, `section ${k} present with explicit state`);
  assert.equal(report.sections.strength_mental_nutrition.state, 'not_inferred');
  assert.equal(report.sections.drills_and_content.state, 'review_needed', 'draft drills are not prescribed');
  assert.ok(report.limitations.some((l: string) => /numeric measurement/.test(l)), 'pose metrics unavailable is explained');
  // Provider transport: neutral filename, HLS/thumbnails disabled, explicit Pegasus 1.6, asset_id video reference.
  assert.ok(tl.log.some((l) => /^create:clip-[0-9a-f]{12}\.mp4:direct:hls=false$/.test(l)), tl.log.join(' | '));
  assert.ok(tl.log.some((l) => l.startsWith('analyze:pegasus1.6:asset_id:asset-mock-1')));
  // Inspection received actual frames.
  assert.ok(gm.log[0]!.evidence.length > 0);
  // Required spans and separate upload / readiness / polling.
  const spans = readSpans(join(r.runDir, 'trace.jsonl'));
  const names = new Set(spans.map((s) => s.name));
  for (const n of ['run', 'queue_wait', 'source_snapshot', 'hashing', 'ffprobe', 'decode_check', 'twelvelabs.upload', 'twelvelabs.asset_ready_wait', 'twelvelabs.readiness_attempt', 'twelvelabs.poll_wait', 'pegasus.discovery', 'response_receive', 'parse_and_validate', 'ontology.catalogue', 'recognition_profiles', 'candidate_compare', 'protocol_query', 'capability_compile', 'frame_extract', 'gemini.inspect', 'finding_validate', 'rubric_eligibility', 'scoring', 'drill_filter', 'claim_check', 'template_assemble', 'json_write', 'html_write', 'csv_write', 'tool_call']) assert.ok(names.has(n), `span ${n}`);
  for (const s of spans) assert.deepEqual(validateContract('trace-span', s).errors, [], `span ${s.name} matches the contract`);
  const raw = readFileSync(join(r.runDir, 'trace.jsonl'), 'utf8');
  assert.ok(raw.includes('"event":"span_start"'), 'start events are emitted');
  // Cost stays unknown with the unset pricing table; usage is still recorded.
  const m = readJson(join(r.runDir, 'manifest.json'));
  assert.equal(m.cost.status, 'unknown'); assert.equal(m.cost.known_subtotal_usd, null);
  const calls = readFileSync(join(r.runDir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.some((c) => c.role === 'discovery' && c.usage?.input_tokens === 1200 && c.cost_usd === null));
  // Root wall time is the root span's elapsed time, not a sum of spans.
  const root = spans.find((s) => s.name === 'run')!;
  assert.ok(Math.abs(m.wall_time_ms - root.duration_ms) < 1);
  assert.ok(spans.reduce((n, s) => n + s.duration_ms, 0) > m.wall_time_ms);
});

test('athlete exports exclude secrets, paths, telemetry and raw provider output', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs().client, gemini: mockGemini().client, label: 'offline-mock' }).run({ videoPath: clip });
  for (const f of ['athlete.json', 'athlete.html', 'athlete.csv']) {
    const s = readFileSync(join(r.runDir, f), 'utf8');
    assert.ok(!s.includes(FAKE_SECRET), `${f} has no secret`);
    assert.ok(!s.includes(r.runDir) && !/\/tmp\/|\/home\/|[A-Z]:\\\\/.test(s), `${f} has no filesystem paths`);
    for (const word of ['asset-mock-1', 'pegasus-mock', 'span_id', 'trace_id', 'gemini-offline-mock', 'request_id', 'prompt_sha256', 'cost_usd']) assert.ok(!s.includes(word), `${f} excludes ${word}`);
  }
  // Internal artifacts are redacted too.
  for (const f of ['trace.jsonl', 'calls.jsonl', 'manifest.json']) assert.ok(!readFileSync(join(r.runDir, f), 'utf8').includes(FAKE_SECRET), `${f} redacted`);
});

test('readiness failure terminates with a typed outcome, diagnostic page data and full trace', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs({ readiness: ['processing', 'failed'] }).client, gemini: mockGemini().client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.outcome, 'failed'); assert.equal(r.error?.kind, 'provider_asset_failed');
  assert.equal(existsSync(join(r.runDir, 'report.json')), false, 'no fabricated report');
  assert.ok(existsSync(join(r.runDir, 'diagnostic.json')));
  const spans = readSpans(join(r.runDir, 'trace.jsonl'));
  assert.equal(spans.filter((s) => s.name === 'twelvelabs.readiness_attempt').length, 2);
  assert.equal(spans.filter((s) => s.name === 'twelvelabs.poll_wait').length, 1);
  assert.equal(spans.find((s) => s.name === 'twelvelabs.asset_ready_wait')!.status, 'error');
});

test('readiness timeout terminates within the deadline', { skip }, async () => {
  const { lc, clip, db } = await setup((c) => { c.providers.twelvelabs.readiness_timeout_ms = 1200; c.providers.twelvelabs.poll_interval_ms = 300; });
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs({ readiness: ['processing'] }).client, gemini: mockGemini().client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.error?.kind, 'provider_readiness_timeout');
  const spans = readSpans(join(r.runDir, 'trace.jsonl'));
  assert.ok(spans.filter((s) => s.name === 'twelvelabs.readiness_attempt').length >= 3);
});

test('429 is retried within budget; retries are separate attempts with backoff spans and unknown cost', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs({ analyzeErrors: [new HttpError(429)] }).client, gemini: mockGemini().client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.error, null, JSON.stringify(r.error));
  const calls = readFileSync(join(r.runDir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.role === 'discovery');
  assert.equal(calls.length, 2); assert.equal(calls[0].error_kind, 'provider_rate_limited'); assert.equal(calls[0].cost_status, 'unknown'); assert.equal(calls[1].is_retry, true);
  assert.ok(readSpans(join(r.runDir, 'trace.jsonl')).some((s) => s.name === 'retry_backoff'));
  const m = readJson(join(r.runDir, 'manifest.json'));
  assert.ok(m.cost.unknown_components.length >= 3, 'failed attempt counted as an unknown cost component');
});

test('5xx beyond the retry budget fails with provider_server, not a report', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs({ analyzeErrors: [new HttpError(503), new HttpError(503)] }).client, gemini: mockGemini().client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.error?.kind, 'provider_server');
  assert.equal(existsSync(join(r.runDir, 'report.json')), false);
});

test('truncated Pegasus output is not used', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs({ finishReason: 'length' }).client, gemini: mockGemini().client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.error?.kind, 'model_truncated');
});

test('conflicting sport label: recognition questions and a bounded follow-up; no irrelevant drills', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const gm = mockGemini({ verdict: (call, cands) => (call === 1 ? { sport_uid: null, state: 'unknown' } : { sport_uid: 'sport:cricket', state: 'established' }) });
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs({ discovery: cricketDiscovery({ conflict: true }) }).client, gemini: gm.client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.ok(gm.log[0]!.questions.some((q) => q.startsWith('overlay:netball')), 'netball recognition question asked');
  assert.equal(gm.log.filter((l) => l.role === 'inspector').length, 2, 'one follow-up inspection');
  const internal = readJson(join(r.runDir, 'assessment.internal.json'));
  assert.ok(internal.additional_inspection_reasons.some((x: string) => /Competing candidates/.test(x)));
  assert.ok(internal.additional_inspection_reasons.some((x: string) => /follow-up/i.test(x)));
  const athlete = readJson(join(r.runDir, 'athlete.json'));
  assert.equal(athlete.drills.length, 0);
  assert.ok(internal.assessment.drills.internal_drafts.every((d: any) => d.drill.sport !== 'netball'));
  const m = readJson(join(r.runDir, 'manifest.json'));
  assert.ok(m.budget.followup_model_requests <= 1 && m.budget.generated_model_requests <= 5);
});

test('unresolved conflict stays uncertain: needs_context instead of a guess', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const gm = mockGemini({ verdict: () => ({ sport_uid: null, state: 'unknown' }) });
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs({ discovery: cricketDiscovery({ conflict: true }) }).client, gemini: gm.client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.outcome, 'needs_context');
  const report = readJson(join(r.runDir, 'report.json'));
  assert.equal(report.activity.state, 'unknown');
  assert.equal(report.sections.strengths.state, 'not_assessable');
});

test('missing view yields not_assessable, never a zero skill score', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const gm = mockGemini({ answer: () => ({ answer: null, visibility: 'not_visible', state: 'not_assessable' }) });
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs().client, gemini: gm.client, label: 'offline-mock' }).run({ videoPath: clip });
  const report = readJson(join(r.runDir, 'report.json'));
  const answers = report.sections._answers.filter((a: any) => a.source === 'protocol');
  assert.ok(answers.length > 0 && answers.every((a: any) => a.state === 'not_assessable' && a.answer === null));
  assert.equal(report.scores.overall, null);
  assert.equal(report.sections.technique.state, 'not_assessable');
  assert.equal(r.outcome, 'completed_partial');
});

test('numeric pose claims and unsafe text from the model are rejected or withheld', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const gm = mockGemini({ findingsText: 'The front knee flexes 35 degrees and the athlete looks tired.', extraFinding: { finding_id: 'fx', observation: 'Knee angle', interpretation: null, state: 'supported', measurement_kind: 'measured', numeric_value: 35, unit: 'deg', uncertainty: null, approved_content_ids: [] } });
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs().client, gemini: gm.client, label: 'offline-mock' }).run({ videoPath: clip });
  const athlete = readFileSync(join(r.runDir, 'athlete.json'), 'utf8');
  assert.ok(!/35 degrees|tired/.test(athlete));
  const internal = readJson(join(r.runDir, 'assessment.internal.json'));
  assert.ok(internal.assessment.validation.rejected_claims.some((x: any) => /numeric\/measured claim/.test(x.reason)));
  assert.ok(internal.assessment.withheld.length > 0);
});

test('model error still produces diagnostics and no successful report', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs().client, gemini: mockGemini({ invalidJson: true }).client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.outcome, 'failed'); assert.equal(r.error?.kind, 'model_content');
  assert.ok(existsSync(join(r.runDir, 'diagnostic.json')));
  assert.equal(existsSync(join(r.runDir, 'athlete.json')), false);
  assert.ok(existsSync(join(r.runDir, 'artifacts', 'gemini.in1_request.response.json')), 'raw invalid output preserved internally');
});

test('corrupt input is rejected with a full timing trace', { skip }, async () => {
  const { dir, lc, db } = await setup();
  const bad = join(dir, 'inputs', 'bad.mp4'); writeFileSync(bad, 'not a video');
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs().client, gemini: mockGemini().client, label: 'offline-mock' }).run({ videoPath: bad });
  assert.equal(r.outcome, 'rejected'); assert.equal(r.error?.kind, 'input_rejected');
  const spans = readSpans(join(r.runDir, 'trace.jsonl'));
  assert.ok(spans.find((s) => s.name === 'run')!.status === 'error');
  assert.ok(spans.some((s) => s.name === 'ffprobe' && s.status === 'error'));
});

test('result cache: a re-run makes a new run record with zero new provider usage; warm asset reuse is labelled', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const tl = mockTwelveLabs();
  const runner = new JobRunner(lc, db, { twelvelabs: tl.client, gemini: mockGemini().client, label: 'offline-mock' });
  const a = await runner.run({ videoPath: clip });
  const b = await runner.run({ videoPath: clip });
  assert.notEqual(a.runId, b.runId);
  assert.equal(db.getRun(b.runId)!.cache_kind, 'result_cache_hit'); assert.equal(db.getRun(b.runId)!.reused_from_run, a.runId);
  assert.equal(db.calls(b.runId).length, 0, 'no new provider calls');
  const c = await runner.run({ videoPath: clip, disableResultCache: true });
  assert.equal(db.getRun(c.runId)!.cache_kind, 'warm_asset', 'fresh perception with a reused, re-verified upload');
  assert.equal(tl.log.filter((l) => l.startsWith('create:')).length, 1, 'asset uploaded once');
});

test('resume reuses checkpointed media and completed requests with provenance', { skip }, async () => {
  const { lc, clip, db } = await setup();
  const gm = mockGemini();
  const runner = new JobRunner(lc, db, { twelvelabs: mockTwelveLabs().client, gemini: gm.client, label: 'offline-mock' });
  const a = await runner.run({ videoPath: clip, disableResultCache: true });
  const b = await runner.run({ videoPath: clip, resumeFrom: a.runId });
  assert.equal(db.getRun(b.runId)!.cache_kind, 'resumed');
  const calls = db.calls(b.runId);
  assert.ok(calls.some((c) => c.cache_hit && c.reused_from_run === a.runId && c.role === 'discovery'));
  assert.equal(calls.filter((c) => c.generation && !c.cache_hit).length, 0, 'no new generation requests');
  assert.ok(readSpans(join(b.runDir, 'trace.jsonl')).some((s) => s.name === 'resume'));
});

test('Code Mode: invalid generated program is rejected, repaired program runs in the restricted executor', { skip }, async () => {
  const { lc, clip, db } = await setup((c) => { c.experiment.mode = 'ontology_code'; });
  const reviewed = readFileSync(fromRoot('programs/reviewed/default-v1.js'), 'utf8').replace(/^(\s*\/\/[^\n]*\n)*/, '').replace(/^\s*export\s+default\s+/m, '');
  const malicious = "async function program(tools, input) { const fs = await import('node:fs'); return fs.readFileSync('.env', 'utf8'); }";
  const adapted = reviewed.replace("const maxWindows = 3;", "const maxWindows = 2;");
  const gm = mockGemini({ plannerPrograms: [malicious, adapted] });
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs().client, gemini: gm.client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.error, null, JSON.stringify(r.error));
  const cm = readJson(join(r.runDir, 'codemode.json'));
  assert.equal(cm.self_test.read_file !== 'ALLOWED', true);
  assert.equal(cm.programs[0].origin, 'generated'); assert.ok(cm.programs[0].validation_errors.some((e: string) => /import/.test(e)));
  assert.equal(cm.programs[1].origin, 'repaired'); assert.deepEqual(cm.programs[1].validation_errors, []);
  assert.ok(cm.segments.length >= 1 && cm.segments.at(-1).status === 'done');
  assert.equal(cm.planner_turns, 2);
  const spans = readSpans(join(r.runDir, 'trace.jsonl'));
  for (const n of ['planner_request', 'code_validation', 'execution_segment', 'tool_call']) assert.ok(spans.some((s) => s.name === n), n);
  assert.ok(spans.filter((s) => s.name === 'tool_call').every((s) => ['code'].includes(String(s.attributes.origin))));
  assert.ok(gm.log.filter((l) => l.role === 'planner').length === 2);
});

test('Code Mode without a valid generated program falls back to the reviewed program inside the sandbox (not host eval)', { skip }, async () => {
  const { lc, clip, db } = await setup((c) => { c.experiment.mode = 'ontology_code'; });
  const gm = mockGemini({ plannerPrograms: ['not a program', 'still not a program'] });
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs().client, gemini: gm.client, label: 'offline-mock' }).run({ videoPath: clip });
  assert.equal(r.error, null, JSON.stringify(r.error));
  const cm = readJson(join(r.runDir, 'codemode.json'));
  assert.equal(cm.programs.at(-1).origin, 'reviewed_reuse_after_invalid_generation');
  assert.ok(cm.segments.every((s: any) => s.program_id === cm.programs.at(-1).program_id));
});

test('Code Mode host limits: a program that exceeds the tool-call budget is denied', { skip }, async () => {
  const { lc, clip, db } = await setup((c) => { c.experiment.mode = 'ontology_code'; c.code_mode.max_tool_calls = 3; c.code_mode.max_planner_turns = 1; c.code_mode.reuse_reviewed_programs = false; });
  const greedy = 'async function program(tools, input) { const out = []; for (let i = 0; i < 6; i++) { try { out.push(await tools.media.describe({})); } catch (e) { out.push(e.name); } } return { out }; }';
  const r = await new JobRunner(lc, db, { twelvelabs: mockTwelveLabs().client, gemini: mockGemini({ plannerPrograms: [greedy] }).client, label: 'offline-mock' }).run({ videoPath: clip });
  const cm = readJson(join(r.runDir, 'codemode.json'));
  const out = (cm.result ?? {}).out as unknown[];
  assert.equal(out.filter((x) => typeof x === 'object').length, 3);
  assert.equal(out.filter((x) => x === 'ToolDenied').length, 3);
  const internal = existsSync(join(r.runDir, 'assessment.internal.json')) ? readJson(join(r.runDir, 'assessment.internal.json')) : readJson(join(r.runDir, 'diagnostic.json')).partial;
  assert.ok(internal.tool_log.filter((t: any) => t.status === 'denied').length >= 3);
});
