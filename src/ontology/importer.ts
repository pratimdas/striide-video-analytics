import { writeFileSync, renameSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FalkorDB } from 'falkordb';
import { LabError } from '../util/errors.js';
import { decodeProps, encodeProps, edgeFingerprint, graphNameFor, IDENT, nodeFingerprint, type OntologySource } from './source.js';
import type { SpanContext, TraceStore } from '../telemetry/trace.js';

export interface ImportManifest {
  ready: true;
  graph_name: string;
  source_sha256: string;
  node_count: number;
  edge_count: number;
  imported_at: string;
  image_digest: string | null;
  image_digest_reason: string | null;
  image_id: string | null;
  source_file: string;
  declared_content_hash: string;
  label_counts: Record<string, number>;
  type_counts: Record<string, number>;
  indexes: string[];
  serialised_properties: Record<string, number>;
  serialisation: string;
  verification: VerificationResult;
  importer_version: string;
  reused_existing_graph: boolean;
}

export interface VerificationResult {
  ok: boolean;
  node_count: number;
  edge_count: number;
  nodes_matching_source: number;
  edges_matching_source: number;
  label_counts_ok: boolean;
  type_counts_ok: boolean;
  uid_indexes_present: string[];
  uid_indexes_missing: string[];
  lookups: Record<string, { ok: boolean; detail: string }>;
  problems: string[];
}

export const IMPORTER_VERSION = 'striide-lab-importer/1';
const NODE_BATCH = 200;
const EDGE_BATCH = 1000;

const countOf = (rows: any[] | undefined, key = 'c'): number => Number(rows?.[0]?.[key] ?? NaN);

function groupBy<T>(xs: T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>(); for (const x of xs) { const key = k(x); const a = m.get(key); if (a) a.push(x); else m.set(key, [x]); } return m;
}

async function createIndexes(db: FalkorDB, graphName: string, labels: string[]): Promise<void> {
  const g = db.selectGraph(graphName);
  const existing = await listUidIndexes(db, graphName);
  for (const label of labels) {
    if (!IDENT.test(label)) throw new LabError('ontology_invalid', `unsafe label ${label}`);
    if (existing.includes(label)) continue;
    await g.query(`CREATE INDEX FOR (n:${label}) ON (n.uid)`);
  }
}

export async function listUidIndexes(db: FalkorDB, graphName: string): Promise<string[]> {
  if (!(await db.list()).includes(graphName)) return [];
  const r = await db.selectGraph(graphName).roQuery<any>('CALL db.indexes() YIELD label, properties RETURN label, properties');
  return (r.data ?? []).filter((row: any) => Array.isArray(row.properties) && row.properties.includes('uid')).map((row: any) => String(row.label)).sort();
}

async function loadInto(db: FalkorDB, graphName: string, src: OntologySource, span: SpanContext): Promise<void> {
  const g = db.selectGraph(graphName);
  // An index must exist before the first node can be created on a label in FalkorDB? Not required, but it accelerates edge MATCHes.
  await span.child('ontology.create_indexes', { labels: src.labels.length }, () => createIndexes(db, graphName, src.labels));
  await span.child('ontology.load_nodes', { nodes: src.nodes.length }, async (c) => {
    let created = 0;
    for (const [label, nodes] of groupBy(src.nodes, (n) => n.label)) {
      if (!IDENT.test(label)) throw new LabError('ontology_invalid', `unsafe label ${label}`);
      for (let i = 0; i < nodes.length; i += NODE_BATCH) {
        const rows = nodes.slice(i, i + NODE_BATCH).map((n) => encodeProps(n.props));
        const r = await g.query(`UNWIND $rows AS row CREATE (n:${label}) SET n = row`, { params: { rows } as any });
        created += Number(r.stats?.nodesCreated ?? 0);
      }
    }
    c.set({ nodes_created: created });
    if (created !== src.nodes.length) throw new LabError('ontology_invalid', `Created ${created} nodes, expected ${src.nodes.length}`);
  });
  await span.child('ontology.load_edges', { edges: src.edges.length }, async (c) => {
    let created = 0;
    for (const [key, edges] of groupBy(src.edges, (e) => `${e.fromLabel}|${e.type}|${e.toLabel}`)) {
      const [fl, t, tl] = key.split('|') as [string, string, string];
      if (![fl, t, tl].every((x) => IDENT.test(x))) throw new LabError('ontology_invalid', `unsafe identifier in ${key}`);
      for (let i = 0; i < edges.length; i += EDGE_BATCH) {
        const rows = edges.slice(i, i + EDGE_BATCH).map((e) => ({ f: e.from, t: e.to, p: encodeProps(e.props) }));
        const r = await g.query(`UNWIND $rows AS row MATCH (a:${fl} {uid: row.f}) MATCH (b:${tl} {uid: row.t}) CREATE (a)-[r:${t}]->(b) SET r = row.p`, { params: { rows } as any });
        const n = Number(r.stats?.relationshipsCreated ?? 0);
        if (n !== rows.length) throw new LabError('ontology_invalid', `Relationship batch ${key} created ${n} of ${rows.length}; an endpoint lookup failed`);
        created += n;
      }
    }
    c.set({ edges_created: created });
  });
}

