import type { LoadedConfig } from '../config/load.js';
import { loadOntologySource, type OntologySource } from './source.js';
import { connectFalkor } from './falkor-conn.js';
import { checkReadyImport, type ImportManifest } from './importer.js';
import { FalkorBackend, JsonSnapshotBackend } from './backend.js';
import { OntologyService, loadApprovals, loadOverlay } from './service.js';
import { LabError } from '../util/errors.js';
import { fromRoot } from '../util/paths.js';

export interface OpenedOntology { service: OntologyService; manifest: ImportManifest | null; source: OntologySource; backendLabel: string }

/**
 * Open the verified ontology for analysis. The FalkorDB import manifest must be ready and match the
 * bundled source hash; there is no silent fallback to JSON. json_snapshot is only for explicit diagnostics.
 */
export async function openOntology(lc: LoadedConfig, opts: { purpose: 'analysis' | 'diagnostics' }): Promise<OpenedOntology> {
  const source = loadOntologySource(lc.abs.ontologyFile, fromRoot('data/ontology-manifest.json'));
  const overlay = loadOverlay(lc.abs.overlay);
  const approvals = loadApprovals(lc.abs.approvedContent);
  if (lc.config.ontology.backend === 'json_snapshot') {
    if (opts.purpose === 'analysis') throw new LabError('ontology_unavailable', 'json_snapshot backend is for isolated diagnostics only; analysis requires the verified FalkorDB import.');
    return { service: new OntologyService(new JsonSnapshotBackend(source), overlay, approvals), manifest: null, source, backendLabel: 'json_snapshot (diagnostics only)' };
  }
  const db = await connectFalkor(lc.env.falkor, lc.config.ontology.query_timeout_ms);
  const ready = await checkReadyImport(db, lc.abs.importManifest, source.sha256);
  if (!ready.ok || !ready.manifest) {
    await db.close();
    if (lc.config.ontology.require_import_verified || opts.purpose === 'analysis') throw new LabError('ontology_unavailable', `Ontology import is not verified: ${ready.problems.join('; ')}`);
  }
  const backend = new FalkorBackend(db, ready.manifest!.graph_name, source.sha256, lc.config.ontology.query_timeout_ms);
  return { service: new OntologyService(backend, overlay, approvals), manifest: ready.manifest, source, backendLabel: `falkordb:${ready.manifest!.graph_name}` };
}
