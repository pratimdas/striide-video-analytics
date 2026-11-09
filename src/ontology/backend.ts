import type { FalkorDB } from 'falkordb';
import { decodeProps, type OntologySource } from './source.js';
import { LabError } from '../util/errors.js';

export type Props = Record<string, any>;
export interface GNode { uid: string; label: string; props: Props }
export interface Expansion { from: string; node: GNode; rel: Props }

/** Relationship triples that read-only queries may traverse (fixed allowlist from the ontology schema). */
export const TRIPLES = [
  ['Ontology', 'HAS_SPORT', 'Sport'], ['Sport', 'HAS_DISCIPLINE', 'Discipline'], ['Discipline', 'HAS_SKILL', 'Skill'], ['Skill', 'HAS_PROTOCOL', 'Protocol'],
  ['Skill', 'DEFAULT_PROTOCOL', 'Protocol'], ['Protocol', 'ASKS', 'VlmQuestion'], ['VlmQuestion', 'ASKED_AT', 'Event'], ['Protocol', 'HAS_EVENT', 'Event'],
  ['Event', 'DETECTED_BY', 'Detector'], ['Protocol', 'HAS_PHASE', 'Phase'], ['Protocol', 'HAS_METRIC', 'Metric'], ['Metric', 'REQUIRES', 'Capability'],
  ['Metric', 'USES_MEASURE', 'Measure'], ['Protocol', 'HAS_FAULT', 'Fault'], ['Fault', 'REMEDIED_BY', 'Drill'], ['Fault', 'TRIGGERED_BY', 'Metric'],
  ['Protocol', 'HAS_STRENGTH', 'Strength'], ['Strength', 'ON_METRIC', 'Metric'], ['Drill', 'TRAINS', 'Skill'], ['Drill', 'NEEDS', 'Equipment'],
  ['Skill', 'OF_ACTIVITY_TYPE', 'ActivityType'], ['Release', 'RELEASES', 'Sport'], ['Protocol', 'HAS_LENS', 'Lens'], ['VlmQuestion', 'CROSS_CHECKS', 'Metric'],
  ['Sport', 'PLAYED_AS', 'Format'], ['Skill', 'NOT_IN_FORMAT', 'Format'], ['Gap', 'AFFECTS', 'Protocol'],
] as const;
export const LABELS = ['ActivityType', 'Capability', 'Detector', 'Discipline', 'Drill', 'Equipment', 'Event', 'Fault', 'Format', 'Gap', 'Lens', 'Measure', 'Metric', 'Ontology', 'Phase', 'Protocol', 'Release', 'Role', 'Skill', 'Source', 'Sport', 'Strength', 'VlmQuestion'] as const;
export type Label = (typeof LABELS)[number];
const tripleOk = (a: string, t: string, b: string) => TRIPLES.some(([x, y, z]) => x === a && y === t && z === b);
const MAX_ROWS = 2000;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Deterministic order shared by both adapters (byte order, then relationship properties for parallel edges). */
export function sortExpansions(xs: Expansion[]): Expansion[] {
  return xs.sort((x, y) => cmp(x.from, y.from) || cmp(x.node.uid, y.node.uid) || cmp(JSON.stringify(x.rel), JSON.stringify(y.rel)));
}

export interface QueryStat { primitive: string; label: string; ms: number; rows: number }

/**
 * Read-only primitives with fixed, bounded query templates. Labels and relationship types come from
 * compile-time allowlists; all values are parameters. No arbitrary Cypher is ever accepted.
 */
export interface OntologyBackend {
  readonly kind: 'falkordb' | 'json_snapshot';
  readonly graphName: string;
  readonly sourceSha256: string;
  readonly stats: QueryStat[];
  getNode(label: Label, uid: string): Promise<GNode | null>;
  getNodes(label: Label, uids: string[]): Promise<GNode[]>;
  listNodes(label: Label, sport?: string | null): Promise<GNode[]>;
  expand(fromLabel: Label, uids: string[], relType: string, toLabel: Label, direction?: 'out' | 'in'): Promise<Expansion[]>;
  close(): Promise<void>;
}

function check(label: string) { if (!(LABELS as readonly string[]).includes(label)) throw new LabError('ontology_invalid', `label not allowlisted: ${label}`); }