/** Full round-trip verification: every node and relationship must match the source exactly. */
export async function verifyGraph(db: FalkorDB, graphName: string, src: OntologySource): Promise<VerificationResult> {
  const g = db.selectGraph(graphName);
  const problems: string[] = [];
  const nodeCount = countOf((await g.roQuery<any>('MATCH (n) RETURN count(n) AS c')).data);
  const edgeCount = countOf((await g.roQuery<any>('MATCH ()-[r]->() RETURN count(r) AS c')).data);
  if (nodeCount !== src.nodes.length) problems.push(`node count ${nodeCount} != source ${src.nodes.length}`);
  if (edgeCount !== src.edges.length) problems.push(`edge count ${edgeCount} != source ${src.edges.length}`);

  const expectedNodes = new Map(src.nodes.map((n) => [n.uid, nodeFingerprint(n)]));
  let nodesMatching = 0; let labelCountsOk = true;
  for (const label of src.labels) {
    const expected = src.nodes.filter((n) => n.label === label).length;
    const rows = (await g.roQuery<any>(`MATCH (n:${label}) RETURN n.uid AS uid, labels(n) AS l, properties(n) AS p`)).data ?? [];
    if (rows.length !== expected) { labelCountsOk = false; problems.push(`label ${label}: ${rows.length} != ${expected}`); }
    for (const row of rows) {
      const labels: string[] = row.l;
      if (labels.length !== 1 || labels[0] !== label) { problems.push(`node ${row.uid} has labels ${labels.join(',')}`); continue; }
      const fp = nodeFingerprint({ uid: row.uid, label, props: decodeProps(row.p) });
      if (expectedNodes.get(row.uid) === fp) nodesMatching++; else problems.push(`node ${row.uid} differs from source`);
    }
  }
  const expectedEdges = new Map<string, number>();
  for (const e of src.edges) { const fp = edgeFingerprint(e); expectedEdges.set(fp, (expectedEdges.get(fp) ?? 0) + 1); }
  let edgesMatching = 0; let typeCountsOk = true;
  for (const t of src.types) {
    const expected = src.edges.filter((e) => e.type === t).length;
    const rows = (await g.roQuery<any>(`MATCH (a)-[r:${t}]->(b) RETURN a.uid AS f, b.uid AS t, properties(r) AS p`)).data ?? [];
    if (rows.length !== expected) { typeCountsOk = false; problems.push(`type ${t}: ${rows.length} != ${expected}`); }
    for (const row of rows) {
      const fp = edgeFingerprint({ type: t, from: row.f, to: row.t, props: decodeProps(row.p) });
      const left = expectedEdges.get(fp) ?? 0;
      if (left > 0) { expectedEdges.set(fp, left - 1); edgesMatching++; } else problems.push(`unexpected/duplicate relationship ${t} ${row.f} -> ${row.t}`);
    }
  }
  const idx = await listUidIndexes(db, graphName);
  const missingIdx = src.labels.filter((l) => !idx.includes(l));
  if (missingIdx.length) problems.push(`missing uid indexes: ${missingIdx.join(', ')}`);

  const lookups: VerificationResult['lookups'] = {};
  const look = async (name: string, q: string, params: Record<string, unknown>, check: (rows: any[]) => string | null) => {
    try { const rows = (await g.roQuery<any>(q, { params: params as any })).data ?? []; const err = check(rows); lookups[name] = { ok: !err, detail: err ?? `${rows.length} row(s)` }; if (err) problems.push(`lookup ${name}: ${err}`); }
    catch (e) { lookups[name] = { ok: false, detail: (e as Error).message }; problems.push(`lookup ${name} failed`); }
  };
  await look('sport_by_uid', 'MATCH (s:Sport {uid: $uid}) RETURN s.uid AS uid', { uid: 'sport:cricket' }, (r) => (r[0]?.uid === 'sport:cricket' ? null : 'cricket sport not found'));
  await look('cricket_protocols', 'MATCH (p:Protocol) WHERE p.uid STARTS WITH $prefix RETURN p.uid AS uid', { prefix: 'protocol:cricket.' }, (r) => (r.length >= 1 ? null : 'no cricket protocols'));
  await look('visual_questions', 'MATCH (p:Protocol {uid: $uid})-[:ASKS]->(q:VlmQuestion) RETURN q.uid AS uid, q.question AS question', { uid: 'protocol:cricket.bowling.pace@1.0.0' }, (r) => (r.length >= 1 && r.every((x) => typeof x.question === 'string') ? null : 'no visual questions for pace bowling'));
  await look('camera_constraints', 'MATCH (p:Protocol {uid: $uid}) RETURN p.preferredViews AS views, p.minFps AS minFps, p.captureTips AS tips', { uid: 'protocol:cricket.bowling.pace@1.0.0' }, (r) => (Array.isArray(r[0]?.views) && typeof r[0]?.minFps === 'number' && Array.isArray(r[0]?.tips) ? null : 'camera constraints missing'));
  await look('drill_candidates', 'MATCH (s:Skill {uid: $uid})<-[:TRAINS]-(d:Drill) RETURN d.uid AS uid, d.minAge AS minAge', { uid: 'skill:cricket.bowling.pace' }, (r) => (r.length >= 1 && r.every((x) => typeof x.minAge === 'number') ? null : 'no drill candidates for pace bowling'));
  await look('protocol_chain', 'MATCH (:Sport {uid: $uid})-[:HAS_DISCIPLINE]->(:Discipline)-[:HAS_SKILL]->(:Skill)-[:HAS_PROTOCOL]->(p:Protocol) RETURN count(p) AS c', { uid: 'sport:cricket' }, (r) => (Number(r[0]?.c) >= 1 ? null : 'sport -> protocol chain broken'));

  return {
    ok: problems.length === 0, node_count: nodeCount, edge_count: edgeCount, nodes_matching_source: nodesMatching, edges_matching_source: edgesMatching,
    label_counts_ok: labelCountsOk, type_counts_ok: typeCountsOk, uid_indexes_present: idx, uid_indexes_missing: missingIdx, lookups, problems: problems.slice(0, 50),
  };
}

