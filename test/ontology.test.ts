import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadOntologySource, encodeProps, decodeProps, graphNameFor, type OntologySource } from '../src/ontology/source.js';
import { importOntology, verifyGraph } from '../src/ontology/importer.js';
import { FalkorBackend, JsonSnapshotBackend } from '../src/ontology/backend.js';
import { OntologyService, loadApprovals, loadOverlay } from '../src/ontology/service.js';
import { compileProtocol, representable } from '../src/ontology/capabilities.js';
import { connectFalkor } from '../src/ontology/falkor-conn.js';
import { loadEnvFile } from '../src/config/load.js';
import { fromRoot } from '../src/util/paths.js';
import { TraceStore } from '../src/telemetry/trace.js';
import { tmp } from './helpers.js';

const src: OntologySource = loadOntologySource(fromRoot('data/striide-ontology-all.json'), fromRoot('data/ontology-manifest.json'));
const overlay = loadOverlay(fromRoot('data/recognition-profiles.draft.json'));
const approvals = loadApprovals(fromRoot('approved-content.example.json'));

loadEnvFile();
const falkorEnv = { host: process.env.FALKORDB_HOST ?? null, port: process.env.FALKORDB_PORT ? Number(process.env.FALKORDB_PORT) : null, username: process.env.FALKORDB_USERNAME || null, password: process.env.FALKORDB_PASSWORD || null, tls: false };
let falkorReason: string | false = false;
try { const db = await connectFalkor(falkorEnv, 2000); await db.close(); } catch (e) { falkorReason = `FalkorDB not reachable (${(e as Error).message.slice(0, 80)}); live graph tests skipped`; }

test('source hash and counts match the bundled manifest; validation does not repair', () => {
  assert.equal(src.sha256, '145700e7ac5e33070984abb4ffdc1f0ab0a9a0038b0b012b853828f16da2bd0e');
  assert.equal(src.nodes.length, 7172); assert.equal(src.edges.length, 19803);
  assert.deepEqual(src.serialised, {}, 'all source values are native graph types');
});

test('property serialisation is reversible for complex values', () => {
  const props = { uid: 'x', list: ['a', 'b'], nums: [1, 2.5], nested: { a: [1, { b: null }] }, mixed: ['a', 1], empty: [] };
  const enc = encodeProps(props);
  assert.equal(typeof enc.nested, 'string'); assert.equal(typeof enc.mixed, 'string'); assert.deepEqual(enc.list, ['a', 'b']);
  assert.deepEqual(decodeProps(enc), props);
});

test('capability compiler excludes every numeric metric and keeps qualitative questions', async () => {
  const svc = new OntologyService(new JsonSnapshotBackend(src), overlay, approvals);
  const p = await svc.getProtocol('protocol:cricket.bowling.pace@1.0.0');
  const plan = compileProtocol(p, { sourceFps: 30, maxQuestions: 12, allowPoseMetrics: false });
  assert.ok(p.metrics.length > 0);
  assert.equal(plan.exclusions.filter((e) => e.kind === 'metric').length, p.metrics.length, 'no pose metric survives regardless of ontology definition');
  assert.ok(plan.questions.length >= 1 && plan.questions.every((q) => representable(q.answer_enum)));
  assert.ok(plan.fps_note && /50 fps/.test(plan.fps_note), 'low fps produces a note, not a rejection');
  assert.ok(plan.questions.length > 0, 'minFps does not reject all observations');
});

test('categorical answer vocabularies are excluded with a reason', () => {
  assert.equal(representable(['yes', 'partly', 'no']), true);
  assert.equal(representable(['yes', 'no', 'unclear']), true);
  assert.equal(representable(['finger_spin', 'wrist_spin', 'unclear']), false);
});

test('user-supplied IDs are validated against the graph', async () => {
  const svc = new OntologyService(new JsonSnapshotBackend(src), overlay, approvals);
  const r = await svc.validateIds('Protocol', ['protocol:cricket.bowling.pace@1.0.0', 'protocol:fake@1', "x' OR 1=1"]);
  assert.deepEqual(r.valid, ['protocol:cricket.bowling.pace@1.0.0']);
  assert.equal(r.invalid.length, 2);
});

test('relationship traversal outside the allowlist is refused', async () => {
  const b = new JsonSnapshotBackend(src);
  await assert.rejects(b.expand('Sport', ['sport:cricket'], 'DETACH DELETE', 'Skill'), /not allowlisted/);
});