export class FalkorBackend implements OntologyBackend {
  readonly kind = 'falkordb' as const;
  readonly stats: QueryStat[] = [];
  constructor(private db: FalkorDB, readonly graphName: string, readonly sourceSha256: string, private timeoutMs: number) {}
  private async ro(primitive: string, label: string, q: string, params: Record<string, unknown>): Promise<any[]> {
    const t = performance.now();
    const r = await this.db.selectGraph(this.graphName).roQuery<any>(q, { params: params as any, TIMEOUT: this.timeoutMs });
    const rows = r.data ?? [];
    this.stats.push({ primitive, label, ms: performance.now() - t, rows: rows.length });
    return rows;
  }
  async getNode(label: Label, uid: string) { return (await this.getNodes(label, [uid]))[0] ?? null; }
  async getNodes(label: Label, uids: string[]) {
    check(label);
    if (!uids.length) return [];
    const rows = await this.ro('getNodes', label, `MATCH (n:${label}) WHERE n.uid IN $uids RETURN properties(n) AS p LIMIT ${MAX_ROWS}`, { uids: uids.slice(0, MAX_ROWS) });
    return rows.map((r) => ({ uid: r.p.uid, label, props: decodeProps(r.p) })).sort((a, b) => cmp(a.uid, b.uid));
  }
  async listNodes(label: Label, sport: string | null = null) {
    check(label);
    const rows = sport === null
      ? await this.ro('listNodes', label, `MATCH (n:${label}) RETURN properties(n) AS p ORDER BY n.uid LIMIT ${MAX_ROWS}`, {})
      : await this.ro('listNodes', label, `MATCH (n:${label}) WHERE n.sport = $sport RETURN properties(n) AS p ORDER BY n.uid LIMIT ${MAX_ROWS}`, { sport });
    return rows.map((r) => ({ uid: r.p.uid, label, props: decodeProps(r.p) })).sort((a, b) => cmp(a.uid, b.uid));
  }
  async expand(fromLabel: Label, uids: string[], relType: string, toLabel: Label, direction: 'out' | 'in' = 'out') {
    check(fromLabel); check(toLabel);
    const ok = direction === 'out' ? tripleOk(fromLabel, relType, toLabel) : tripleOk(toLabel, relType, fromLabel);
    if (!ok) throw new LabError('ontology_invalid', `relationship not allowlisted: ${fromLabel}-${relType}-${toLabel} (${direction})`);
    if (!uids.length) return [];
    const pattern = direction === 'out' ? `(a:${fromLabel})-[r:${relType}]->(b:${toLabel})` : `(a:${fromLabel})<-[r:${relType}]-(b:${toLabel})`;
    const rows = await this.ro('expand', `${fromLabel}-${relType}-${toLabel}`, `MATCH ${pattern} WHERE a.uid IN $uids RETURN a.uid AS f, properties(b) AS p, properties(r) AS r ORDER BY a.uid, b.uid LIMIT ${MAX_ROWS}`, { uids: uids.slice(0, MAX_ROWS) });
    return sortExpansions(rows.map((x) => ({ from: x.f, node: { uid: x.p.uid, label: toLabel, props: decodeProps(x.p) }, rel: decodeProps(x.r) })));
  }
  async close() { await this.db.close(); }
}

/** Diagnostics-only snapshot adapter over the immutable source file. Always labelled json_snapshot. */
export class JsonSnapshotBackend implements OntologyBackend {
  readonly kind = 'json_snapshot' as const;
  readonly graphName: string;
  readonly sourceSha256: string;
  readonly stats: QueryStat[] = [];
  private byUid = new Map<string, GNode>();
  private out = new Map<string, Array<{ type: string; to: string; props: Props }>>();
  private inc = new Map<string, Array<{ type: string; from: string; props: Props }>>();
  constructor(src: OntologySource) {
    this.graphName = `json_snapshot:${src.sha256.slice(0, 16)}`;
    this.sourceSha256 = src.sha256;
    for (const n of src.nodes) this.byUid.set(n.uid, { uid: n.uid, label: n.label, props: n.props });
    for (const e of src.edges) {
      (this.out.get(e.from) ?? this.out.set(e.from, []).get(e.from)!).push({ type: e.type, to: e.to, props: e.props });
      (this.inc.get(e.to) ?? this.inc.set(e.to, []).get(e.to)!).push({ type: e.type, from: e.from, props: e.props });
    }
  }
  private stat<T extends unknown[]>(primitive: string, label: string, t: number, rows: T): T { this.stats.push({ primitive, label, ms: performance.now() - t, rows: rows.length }); return rows; }
  async getNode(label: Label, uid: string) { return (await this.getNodes(label, [uid]))[0] ?? null; }
  async getNodes(label: Label, uids: string[]) {
    check(label); const t = performance.now();
    const r = [...new Set(uids)].slice(0, MAX_ROWS).map((u) => this.byUid.get(u)).filter((n): n is GNode => !!n && n.label === label).sort((a, b) => cmp(a.uid, b.uid));
    return this.stat('getNodes', label, t, structuredClone(r));
  }
  async listNodes(label: Label, sport: string | null = null) {
    check(label); const t = performance.now();
    const r = [...this.byUid.values()].filter((n) => n.label === label && (sport === null || n.props.sport === sport)).sort((a, b) => cmp(a.uid, b.uid)).slice(0, MAX_ROWS);
    return this.stat('listNodes', label, t, structuredClone(r));
  }
  async expand(fromLabel: Label, uids: string[], relType: string, toLabel: Label, direction: 'out' | 'in' = 'out') {
    check(fromLabel); check(toLabel);
    const ok = direction === 'out' ? tripleOk(fromLabel, relType, toLabel) : tripleOk(toLabel, relType, fromLabel);
    if (!ok) throw new LabError('ontology_invalid', `relationship not allowlisted: ${fromLabel}-${relType}-${toLabel} (${direction})`);
    const t = performance.now(); const res: Expansion[] = [];
    for (const u of [...new Set(uids)].sort()) {
      const a = this.byUid.get(u); if (!a || a.label !== fromLabel) continue;
      const edges = direction === 'out' ? (this.out.get(u) ?? []).map((e) => ({ type: e.type, other: e.to, props: e.props })) : (this.inc.get(u) ?? []).map((e) => ({ type: e.type, other: e.from, props: e.props }));
      const part: Expansion[] = [];
      for (const e of edges) { if (e.type !== relType) continue; const b = this.byUid.get(e.other); if (b && b.label === toLabel) part.push({ from: u, node: b, rel: e.props }); }
      res.push(...part);
    }
    return this.stat('expand', `${fromLabel}-${relType}-${toLabel}`, t, structuredClone(sortExpansions(res).slice(0, MAX_ROWS)));
  }
  async close() { /* nothing */ }
}