export interface ImportOptions {
  db: FalkorDB; src: OntologySource; prefix: string; manifestPath: string; sourceFileLabel: string; trace: TraceStore;
  imageDigest: { digest: string | null; image_id: string | null; reason: string | null };
  replaceInvalidLabGraph?: boolean;
}

function writeManifestAtomic(path: string, m: ImportManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  renameSync(tmp, path);
}

/**
 * Content-addressed, staged import. A partial import never becomes the active graph:
 * data is loaded into a staging graph, fully verified, copied to the final name, re-verified,
 * and only then is the ready manifest written. Unrelated graphs are never dropped.
 */
export async function importOntology(o: ImportOptions): Promise<{ manifest: ImportManifest; action: 'created' | 'reused' }> {
  const { db, src, trace } = o;
  const finalName = graphNameFor(o.prefix, src.sha256);
  if (!/^striide_lab_[A-Za-z0-9_]+$/.test(finalName)) throw new LabError('config', 'Lab graph must use the striide_lab prefix');
  return trace.span('ontology.import', { graph_name: finalName, source_sha256: src.sha256, nodes: src.nodes.length, edges: src.edges.length }, async (root) => {
    const graphs = await db.list();
    const build = (verification: VerificationResult, reused: boolean): ImportManifest => ({
      ready: true, graph_name: finalName, source_sha256: src.sha256, node_count: verification.node_count, edge_count: verification.edge_count,
      imported_at: new Date().toISOString(), image_digest: o.imageDigest.digest, image_digest_reason: o.imageDigest.reason, image_id: o.imageDigest.image_id,
      source_file: o.sourceFileLabel, declared_content_hash: src.meta.contentHash,
      label_counts: Object.fromEntries(src.labels.map((l) => [l, src.nodes.filter((n) => n.label === l).length])),
      type_counts: Object.fromEntries(src.types.map((t) => [t, src.edges.filter((e) => e.type === t).length])),
      indexes: verification.uid_indexes_present.map((l) => `${l}(uid)`), serialised_properties: src.serialised,
      serialisation: 'Native scalars and homogeneous scalar arrays are stored as-is; any other value is stored as a string prefixed __striide_json__: followed by JSON.',
      verification, importer_version: IMPORTER_VERSION, reused_existing_graph: reused,
    });

    if (graphs.includes(finalName)) {
      const v = await root.child('ontology.verify_existing', { graph_name: finalName }, async (c) => { const r = await verifyGraph(db, finalName, src); c.set({ ok: r.ok, problems: r.problems.length }); return r; });
      if (v.ok) {
        const manifest = build(v, true);
        writeManifestAtomic(o.manifestPath, manifest);
        root.set({ action: 'reused' });
        return { manifest, action: 'reused' as const };
      }
      if (!o.replaceInvalidLabGraph) throw new LabError('ontology_invalid', `Existing lab graph ${finalName} does not match the source (${v.problems.slice(0, 3).join('; ')}). Refusing to modify it. Re-run with --replace-invalid-lab-graph to rebuild this lab graph only.`);
      await root.child('ontology.drop_invalid_lab_graph', { graph_name: finalName }, () => db.selectGraph(finalName).delete());
    }

    // Remove stale staging graphs from earlier interrupted imports of this same source only.
    for (const name of graphs.filter((n) => n.startsWith(`${finalName}__staging_`))) await root.child('ontology.cleanup_stale_staging', { graph_name: name }, () => db.selectGraph(name).delete());

    const staging = `${finalName}__staging_${randomBytes(3).toString('hex')}`;
    try {
      await root.child('ontology.load_staging', { graph_name: staging }, (c) => loadInto(db, staging, src, c));
      const sv = await root.child('ontology.verify_staging', { graph_name: staging }, async (c) => { const r = await verifyGraph(db, staging, src); c.set({ ok: r.ok, problems: r.problems.length }); return r; });
      if (!sv.ok) throw new LabError('ontology_invalid', `Staging verification failed: ${sv.problems.slice(0, 5).join('; ')}`);
      await root.child('ontology.promote', { from: staging, to: finalName }, () => db.selectGraph(staging).copy(finalName));
      await root.child('ontology.ensure_indexes', { graph_name: finalName }, () => createIndexes(db, finalName, src.labels));
      const fv = await root.child('ontology.verify_final', { graph_name: finalName }, async (c) => { const r = await verifyGraph(db, finalName, src); c.set({ ok: r.ok, problems: r.problems.length }); return r; });
      if (!fv.ok) {
        await db.selectGraph(finalName).delete();
        throw new LabError('ontology_invalid', `Final graph verification failed: ${fv.problems.slice(0, 5).join('; ')}`);
      }
      const manifest = build(fv, false);
      writeManifestAtomic(o.manifestPath, manifest);
      root.set({ action: 'created' });
      return { manifest, action: 'created' as const };
    } finally {
      if ((await db.list()).includes(staging)) await db.selectGraph(staging).delete().catch(() => undefined);
    }
  });
}

