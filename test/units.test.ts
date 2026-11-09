import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { filterDrills, claimCheck } from '../src/assessment/assess.js';
import type { DrillCandidate, ApprovalRegistry } from '../src/ontology/service.js';
import { csvCell } from '../src/util/csv.js';
import { loadConfig } from '../src/config/load.js';
import { TraceStore, recoverInterruptedSpans, readSpans } from '../src/telemetry/trace.js';
import { toPegasusSchema, toGeminiSchema } from '../src/providers/schema-translate.js';
import { contract } from '../src/contracts.js';
import { estimateCost } from '../src/telemetry/ledger.js';
import { fromRoot } from '../src/util/paths.js';
import { tmp } from './helpers.js';

const drill = (o: Partial<DrillCandidate>): DrillCandidate => ({ uid: 'drill:x', name: 'X', sport: 'cricket', category: null, focus: [], cues: ['Stay tall'], dosage: { sets: 3, reps: '6', tempo: null, rest_seconds: 60, max_sessions_per_week: null }, safety_note: null, min_age: 12, status: 'draft', reviewed_by: [], via: [], ...o });
const approvals = (ids: string[]): ApprovalRegistry => ({ version: 't', reviewed_by: ['coach'], approved_protocol_uids: [], approved_question_uids: [], approved_rubric_ids: [], approved_drill_uids: ids, approved_content_urls: [] });

test('age 11 excludes a minimum-age-12 drill; unknown age never passes; 12 passes when approved', () => {
  const base = { approvals: approvals(['drill:x']), sportKey: 'cricket', activityEstablished: true, sportSafety: null, bannedCues: [] };
  const r11 = filterDrills([drill({})], { ...base, ageYears: 11 });
  assert.equal(r11.approved.length, 0); assert.match(r11.internal_drafts[0]!.reasons.join(), /below the minimum age 12/);
  const rUnknown = filterDrills([drill({})], { ...base, ageYears: null });
  assert.equal(rUnknown.approved.length, 0); assert.match(rUnknown.internal_drafts[0]!.reasons.join(), /age unknown/);
  assert.equal(filterDrills([drill({})], { ...base, ageYears: 12 }).approved.length, 1);
  assert.equal(filterDrills([drill({ sport: 'netball' })], { ...base, ageYears: 14 }).approved.length, 0, 'other sport excluded');
  assert.equal(filterDrills([drill({})], { ...base, ageYears: 14, approvals: approvals([]) }).approved.length, 0, 'ontology draft is not approval');
  assert.equal(filterDrills([drill({ cues: ['Lock the knee at release'] })], { ...base, ageYears: 14, bannedCues: ['lock the knee'] }).approved.length, 0, 'banned cue excluded');
});

test('claim check catches unsupported claim types', () => {
  for (const s of ['front knee bends 30 degrees', 'looks tired', 'lacks strength in the core', 'seems anxious', 'needs a better diet', 'about 11 years old', 'grade A-', '7/10']) assert.ok(claimCheck(s, []), s);
  assert.equal(claimCheck('The front arm pulls down towards the hip.', []), null);
});

test('CSV cells from untrusted text are formula-escaped', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  for (const c of ['+1', '-2', '@SUM(A1)']) assert.ok(csvCell(c).startsWith("'"));
  assert.equal(csvCell(-2), '-2', 'numbers are not altered');
});

test('config rejects unknown keys and unsafe guardrail changes, listing every error', () => {
  const dir = tmp();
  const c = YAML.parse(readFileSync(fromRoot('config.example.yaml'), 'utf8'));
  c.media.max_evidence_frame = 10; c.assessment.allow_pose_metrics = true; c.budgets.max_retries_per_request = 99;
  writeFileSync(join(dir, 'c.yaml'), YAML.stringify(c));
  assert.throws(() => loadConfig(join(dir, 'c.yaml'), { loadDotEnv: false }), (e: any) => /unknown key/.test(e.message) && /allow_pose_metrics/.test(e.message) && /max_retries_per_request/.test(e.message));
  assert.doesNotThrow(() => loadConfig(fromRoot('config.example.yaml'), { loadDotEnv: false }));
});

test('crash recovery closes unfinished spans as interrupted; torn lines are ignored', async () => {
  const f = join(tmp(), 'trace.jsonl');
  const t = new TraceStore({ runId: 'crash', outputFile: f });
  await t.span('done', {}, () => undefined);
  const never = t.span('hung', {}, () => new Promise(() => undefined)); void never;
  appendFileSync(f, '{"event":"span_end","run_id":"crash"'); // torn write
  const rec = recoverInterruptedSpans(f);
  assert.equal(rec.length, 1); assert.equal(rec[0]!.name, 'hung'); assert.equal(rec[0]!.status, 'interrupted');
  assert.ok(readSpans(f).some((s) => s.name === 'hung' && s.status === 'interrupted'));
});

test('provider schema translation removes unsupported keywords and keeps null unions', () => {
  const p = JSON.stringify(toPegasusSchema(contract('discovery').schema));
  for (const k of ['additionalProperties', '"$schema"', '"minimum"']) assert.ok(!p.includes(k), k);
  assert.ok(p.includes('"anyOf"'));
  const g = toGeminiSchema(contract('inspection').schema) as any;
  assert.ok(JSON.stringify(g).includes('"additionalProperties":false'));
  assert.deepEqual(g.properties.answers.items.properties.answer.anyOf[1], { type: 'null' });
});

test('cost estimates need every rate; incompatible rates are not combined; null is never zero', () => {
  const pricing = { version: 't', currency: 'USD', effective_date: null, source: null, rates: { 'pegasus1.6': { input_per_million_tokens: 1, output_per_million_tokens: 2, per_video_minute: 0.05 }, gemini_inspector: { input_per_million_tokens: 1, output_per_million_tokens: 4, cached_input_per_million_tokens: null, thinking_per_million_tokens: null } } };
  const usage = { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 0, thinking_tokens: 50, total_tokens: null, video_seconds: 10 };
  assert.equal(estimateCost(pricing, { provider: 'twelvelabs', role: 'discovery', usage, generation: true }).cost_usd, null);
  assert.equal(estimateCost(pricing, { provider: 'gemini', role: 'inspector', usage, generation: true }).cost_usd, null, 'thinking tokens without a rate stay unknown');
  const ok = estimateCost(pricing, { provider: 'gemini', role: 'inspector', usage: { ...usage, thinking_tokens: 0 }, generation: true });
  assert.ok(Math.abs(ok.cost_usd! - (1000 * 1 + 100 * 4) / 1e6) < 1e-12);
});
