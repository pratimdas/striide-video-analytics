import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LabError } from '../util/errors.js';
import { canonicalJson, sha256Hex } from '../util/hash.js';

export interface SourceNode { uid: string; label: string; props: Record<string, unknown> }
export interface SourceEdge { type: string; from: string; to: string; props: Record<string, unknown>; fromLabel: string; toLabel: string }
export interface OntologySource {
  sha256: string;
  bytes: number;
  meta: { format: string; formatVersion: number; graph: string; builtAt: string; contentHash: string; releases: Array<{ sport: string; release: string; contentHash: string }> };
  nodes: SourceNode[];
  edges: SourceEdge[];
  labels: string[];
  types: string[];
  /** Properties that needed explicit JSON serialisation (label.key -> count). */
  serialised: Record<string, number>;
}

export const IDENT = /^[A-Z][A-Za-z0-9_]{0,63}$/;
export const PROP_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Reversible marker for complex values that graph property types cannot hold natively. */
export const JSON_MARKER = '__striide_json__:';

function isNativeProp(v: unknown): boolean {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return true;
    const t = typeof v[0];
    return (t === 'string' || t === 'number' || t === 'boolean') && v.every((x) => typeof x === t && (t !== 'number' || Number.isFinite(x)));
  }
  return false;
}

/** Encode props for storage: native values pass through; anything else is JSON with a marker prefix. */
export function encodeProps(props: Record<string, unknown>, counter?: Record<string, number>, label = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!PROP_KEY.test(k)) throw new LabError('ontology_invalid', `Property key ${JSON.stringify(k)} is not a safe identifier`);
    if (isNativeProp(v)) {
      if (typeof v === 'string' && v.startsWith(JSON_MARKER)) throw new LabError('ontology_invalid', 'Source string collides with the serialisation marker');
      out[k] = v;
    } else { out[k] = JSON_MARKER + JSON.stringify(v); if (counter) counter[`${label}.${k}`] = (counter[`${label}.${k}`] ?? 0) + 1; }
  }
  return out;
}

export function decodeProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = typeof v === 'string' && v.startsWith(JSON_MARKER) ? JSON.parse(v.slice(JSON_MARKER.length)) : v;
  return out;
}

export function nodeFingerprint(n: { uid: string; label: string; props: Record<string, unknown> }): string { return sha256Hex(canonicalJson([n.uid, n.label, n.props])); }
export function edgeFingerprint(e: { type: string; from: string; to: string; props: Record<string, unknown> }): string { return sha256Hex(canonicalJson([e.type, e.from, e.to, e.props])); }

/** Read, hash and structurally validate the immutable ontology source. Discrepancies are reported, never repaired. */
export function loadOntologySource(path: string, manifestPath: string): OntologySource {
  const bytes = readFileSync(path);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.sha256 !== sha) throw new LabError('ontology_invalid', `Ontology source SHA-256 ${sha.slice(0, 12)}… does not match the bundled manifest (${String(manifest.sha256).slice(0, 12)}…). The original file must be unmodified.`);
  const g = JSON.parse(bytes.toString('utf8'));
  if (g.format !== 'striide.ontology.graph.combined') throw new LabError('ontology_invalid', `Unexpected ontology format ${g.format}`);
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new LabError('ontology_invalid', 'Ontology has no nodes/edges arrays');
  const problems: string[] = [];
  if (g.nodes.length !== manifest.node_count) problems.push(`node count ${g.nodes.length} != manifest ${manifest.node_count}`);
  if (g.edges.length !== manifest.edge_count) problems.push(`edge count ${g.edges.length} != manifest ${manifest.edge_count}`);
  const byUid = new Map<string, string>();
  const labels = new Set<string>(), types = new Set<string>();
  for (const n of g.nodes as SourceNode[]) {
    if (typeof n.uid !== 'string' || !n.uid) { problems.push('node without uid'); continue; }
    if (!IDENT.test(n.label)) problems.push(`unsafe label ${n.label}`);
    if (byUid.has(n.uid)) problems.push(`duplicate uid ${n.uid}`);
    if (n.props?.uid !== n.uid) problems.push(`props.uid mismatch for ${n.uid}`);
    byUid.set(n.uid, n.label); labels.add(n.label);
  }
  for (const [label, count] of Object.entries(manifest.counts?.byLabel ?? {})) {
    const actual = (g.nodes as SourceNode[]).filter((n) => n.label === label).length;
    if (actual !== count) problems.push(`label ${label}: ${actual} != manifest ${count}`);
  }
  for (const e of g.edges as SourceEdge[]) {
    if (!IDENT.test(e.type)) problems.push(`unsafe relationship type ${e.type}`);
    if (!byUid.has(e.from) || !byUid.has(e.to)) problems.push(`edge endpoint missing ${e.type} ${e.from} -> ${e.to}`);
    else if (byUid.get(e.from) !== e.fromLabel || byUid.get(e.to) !== e.toLabel) problems.push(`edge label mismatch ${e.type} ${e.from} -> ${e.to}`);
    types.add(e.type);
  }
  if (problems.length) throw new LabError('ontology_invalid', `Ontology source failed validation (${problems.length} issues): ${problems.slice(0, 10).join('; ')}`, { details: { problems } });
  const serialised: Record<string, number> = {};
  for (const n of g.nodes) encodeProps(n.props, serialised, n.label);
  for (const e of g.edges) encodeProps(e.props ?? {}, serialised, e.type);
  return {
    sha256: sha, bytes: bytes.length,
    meta: { format: g.format, formatVersion: g.formatVersion, graph: g.graph, builtAt: g.builtAt, contentHash: g.contentHash, releases: (g.releases ?? []).map((r: any) => ({ sport: r.sport, release: r.release, contentHash: r.contentHash })) },
    nodes: g.nodes, edges: g.edges.map((e: any) => ({ ...e, props: e.props ?? {} })), labels: [...labels].sort(), types: [...types].sort(), serialised,
  };
}

export function graphNameFor(prefix: string, sha: string): string { return `${prefix}_${sha.slice(0, 16)}`; }