/** Runtime check: manifest exists, is ready, matches the bundled source hash, and the live graph has the counts. */
export async function checkReadyImport(db: FalkorDB | null, manifestPath: string, sourceSha: string): Promise<{ ok: boolean; manifest: ImportManifest | null; problems: string[]; live_node_count: number | null; live_edge_count: number | null }> {
  const problems: string[] = [];
  if (!existsSync(manifestPath)) return { ok: false, manifest: null, problems: ['No import manifest. Run: npm run ontology:import -- --config config.local.yaml'], live_node_count: null, live_edge_count: null };
  let m: ImportManifest;
  try { m = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return { ok: false, manifest: null, problems: ['Import manifest is unreadable'], live_node_count: null, live_edge_count: null }; }
  if (m.ready !== true) problems.push('Import manifest is not marked ready');
  if (m.source_sha256 !== sourceSha) problems.push('Import manifest does not match the bundled ontology source hash');
  if (!/^striide_lab_[A-Za-z0-9_]+$/.test(m.graph_name ?? '')) problems.push('Import graph name is outside the striide_lab namespace');
  let nodes: number | null = null, edges: number | null = null;
  if (db && !problems.length) {
    try {
      if (!(await db.list()).includes(m.graph_name)) problems.push(`Graph ${m.graph_name} named in the manifest is not present in FalkorDB`);
      else {
        const g = db.selectGraph(m.graph_name);
        nodes = countOf((await g.roQuery<any>('MATCH (n) RETURN count(n) AS c')).data);
        edges = countOf((await g.roQuery<any>('MATCH ()-[r]->() RETURN count(r) AS c')).data);
        if (nodes !== m.node_count || edges !== m.edge_count) problems.push(`Live graph counts (${nodes}/${edges}) differ from the manifest (${m.node_count}/${m.edge_count})`);
      }
    } catch (e) { problems.push(`Graph query failed: ${(e as Error).message}`); }
  }
  return { ok: problems.length === 0, manifest: m, problems, live_node_count: nodes, live_edge_count: edges };
}