test('live import: idempotent, preserves UIDs, never touches unrelated graphs; partial import never becomes active', { skip: falkorReason }, async () => {
  const db = await connectFalkor(falkorEnv, 5000);
  const prefix = 'striide_lab_testonly';
  const name = graphNameFor(prefix, src.sha256);
  const dir = tmp();
  const manifestPath = join(dir, 'import.json');
  const trace = new TraceStore({ runId: 'import-test' });
  try {
    if ((await db.list()).includes(name)) await db.selectGraph(name).delete();
    // An unrelated "production" graph must survive.
    const prod = db.selectGraph('unrelated_production_graph_test');
    await prod.query("MERGE (n:Keep {uid:'keep:1'})");
    // 1. Failed import: a broken edge endpoint after validation makes loading fail; nothing becomes active.
    const broken: OntologySource = { ...src, edges: [...src.edges.slice(0, 5), { ...src.edges[5]!, to: 'missing:uid' }] };
    await assert.rejects(importOntology({ db, src: broken, prefix, manifestPath, sourceFileLabel: 'test', trace, imageDigest: { digest: null, image_id: null, reason: 'test' } }));
    assert.equal((await db.list()).includes(name), false, 'final graph not created after a failed import');
    assert.equal((await db.list()).some((g) => g.startsWith(name + '__staging_')), false, 'staging graph removed');
    assert.equal(existsSync(manifestPath), false, 'no ready manifest after failure');
    // 2. Real import.
    const first = await importOntology({ db, src, prefix, manifestPath, sourceFileLabel: 'test', trace, imageDigest: { digest: null, image_id: null, reason: 'test' } });
    assert.equal(first.action, 'created');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const k of ['ready', 'graph_name', 'source_sha256', 'node_count', 'edge_count', 'imported_at', 'image_digest']) assert.ok(k in m, `manifest field ${k}`);
    assert.equal(m.ready, true); assert.equal(m.node_count, 7172); assert.equal(m.edge_count, 19803);
    // 3. Re-import is a verified no-op; counts unchanged (including parallel relationships).
    const second = await importOntology({ db, src, prefix, manifestPath, sourceFileLabel: 'test', trace, imageDigest: { digest: null, image_id: null, reason: 'test' } });
    assert.equal(second.action, 'reused');
    const v = await verifyGraph(db, name, src);
    assert.equal(v.ok, true); assert.equal(v.node_count, 7172); assert.equal(v.edge_count, 19803); assert.equal(v.nodes_matching_source, 7172);
    const uid = await db.selectGraph(name).roQuery<any>('MATCH (n:Protocol {uid: $u}) RETURN n.uid AS u', { params: { u: 'protocol:cricket.bowling.pace@1.0.0' } });
    assert.equal(uid.data?.[0]?.u, 'protocol:cricket.bowling.pace@1.0.0', 'original UID preserved');
    assert.ok((await db.list()).includes('unrelated_production_graph_test'), 'unrelated graph untouched');
    // 4. FalkorDB and JSON snapshot adapters return equivalent typed results.
    const fsvc = new OntologyService(new FalkorBackend(db, name, src.sha256, 5000), overlay, approvals);
    const jsvc = new OntologyService(new JsonSnapshotBackend(src), overlay, approvals);
    for (const p of ['protocol:cricket.bowling.pace@1.0.0', 'protocol:cricket.batting.defence@0.1.0', 'protocol:football.movement.stance_start@0.1.0'].filter((x) => src.nodes.some((n) => n.uid === x))) {
      assert.deepEqual(await fsvc.getProtocol(p), await jsvc.getProtocol(p), `getProtocol ${p}`);
    }
    assert.deepEqual(await fsvc.getCatalogue(), { ...(await jsvc.getCatalogue()), backend: 'falkordb', graph_name: name });
    assert.deepEqual(await fsvc.getDrillCandidates({ skillUid: 'skill:cricket.bowling.pace', protocolUid: 'protocol:cricket.bowling.pace@1.0.0' }), await jsvc.getDrillCandidates({ skillUid: 'skill:cricket.bowling.pace', protocolUid: 'protocol:cricket.bowling.pace@1.0.0' }));
    assert.deepEqual(await fsvc.getCandidateProtocols(['skill:cricket.bowling.pace']), await jsvc.getCandidateProtocols(['skill:cricket.bowling.pace']));
  } finally {
    for (const g of await db.list()) if (g === name || g.startsWith(name + '__staging_') || g === 'unrelated_production_graph_test') await db.selectGraph(g).delete();
    await db.close();
  }
});
