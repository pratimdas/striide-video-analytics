import { readFileSync, existsSync } from 'node:fs';
import type { GNode, OntologyBackend, Props } from './backend.js';
import { LabError } from '../util/errors.js';

export interface CatalogueSport { uid: string; name: string; aliases: string[]; category: string | null; support_tier: string | null }
export interface CatalogueSkill { uid: string; sport_uid: string; name: string; aliases: string[]; activity_type: string | null; protocol_uids: string[] }
export interface Catalogue { backend: string; graph_name: string; source_sha256: string; sports: CatalogueSport[]; skills: CatalogueSkill[]; releases: Array<{ uid: string; version: string | null; sport: string | null }> }

export interface ProtocolSummary {
  uid: string; name: string; skill_uid: string | null; sport: string | null; status: string | null; tier: string | null; version: string | null; discipline: string | null; activity_type: string | null;
  preferred_views: string[]; min_fps: number | null; recommended_fps: number | null; capture_tips: string[]; reviewed_by: string[]; is_default_for_skill: boolean;
}
export interface QuestionDetail {
  uid: string; question_id: string; question: string; crop: string | null; offsets_ms: number[]; views: string[]; answer_enum: string[];
  at_event: { uid: string; kind: string; required: boolean; detector: { uid: string; engine_status: string | null } | null } | null;
  cross_check_metric_uids: string[];
}
export interface MetricDetail { uid: string; key: string; name: string; unit: string | null; fn: string | null; views: string[]; requires_capabilities: string[]; measures: Array<{ uid: string; kind: string | null; engine_status: string | null }> }
export interface ProtocolDetail extends ProtocolSummary {
  display_name: string;
  questions: QuestionDetail[];
  phases: Array<{ uid: string; name: string; order: number; from_event: string; to_event: string }>;
  events: Array<{ uid: string; kind: string; order: number; required: boolean; detector: { uid: string; engine_status: string | null } | null }>;
  metrics: MetricDetail[];
  strengths: Array<{ uid: string; headline: string; on_metric_uids: string[] }>;
  faults: Array<{ uid: string; headline: string; severity: string | null; triggered_by_metric_uids: string[]; remedied_by_drill_uids: string[] }>;
}
export interface DrillCandidate {
  uid: string; name: string; sport: string | null; category: string | null; focus: string[]; cues: string[]; dosage: { sets: number | null; reps: string | null; tempo: string | null; rest_seconds: number | null; max_sessions_per_week: number | null };
  safety_note: string | null; min_age: number | null; status: string | null; reviewed_by: string[]; via: string[];
}
export interface RecognitionProfile { sport_uid: string; activity: string; supporting_sequence: string[]; shared_cues_not_decisive: string[]; confusions: string[]; questions: string[]; review_status: string; overlay_version: string }
export interface SportSafety { uid: string; name: string; safety_min_age: number | null; banned_cues: string[]; laterality_rule: string | null }

export interface ApprovalRegistry {
  version: string; reviewed_by: string[]; approved_protocol_uids: string[]; approved_question_uids: string[]; approved_rubric_ids: string[];
  approved_drill_uids: string[]; approved_content_urls: string[]; note?: string;
  rubrics?: Array<{ rubric_id: string; protocol_uid: string; criteria: Array<{ question_uid: string; weight: number }>; scale_max: number }>;
  content_links?: Array<{ drill_uid: string; label: string; url: string; kind: 'striide' | 'coachhq' }>;
}

export interface RetrievalLog { method: string; args: Record<string, unknown>; returned_ids: string[]; ms: number; backend: string }

const arr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);
const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const strOrNull = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const UID = /^[a-z_]+:[A-Za-z0-9_.@\/:-]{1,200}$/;

export function loadApprovals(path: string): ApprovalRegistry {
  if (!existsSync(path)) throw new LabError('config', `Approved-content registry not found at ${path}`);
  const a = JSON.parse(readFileSync(path, 'utf8'));
  for (const k of ['approved_protocol_uids', 'approved_question_uids', 'approved_rubric_ids', 'approved_drill_uids', 'approved_content_urls', 'reviewed_by']) {
    if (!Array.isArray(a[k])) throw new LabError('config', `Approved-content registry: ${k} must be an array`);
  }
  return a;
}

