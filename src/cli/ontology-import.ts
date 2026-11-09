import { join, relative } from 'node:path';
import { mkdirSync } from 'node:fs';
import { parseArgs, str, main } from './args.js';
import { loadConfig } from '../config/load.js';
import { loadOntologySource } from '../ontology/source.js';
import { connectFalkor, composeImageDigest } from '../ontology/falkor-conn.js';
import { importOntology } from '../ontology/importer.js';
import { TraceStore } from '../telemetry/trace.js';
import { fromRoot, PROJECT_ROOT } from '../util/paths.js';
import { LabError } from '../util/errors.js';

await main(async () => {
  const { flags } = parseArgs(process.argv.slice(2), ['config'], ['replace-invalid-lab-graph']);
  if (flags.help) { console.log('npm run ontology:import -- --config config.local.yaml [--replace-invalid-lab-graph]'); return 0; }
  const lc = loadConfig(str(flags, 'config', 'config.local.yaml'));
  if (lc.config.ontology.backend !== 'falkordb') throw new LabError('config', 'ontology.backend must be falkordb to import.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const traceDir = join(lc.abs.outputRoot, '_ontology_import', stamp); mkdirSync(traceDir, { recursive: true });
  const trace = new TraceStore({ runId: `ontology-import-${stamp}`, outputFile: join(traceDir, 'trace.jsonl'), redactValues: lc.secretValues });
  const src = await trace.span('ontology.source_validate', {}, async (c) => { const s = loadOntologySource(lc.abs.ontologyFile, fromRoot('data/ontology-manifest.json')); c.set({ sha256: s.sha256, nodes: s.nodes.length, edges: s.edges.length, labels: s.labels.length, types: s.types.length }); return s; });
  console.log(`Source verified: sha256 ${src.sha256}, ${src.nodes.length} nodes, ${src.edges.length} relationships.`);
  const db = await connectFalkor(lc.env.falkor, lc.config.ontology.query_timeout_ms);
  try {
    const image = composeImageDigest();
    const { manifest, action } = await importOntology({ db, src, prefix: lc.config.ontology.graph_prefix, manifestPath: lc.abs.importManifest, sourceFileLabel: relative(PROJECT_ROOT, lc.abs.ontologyFile).replace(/\\/g, '/'), trace, imageDigest: image, replaceInvalidLabGraph: flags['replace-invalid-lab-graph'] === true });
    console.log(JSON.stringify({ action, graph_name: manifest.graph_name, source_sha256: manifest.source_sha256, node_count: manifest.node_count, edge_count: manifest.edge_count, nodes_matching_source: manifest.verification.nodes_matching_source, edges_matching_source: manifest.verification.edges_matching_source, uid_indexes: manifest.indexes.length, lookups: Object.fromEntries(Object.entries(manifest.verification.lookups).map(([k, v]) => [k, v.ok])), image_digest: manifest.image_digest, image_digest_reason: manifest.image_digest_reason, manifest: relative(PROJECT_ROOT, lc.abs.importManifest), telemetry: relative(PROJECT_ROOT, join(traceDir, 'trace.jsonl')) }, null, 2));
    return 0;
  } finally { await db.close(); }
});