export function loadOverlay(path: string): { version: string; review_status: string; profiles: Array<Omit<RecognitionProfile, 'review_status' | 'overlay_version'>> } {
  if (!existsSync(path)) return { version: 'missing', review_status: 'missing', profiles: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Typed, read-only ontology methods. The same code runs over FalkorDB and the JSON snapshot adapter,
 * so the two backends return equivalent results. Every call is logged with the IDs it returned.
 */
export class OntologyService {
  readonly log: RetrievalLog[] = [];
  private catalogueCache: Catalogue | null = null;
  constructor(readonly backend: OntologyBackend, private overlay: ReturnType<typeof loadOverlay>, private approvals: ApprovalRegistry) {}

  private async logged<T>(method: string, args: Record<string, unknown>, fn: () => Promise<T>, ids: (r: T) => string[]): Promise<T> {
    const t = performance.now();
    const r = await fn();
    this.log.push({ method, args, returned_ids: ids(r).slice(0, 400), ms: performance.now() - t, backend: this.backend.kind });
    return r;
  }

  /** Validate user/model-supplied IDs against the imported graph. */
  async validateIds(label: 'Sport' | 'Skill' | 'Protocol' | 'VlmQuestion' | 'Drill', uids: string[]): Promise<{ valid: string[]; invalid: string[] }> {
    const clean = [...new Set(uids)].filter((u) => typeof u === 'string' && UID.test(u));
    const found = new Set((await this.backend.getNodes(label, clean)).map((n) => n.uid));
    return { valid: clean.filter((u) => found.has(u)), invalid: [...new Set(uids)].filter((u) => !found.has(u)) };
  }

  async getCatalogue(): Promise<Catalogue> {
    if (this.catalogueCache) return this.catalogueCache;
    return this.logged('getCatalogue', {}, async () => {
      const sports = await this.backend.listNodes('Sport');
      const skills = await this.backend.listNodes('Skill');
      const withProtocols = await this.backend.expand('Skill', skills.map((s) => s.uid), 'HAS_PROTOCOL', 'Protocol');
      const sportUidByKey = new Map(sports.map((s) => [String(s.props.sport ?? s.props.ontologyId), s.uid]));
      const protByskill = new Map<string, string[]>();
      for (const e of withProtocols) (protByskill.get(e.from) ?? protByskill.set(e.from, []).get(e.from)!).push(e.node.uid);
      const releases = await this.backend.listNodes('Release');
      const cat: Catalogue = {
        backend: this.backend.kind, graph_name: this.backend.graphName, source_sha256: this.backend.sourceSha256,
        sports: sports.map((s) => ({ uid: s.uid, name: String(s.props.name), aliases: arr(s.props.aliases).slice(0, 8), category: strOrNull(s.props.category), support_tier: strOrNull(s.props.supportTier) })),
        skills: skills.filter((k) => protByskill.has(k.uid)).map((k) => ({ uid: k.uid, sport_uid: sportUidByKey.get(String(k.props.sport)) ?? `sport:${k.props.sport}`, name: String(k.props.name), aliases: arr(k.props.aliases).slice(0, 4), activity_type: strOrNull(k.props.activityType), protocol_uids: protByskill.get(k.uid)!.sort() })),
        releases: releases.map((r) => ({ uid: r.uid, version: strOrNull(r.props.version), sport: strOrNull(r.props.sport) })),
      };
      this.catalogueCache = cat;
      return cat;
    }, (c) => [...c.sports.map((s) => s.uid), ...c.skills.map((s) => s.uid)]);
  }

  async getSportSafety(sportUids: string[]): Promise<SportSafety[]> {
    return this.logged('getSportSafety', { sportUids }, async () => (await this.backend.getNodes('Sport', sportUids)).map((s) => ({ uid: s.uid, name: String(s.props.name), safety_min_age: numOrNull(s.props.safetyMinAge), banned_cues: arr(s.props.bannedCues), laterality_rule: strOrNull(s.props.lateralityRule) })), (r) => r.map((x) => x.uid));
  }

  /** Draft recognition overlay (versioned supplement, not validated) for the requested sports. */
  async getRecognitionProfiles(sportUids: string[]): Promise<{ overlay_version: string; review_status: string; profiles: RecognitionProfile[]; sports: SportSafety[] }> {
    const { valid } = await this.validateIds('Sport', sportUids);
    const sports = await this.getSportSafety(valid);
    const profiles = this.overlay.profiles.filter((p) => valid.includes(p.sport_uid)).map((p) => ({ ...p, review_status: this.overlay.review_status, overlay_version: this.overlay.version }));
    this.log.push({ method: 'getRecognitionProfiles', args: { sportUids }, returned_ids: profiles.map((p) => `${p.sport_uid}#${p.activity}`), ms: 0, backend: 'overlay_file' });
    return { overlay_version: this.overlay.version, review_status: this.overlay.review_status, profiles, sports };
  }

  private summarise(p: GNode, skillUid: string | null, isDefault: boolean): ProtocolSummary {
    return {
      uid: p.uid, name: String(p.props.name), skill_uid: skillUid, sport: strOrNull(p.props.sport), status: strOrNull(p.props.status), tier: strOrNull(p.props.tier), version: strOrNull(p.props.version),
      discipline: strOrNull(p.props.discipline), activity_type: strOrNull(p.props.activityType), preferred_views: arr(p.props.preferredViews), min_fps: numOrNull(p.props.minFps),
      recommended_fps: numOrNull(p.props.recommendedFps), capture_tips: arr(p.props.captureTips), reviewed_by: arr(p.props.reviewedBy), is_default_for_skill: isDefault,
    };
  }

  async getCandidateProtocols(skillUids: string[]): Promise<ProtocolSummary[]> {
    const { valid } = await this.validateIds('Skill', skillUids);
    return this.logged('getCandidateProtocols', { skillUids }, async () => {
      const all = await this.backend.expand('Skill', valid, 'HAS_PROTOCOL', 'Protocol');
      const defaults = new Set((await this.backend.expand('Skill', valid, 'DEFAULT_PROTOCOL', 'Protocol')).map((e) => `${e.from}|${e.node.uid}`));
      return all.map((e) => this.summarise(e.node, e.from, defaults.has(`${e.from}|${e.node.uid}`)));
    }, (r) => r.map((p) => p.uid));
  }

  async getProtocol(protocolUid: string): Promise<ProtocolDetail> {
    const { valid } = await this.validateIds('Protocol', [protocolUid]);
    if (!valid.length) throw new LabError('ontology_invalid', `Unknown protocol ID ${protocolUid}`);
    return this.logged('getProtocol', { protocolUid }, async () => {
      const p = (await this.backend.getNode('Protocol', protocolUid))!;
      const b = this.backend;
      const skillEdge = (await b.expand('Protocol', [p.uid], 'HAS_PROTOCOL', 'Skill', 'in'))[0];
      const isDefault = (await b.expand('Protocol', [p.uid], 'DEFAULT_PROTOCOL', 'Skill', 'in')).length > 0;
      const qs = await b.expand('Protocol', [p.uid], 'ASKS', 'VlmQuestion');
      const qEvents = await b.expand('VlmQuestion', qs.map((q) => q.node.uid), 'ASKED_AT', 'Event');
      const qCross = await b.expand('VlmQuestion', qs.map((q) => q.node.uid), 'CROSS_CHECKS', 'Metric');
      const events = await b.expand('Protocol', [p.uid], 'HAS_EVENT', 'Event');
      const detectors = await b.expand('Event', events.map((e) => e.node.uid), 'DETECTED_BY', 'Detector');
      const det = new Map(detectors.map((d) => [d.from, { uid: d.node.uid, engine_status: strOrNull(d.node.props.engineStatus) }]));
      const phases = await b.expand('Protocol', [p.uid], 'HAS_PHASE', 'Phase');
      const metrics = await b.expand('Protocol', [p.uid], 'HAS_METRIC', 'Metric');
      const caps = await b.expand('Metric', metrics.map((m) => m.node.uid), 'REQUIRES', 'Capability');
      const measures = await b.expand('Metric', metrics.map((m) => m.node.uid), 'USES_MEASURE', 'Measure');
      const strengths = await b.expand('Protocol', [p.uid], 'HAS_STRENGTH', 'Strength');
      const strengthMetrics = await b.expand('Strength', strengths.map((s) => s.node.uid), 'ON_METRIC', 'Metric');
      const faults = await b.expand('Protocol', [p.uid], 'HAS_FAULT', 'Fault');
      const faultMetrics = await b.expand('Fault', faults.map((f) => f.node.uid), 'TRIGGERED_BY', 'Metric');
      const faultDrills = await b.expand('Fault', faults.map((f) => f.node.uid), 'REMEDIED_BY', 'Drill');
      const eventFor = (qUid: string) => {
        const e = qEvents.find((x) => x.from === qUid);
        return e ? { uid: e.node.uid, kind: String(e.node.props.kind), required: e.node.props.required !== false, detector: det.get(e.node.uid) ?? null } : null;
      };
      let displayName = String(p.props.name);
      try { displayName = JSON.parse(String(p.props.docJson ?? '{}')).displayName ?? displayName; } catch { /* keep node name */ }
      const uniq = <T,>(xs: T[]) => [...new Set(xs)];
      return {
        ...this.summarise(p, skillEdge?.node.uid ?? null, isDefault), display_name: displayName,
        questions: qs.map((q) => ({ uid: q.node.uid, question_id: String(q.node.props.questionId), question: String(q.node.props.question), crop: strOrNull(q.node.props.crop), offsets_ms: (q.node.props.offsetsMs ?? []).map(Number), views: arr(q.node.props.views), answer_enum: arr(q.node.props.answerEnum), at_event: eventFor(q.node.uid), cross_check_metric_uids: qCross.filter((x) => x.from === q.node.uid).map((x) => x.node.uid) })),
        phases: phases.map((ph) => ({ uid: ph.node.uid, name: String(ph.node.props.name), order: Number(ph.node.props.order), from_event: String(ph.node.props.fromEvent), to_event: String(ph.node.props.toEvent) })).sort((a, z) => a.order - z.order),
        events: events.map((e) => ({ uid: e.node.uid, kind: String(e.node.props.kind), order: Number(e.node.props.order), required: e.node.props.required !== false, detector: det.get(e.node.uid) ?? null })).sort((a, z) => a.order - z.order),
        metrics: metrics.map((m) => ({ uid: m.node.uid, key: String(m.node.props.key), name: String(m.node.props.name), unit: strOrNull(m.node.props.unit), fn: strOrNull(m.node.props.fn), views: arr(m.node.props.views), requires_capabilities: uniq(caps.filter((c) => c.from === m.node.uid).map((c) => c.node.uid)), measures: measures.filter((x) => x.from === m.node.uid).map((x) => ({ uid: x.node.uid, kind: strOrNull(x.node.props.kind), engine_status: strOrNull(x.node.props.engineStatus) })) })),
        strengths: strengths.map((s) => ({ uid: s.node.uid, headline: String(s.node.props.headline), on_metric_uids: strengthMetrics.filter((x) => x.from === s.node.uid).map((x) => x.node.uid) })),
        faults: faults.map((f) => ({ uid: f.node.uid, headline: String(f.node.props.headline), severity: strOrNull(f.node.props.severity), triggered_by_metric_uids: faultMetrics.filter((x) => x.from === f.node.uid).map((x) => x.node.uid), remedied_by_drill_uids: uniq(faultDrills.filter((x) => x.from === f.node.uid).map((x) => x.node.uid)) })),
      } satisfies ProtocolDetail;
    }, (r) => [r.uid, ...r.questions.map((q) => q.uid), ...r.phases.map((x) => x.uid), ...r.metrics.map((m) => m.uid)]);
  }

  async getInspectionQuestions(protocolUid: string): Promise<QuestionDetail[]> { return (await this.getProtocol(protocolUid)).questions; }

  async getDrillCandidates(opts: { skillUid?: string | null; protocolUid?: string | null }): Promise<DrillCandidate[]> {
    return this.logged('getDrillCandidates', opts, async () => {
      const via = new Map<string, Set<string>>(); const nodes = new Map<string, GNode>();
      const add = (n: GNode, why: string) => { nodes.set(n.uid, n); (via.get(n.uid) ?? via.set(n.uid, new Set()).get(n.uid)!).add(why); };
      if (opts.skillUid) for (const e of await this.backend.expand('Skill', [opts.skillUid], 'TRAINS', 'Drill', 'in')) add(e.node, `trains ${opts.skillUid}`);
      if (opts.protocolUid) {
        const faults = await this.backend.expand('Protocol', [opts.protocolUid], 'HAS_FAULT', 'Fault');
        for (const e of await this.backend.expand('Fault', faults.map((f) => f.node.uid), 'REMEDIED_BY', 'Drill')) add(e.node, `remedies ${e.from}`);
      }
      return [...nodes.values()].sort((a, b) => (a.uid < b.uid ? -1 : 1)).map((d) => {
        const p: Props = d.props;
        return { uid: d.uid, name: String(p.name), sport: strOrNull(p.sport), category: strOrNull(p.category), focus: arr(p.focus), cues: arr(p.cues), dosage: { sets: numOrNull(p.dosageSets), reps: strOrNull(p.dosageReps), tempo: strOrNull(p.dosageTempo), rest_seconds: numOrNull(p.dosageRestSeconds), max_sessions_per_week: numOrNull(p.maxSessionsPerWeek) }, safety_note: strOrNull(p.safetyNote), min_age: numOrNull(p.minAge), status: strOrNull(p.status), reviewed_by: arr(p.reviewedBy), via: [...via.get(d.uid)!].sort() };
      });
    }, (r) => r.map((d) => d.uid));
  }

  /** Approval state comes from the local registry only; ontology tier/status is never treated as approval. */
  getContentApprovals(): ApprovalRegistry { return structuredClone(this.approvals); }
}
