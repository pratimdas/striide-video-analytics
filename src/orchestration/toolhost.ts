import { readFileSync } from 'node:fs';
import { LabError, errorSummary } from '../util/errors.js';
import { hashObject } from '../util/hash.js';
import type { RunContext } from '../jobs/context.js';
import type { SpanContext } from '../telemetry/trace.js';
import type { OntologyService, Catalogue, ProtocolDetail } from '../ontology/service.js';
import { compileProtocol, questionFromOverlay, type CompiledPlan, type CompiledQuestion } from '../ontology/capabilities.js';
import type { MediaManifest } from '../media/prepare.js';
import type { SeekMap } from '../media/probe.js';
import { extractPacket, type EvidencePacket, type EvidenceFrame } from '../media/evidence.js';
import type { TwelveLabsProvider } from '../providers/twelvelabs.js';
import { GeminiProvider } from '../providers/gemini.js';
import { contract } from '../contracts.js';
import { discoveryPrompt, inspectionSystem, inspectionText, type DeclaredContext } from './prompts.js';
import { compareCandidates, validateDiscovery, validateInspection, type CompareDecision, type ValidatedDiscovery, type ValidatedInspection } from './validate-outputs.js';
import type { RunState } from '../store/db.js';
import type { LabDb } from '../store/db.js';

export interface InspectionRecord { inspection_id: string; followup: boolean; reason: string | null; packet_ids: string[]; question_uids: string[]; result: ValidatedInspection; model: string | null; frames: number; bytes: number }
export interface ToolCallLog { seq: number; tool: string; args_hash: string; status: 'ok' | 'error' | 'denied' | 'replayed'; ms: number; error: string | null; segment: number | null; origin: 'fixed' | 'code' }

export interface AssetInfo { asset_id: string; reused: boolean; polls: number; observed_wait_ms: number | null; owner_run: string }

export interface JobDeps {
  ctx: RunContext; db: LabDb; ontology: OntologyService; twelvelabs: TwelveLabsProvider; gemini: GeminiProvider; accountFingerprint: string;
  media: MediaManifest; context: DeclaredContext | null; ffmpeg: string; setState: (s: RunState, detail?: string) => void; root: SpanContext;
}

export const TOOL_NAMES = ['media.describe', 'ontology.getCatalogue', 'ontology.getRecognitionProfiles', 'ontology.getProtocol', 'video.discover', 'media.extractEvidence', 'vision.inspect', 'assessment.validate', 'assessment.calculate', 'report.assemble'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** Tools that may take longer than an execution segment (handled as host tasks in Code Mode). */
export const LONG_TOOLS: ToolName[] = ['video.discover', 'media.extractEvidence', 'vision.inspect'];

type Validator = (a: any) => string | null;
const isObj = (a: any) => a && typeof a === 'object' && !Array.isArray(a);
const onlyKeys = (a: any, keys: string[]) => Object.keys(a).filter((k) => !keys.includes(k));
const ID = /^[A-Za-z0-9_.:@\/-]{1,200}$/;
const ARG_RULES: Record<ToolName, Validator> = {
  'media.describe': (a) => (isObj(a) && onlyKeys(a, []).length === 0 ? null : 'takes no arguments'),
  'ontology.getCatalogue': (a) => (isObj(a) && onlyKeys(a, []).length === 0 ? null : 'takes no arguments'),
  'ontology.getRecognitionProfiles': (a) => (isObj(a) && onlyKeys(a, ['sport_uids']).length === 0 && Array.isArray(a.sport_uids) && a.sport_uids.length <= 5 && a.sport_uids.every((x: any) => typeof x === 'string' && ID.test(x)) ? null : 'sport_uids: up to 5 ontology sport IDs'),
  'ontology.getProtocol': (a) => (isObj(a) && onlyKeys(a, ['protocol_uid']).length === 0 && typeof a.protocol_uid === 'string' && ID.test(a.protocol_uid) ? null : 'protocol_uid: an ontology protocol ID'),
  'video.discover': (a) => {
    if (!isObj(a) || onlyKeys(a, ['followup']).length) return 'optional followup {start_seconds, end_seconds, question}';
    if (a.followup === undefined) return null;
    const f = a.followup;
    return isObj(f) && onlyKeys(f, ['start_seconds', 'end_seconds', 'question']).length === 0 && typeof f.start_seconds === 'number' && typeof f.end_seconds === 'number' && f.end_seconds - f.start_seconds >= 1 && typeof f.question === 'string' && f.question.length <= 500 ? null : 'followup needs start_seconds, end_seconds (>= 1 s apart) and a question (<= 500 chars)';
  },
  'media.extractEvidence': (a) => {
    if (!isObj(a) || onlyKeys(a, ['windows', 'context_seconds']).length) return 'windows: [{window_id?|start_seconds,end_seconds, frames?, purpose}], context_seconds?';
    if (!Array.isArray(a.windows) || a.windows.length < 1 || a.windows.length > 8) return 'windows: 1 to 8 windows';
    if (a.context_seconds !== undefined && !(typeof a.context_seconds === 'number' && a.context_seconds >= 0 && a.context_seconds <= 3)) return 'context_seconds: 0 to 3';
    for (const w of a.windows) {
      if (!isObj(w) || onlyKeys(w, ['window_id', 'start_seconds', 'end_seconds', 'frames', 'purpose']).length) return 'unexpected window field';
      if (w.window_id === undefined && !(typeof w.start_seconds === 'number' && typeof w.end_seconds === 'number' && w.end_seconds >= w.start_seconds)) return 'each window needs window_id or start_seconds/end_seconds';
      if (w.window_id !== undefined && (typeof w.window_id !== 'string' || !ID.test(w.window_id))) return 'invalid window_id';
      if (w.frames !== undefined && !(Number.isInteger(w.frames) && w.frames >= 1 && w.frames <= 64)) return 'frames: integer 1 to 64';
      if (w.purpose !== undefined && (typeof w.purpose !== 'string' || w.purpose.length > 200)) return 'purpose: short string';
    }
    return null;
  },
  'vision.inspect': (a) => {
    if (!isObj(a) || onlyKeys(a, ['packet_ids', 'question_uids', 'candidate_sport_uids', 'followup', 'reason']).length) return 'packet_ids, question_uids, candidate_sport_uids?, followup?, reason?';
    if (!Array.isArray(a.packet_ids) || !a.packet_ids.length || a.packet_ids.length > 8 || !a.packet_ids.every((x: any) => typeof x === 'string' && ID.test(x))) return 'packet_ids: 1 to 8 packet IDs';
    if (!Array.isArray(a.question_uids) || !a.question_uids.length || !a.question_uids.every((x: any) => typeof x === 'string' && ID.test(x))) return 'question_uids: compiled question IDs';
    if (a.candidate_sport_uids !== undefined && !(Array.isArray(a.candidate_sport_uids) && a.candidate_sport_uids.length <= 3 && a.candidate_sport_uids.every((x: any) => typeof x === 'string' && ID.test(x)))) return 'candidate_sport_uids: up to 3';
    if (a.followup !== undefined && typeof a.followup !== 'boolean') return 'followup: boolean';
    if (a.followup && (typeof a.reason !== 'string' || a.reason.length < 5 || a.reason.length > 300)) return 'a follow-up needs a reason (5-300 chars)';
    return null;
  },
  'assessment.validate': (a) => (isObj(a) && onlyKeys(a, []).length === 0 ? null : 'takes no arguments'),
  'assessment.calculate': (a) => (isObj(a) && onlyKeys(a, []).length === 0 ? null : 'takes no arguments'),
  'report.assemble': (a) => {
    if (!isObj(a) || onlyKeys(a, ['proposal']).length) return 'proposal: {primary_protocol_uid?, notes?}';
    const p = a.proposal ?? {};
    if (!isObj(p) || onlyKeys(p, ['primary_protocol_uid', 'notes']).length) return 'proposal may contain primary_protocol_uid and notes only';
    if (p.notes !== undefined && (typeof p.notes !== 'string' || p.notes.length > 500)) return 'notes: string up to 500 chars';
    return null;
  },
};

/**
 * Host-side job state and typed tools. Fixed mode and Code Mode use exactly this object, so both modes
 * share provider, graph and media behaviour. The host performs all side effects and enforces budgets.
 */
export class ToolHost {
  readonly deps: JobDeps;
  readonly seekPrepared: SeekMap;
  readonly mediaIds: { prepared: string; playback: string };
  asset: AssetInfo | null = null;
  catalogue: Catalogue | null = null;
  discovery: ValidatedDiscovery | null = null;
  discoveryRaw: unknown = null;
  followupDiscoveries: Array<{ window: [number, number]; question: string; raw: unknown }> = [];
  compare: CompareDecision | null = null;
  profiles: Awaited<ReturnType<OntologyService['getRecognitionProfiles']>> | null = null;
  protocols = new Map<string, ProtocolDetail>();
  plans = new Map<string, CompiledPlan>();
  overlayQuestions = new Map<string, CompiledQuestion>();
  packets = new Map<string, EvidencePacket>();
  evidence = new Map<string, EvidenceFrame>();
  inspections: InspectionRecord[] = [];
  additionalInspectionReasons: string[] = [];
  validated = false;
  assessmentRequested = false;
  proposal: { primary_protocol_uid?: string; notes?: string } | null = null;
  toolLog: ToolCallLog[] = [];
  private packetSeq = 0;
  private inspectSeq = 0;
  private framesUsed = 0;
  private bytesSent = 0;

  constructor(deps: JobDeps) {
    this.deps = deps;
    this.seekPrepared = JSON.parse(readFileSync(deps.media.prepared.seek_map_file, 'utf8'));
    this.mediaIds = { prepared: deps.media.prepared.media_id, playback: deps.media.playback.media_id };
  }

  allQuestions(): Map<string, CompiledQuestion> {
    const m = new Map<string, CompiledQuestion>();
    for (const p of this.plans.values()) for (const q of p.questions) m.set(q.uid, q);
    for (const [k, q] of this.overlayQuestions) m.set(k, q);
    return m;
  }

  /** Entry point for every tool call (fixed or Code Mode). Validates name, arguments, budget and job scope. */
  async call(tool: string, args: unknown, meta: { origin: 'fixed' | 'code'; segment: number | null; seq: number; parent?: SpanContext }): Promise<unknown> {
    const parent = meta.parent ?? this.deps.root;
    const t0 = performance.now();
    const argsHash = hashObject(args ?? {});
    if (!(TOOL_NAMES as readonly string[]).includes(tool)) {
      this.toolLog.push({ seq: meta.seq, tool: String(tool).slice(0, 80), args_hash: argsHash, status: 'denied', ms: 0, error: 'unknown tool', segment: meta.segment, origin: meta.origin });
      await parent.child('denied_tool_call', { tool: String(tool).slice(0, 80), reason: 'unknown tool' }, () => undefined);
      throw new LabError('sandbox_violation', `Unknown tool ${String(tool).slice(0, 80)}`);
    }
    const name = tool as ToolName;
    const argErr = ARG_RULES[name](args ?? {});
    if (argErr) {
      this.toolLog.push({ seq: meta.seq, tool: name, args_hash: argsHash, status: 'denied', ms: 0, error: argErr, segment: meta.segment, origin: meta.origin });
      await parent.child('denied_tool_call', { tool: name, reason: `invalid arguments: ${argErr}` }, () => undefined);
      throw new LabError('sandbox_violation', `Invalid arguments for ${name}: ${argErr}`);
    }
    try { this.deps.ctx.budget.reserveToolCall(); }
    catch (e) {
      this.toolLog.push({ seq: meta.seq, tool: name, args_hash: argsHash, status: 'denied', ms: 0, error: 'tool-call budget exhausted', segment: meta.segment, origin: meta.origin });
      await parent.child('denied_tool_call', { tool: name, reason: 'tool-call budget exhausted' }, () => undefined);
      throw e;
    }
    try {
      const r = await parent.child('tool_call', { tool: name, origin: meta.origin, segment: meta.segment, seq: meta.seq, args_hash: argsHash }, (span) => this.dispatch(name, (args ?? {}) as any, span));
      this.toolLog.push({ seq: meta.seq, tool: name, args_hash: argsHash, status: 'ok', ms: performance.now() - t0, error: null, segment: meta.segment, origin: meta.origin });
      return r;
    } catch (e) {
      this.toolLog.push({ seq: meta.seq, tool: name, args_hash: argsHash, status: 'error', ms: performance.now() - t0, error: errorSummary(e).message.slice(0, 300), segment: meta.segment, origin: meta.origin });
      throw e;
    }
  }

  private async dispatch(name: ToolName, a: any, span: SpanContext): Promise<unknown> {
    switch (name) {
      case 'media.describe': return this.describe();
      case 'ontology.getCatalogue': return this.getCatalogue(span);
      case 'ontology.getRecognitionProfiles': return this.getProfiles(a.sport_uids, span);
      case 'ontology.getProtocol': return this.getProtocol(a.protocol_uid, span);
      case 'video.discover': return a.followup ? this.followupDiscover(a.followup, span) : this.discover(span);
      case 'media.extractEvidence': return this.extractEvidence(a, span);
      case 'vision.inspect': return this.inspect(a, span);
      case 'assessment.validate': this.validated = true; return this.validationSummary();
      case 'assessment.calculate': this.assessmentRequested = true; return { note: 'Scores, eligibility and content approval are computed by the host at report assembly; the program cannot set them.' };
      case 'report.assemble': this.proposal = a.proposal ?? {}; return { accepted_as_proposal: true, note: 'The host validates the proposal and assembles the report.' };
    }
  }

  describe() {
    const p = this.deps.media.prepared.probe;
    return { media_id: this.mediaIds.prepared, duration_s: this.seekPrepared.frame_times[this.seekPrepared.frame_count - 1] ?? p.duration, frame_count: this.seekPrepared.frame_count, width: p.video.display_width, height: p.video.display_height, avg_fps: p.video.avg_fps, variable_frame_rate: this.seekPrepared.variable_frame_rate, has_audio: !!p.audio, transforms: this.deps.media.prepared.transforms, notes: this.deps.media.notes };
  }

  async getCatalogue(span: SpanContext): Promise<{ sports: number; skills: Array<{ uid: string; name: string; sport_uid: string; protocol_uids: string[] }> ; sport_list: Array<{ uid: string; name: string }> }> {
    if (!this.catalogue) this.catalogue = await span.child('ontology.catalogue', { backend: this.deps.ontology.backend.kind }, () => this.deps.ontology.getCatalogue());
    return { sports: this.catalogue.sports.length, sport_list: this.catalogue.sports.map((s) => ({ uid: s.uid, name: s.name })), skills: this.catalogue.skills.map((s) => ({ uid: s.uid, name: s.name, sport_uid: s.sport_uid, protocol_uids: s.protocol_uids })) };
  }

  async getProfiles(sportUids: string[], span: SpanContext) {
    const r = await span.child('recognition_profiles', { sport_uids: sportUids }, () => this.deps.ontology.getRecognitionProfiles(sportUids));
    this.profiles = r;
    for (const p of r.profiles) p.questions.forEach((q, i) => { const cq = questionFromOverlay(p.sport_uid, p.activity, i, q); this.overlayQuestions.set(cq.uid, cq); });
    return { overlay_version: r.overlay_version, review_status: r.review_status, profiles: r.profiles.map((p) => ({ ...p, question_uids: p.questions.map((_, i) => questionFromOverlay(p.sport_uid, p.activity, i, '').uid) })), sports: r.sports.map((s) => ({ uid: s.uid, name: s.name, safety_min_age: s.safety_min_age })) };
  }

  async getProtocol(uid: string, span: SpanContext) {
    if (!this.plans.has(uid)) {
      if (this.plans.size >= this.deps.ctx.lc.config.ontology.maximum_protocols_per_run) throw new LabError('budget_exceeded', `Protocol budget (${this.deps.ctx.lc.config.ontology.maximum_protocols_per_run}) reached`);
      const detail = await span.child('protocol_query', { protocol_uid: uid }, () => this.deps.ontology.getProtocol(uid));
      const plan = await span.child('capability_compile', { protocol_uid: uid }, async (c) => { const pl = compileProtocol(detail, { sourceFps: this.deps.media.prepared.probe.video.avg_fps, maxQuestions: this.deps.ctx.lc.config.ontology.maximum_questions_per_run, allowPoseMetrics: false }); c.set({ questions: pl.questions.length, exclusions: pl.exclusions.length }); return pl; });
      this.protocols.set(uid, detail); this.plans.set(uid, plan);
    }
    const plan = this.plans.get(uid)!; const d = this.protocols.get(uid)!;
    return { protocol_uid: uid, name: d.display_name, status: d.status, tier: d.tier, reviewed: d.reviewed_by.length > 0, questions: plan.questions.map((q) => ({ uid: q.uid, question: q.question, views: q.views, at_event: q.at_event, notes: q.notes })), excluded: plan.exclusions.length, exclusion_kinds: countBy(plan.exclusions.map((e) => e.kind)), phases: plan.phases.map((p) => p.name), capture: plan.capture, fps_note: plan.fps_note };
  }

  /** Ensure a ready TwelveLabs asset: reuse a verified cached asset from the same account, else direct upload + readiness polling. */
  async ensureAsset(span: SpanContext): Promise<AssetInfo> {
    if (this.asset) return this.asset;
    const { ctx, db, twelvelabs, media, accountFingerprint } = this.deps;
    const optionsHash = hashObject({ method: 'direct', hls: !ctx.lc.config.providers.twelvelabs.disable_optional_hls_and_thumbnails });
    if (ctx.lc.config.cache.reuse_provider_uploads) {
      const cached = await span.child('cache_lookup', { kind: 'provider_asset', prepared_sha256: media.prepared.sha256 }, () => db.findAsset('twelvelabs', accountFingerprint, media.prepared.sha256, optionsHash));
      if (cached) {
        const ok = await twelvelabs.verifyReusable(ctx, span, cached.asset_id);
        if (ok) {
          db.markAssetVerified(cached.asset_id);
          await span.child('cache_hit', { kind: 'provider_asset', asset_id: cached.asset_id, owner_run: cached.owner_run, note: 'warm asset reuse; storage may still be charged' }, () => undefined);
          this.asset = { asset_id: cached.asset_id, reused: true, polls: 0, observed_wait_ms: null, owner_run: cached.owner_run };
          return this.asset;
        }
        db.markAssetDeleted(cached.asset_id, 'not retrievable or not ready at reuse check; re-uploading');
      }
    }
    this.deps.setState('uploading');
    const up = await twelvelabs.upload(ctx, span, media.prepared.file, media.provider_upload_name);
    db.saveAsset('twelvelabs', accountFingerprint, media.prepared.sha256, optionsHash, up.asset_id, ctx.runId);
    this.deps.setState('waiting_for_asset');
    const ready = await twelvelabs.waitReady(ctx, span, up.asset_id);
    this.asset = { asset_id: up.asset_id, reused: false, polls: ready.polls, observed_wait_ms: ready.observed_wait_ms, owner_run: ctx.runId };
    return this.asset;
  }

  async discover(span: SpanContext) {
    if (this.discovery) return this.publicDiscovery();
    await this.getCatalogue(span);
    const asset = await this.ensureAsset(span);
    this.deps.setState('discovering');
    this.deps.ctx.budget.reserveModelRequest('discovery');
    const duration = this.describe().duration_s;
    const res = await span.child('pegasus.discovery', { asset_id: asset.asset_id, model: this.deps.ctx.lc.config.providers.twelvelabs.model }, (c) => this.deps.twelvelabs.analyze(this.deps.ctx, c, { assetId: asset.asset_id, prompt: discoveryPrompt(this.catalogue!, this.deps.context, duration), schema: contract('discovery').schema, role: 'discovery', spanName: 'pegasus.discovery_request' }));
    this.discoveryRaw = res.parsed;
    this.discovery = await span.child('parse_and_validate', { contract: 'discovery' }, (c) => { const d = validateDiscovery(res.parsed, this.catalogue!, duration); c.set({ candidates: d.candidates.length, windows: d.action_windows.length, notes: d.notes.length }); return d; });
    this.deps.setState('comparing');
    this.compare = await span.child('candidate_compare', {}, (c) => { const cmp = compareCandidates(this.discovery!, this.deps.context, this.catalogue!); c.set({ primary: cmp.primary?.sport_uid ?? null, conflict: cmp.conflict, out_of_catalogue: cmp.out_of_catalogue }); return cmp; });
    return this.publicDiscovery();
  }

  publicDiscovery() {
    const d = this.discovery!;
    return { candidates: d.candidates, action_windows: d.action_windows, observations: d.observations, target: d.target, limitations: d.limitations, validation_notes: d.notes, compare: this.compare };
  }

  async followupDiscover(f: { start_seconds: number; end_seconds: number; question: string }, span: SpanContext) {
    if (!this.discovery) throw new LabError('sandbox_violation', 'Run video.discover before a follow-up');
    const asset = await this.ensureAsset(span);
    this.deps.ctx.budget.reserveModelRequest('followup');
    const duration = this.describe().duration_s;
    const s = Math.max(0, f.start_seconds), e = Math.min(duration, f.end_seconds);
    if (e - s < 1) throw new LabError('sandbox_violation', 'Follow-up window must be at least 1 second inside the clip');
    this.additionalInspectionReasons.push(`Pegasus follow-up ${s.toFixed(2)}–${e.toFixed(2)} s: ${f.question}`);
    const prompt = `${discoveryPrompt(this.catalogue!, this.deps.context, duration)}\n\nBounded follow-up for the window ${s.toFixed(2)}–${e.toFixed(2)} s only. Focus question: ${f.question}`;
    const res = await span.child('followup', { kind: 'pegasus_window', window: [s, e] }, (c) => this.deps.twelvelabs.analyze(this.deps.ctx, c, { assetId: asset.asset_id, prompt, schema: contract('discovery').schema, role: 'followup', startTime: s, endTime: e, spanName: 'pegasus.followup_request' }));
    const v = validateDiscovery(res.parsed, this.catalogue!, duration);
    this.followupDiscoveries.push({ window: [s, e], question: f.question, raw: res.parsed });
    return { candidates: v.candidates, observations: v.observations, limitations: v.limitations, validation_notes: v.notes };
  }

  async extractEvidence(a: { windows: Array<{ window_id?: string; start_seconds?: number; end_seconds?: number; frames?: number; purpose?: string }>; context_seconds?: number }, span: SpanContext) {
    const cfg = this.deps.ctx.lc.config.media;
    const out = [];
    for (const w of a.windows) {
      let start: number, end: number, label: string, windowId: string | null = null;
      if (w.window_id) {
        const win = this.discovery?.action_windows.find((x) => x.window_id === w.window_id);
        if (!win) throw new LabError('sandbox_violation', `Unknown window_id ${w.window_id}`);
        start = win.start_seconds; end = win.end_seconds; label = win.label; windowId = win.window_id;
      } else { start = w.start_seconds!; end = w.end_seconds!; label = 'requested interval'; }
      const frames = Math.min(w.frames ?? cfg.max_frames_per_packet, cfg.max_frames_per_packet);
      if (this.framesUsed + frames > cfg.max_evidence_frames_total) throw new LabError('budget_exceeded', `Evidence frame budget (${cfg.max_evidence_frames_total}) would be exceeded`, { details: { limit: 'max_evidence_frames_total' } });
      const packetId = `pk${++this.packetSeq}`;
      const pkt = await span.child('frame_extract', { packet_id: packetId, window_id: windowId, start, end, frames_requested: frames }, async (c) => {
        const p = await extractPacket({ ffmpeg: this.deps.ffmpeg, mediaFile: this.deps.media.prepared.file, map: this.seekPrepared, runDir: this.deps.ctx.runDir, packetId, windowId, label, purpose: w.purpose ?? 'protocol inspection', start, end, contextSeconds: a.context_seconds ?? 0.5, frames, width: 640, signal: this.deps.ctx.signal });
        c.set({ frames: p.frames.length, bytes: p.frames.reduce((n, f) => n + f.bytes, 0), width: 640 });
        return p;
      });
      this.framesUsed += pkt.frames.length;
      this.packets.set(packetId, pkt);
      for (const f of pkt.frames) this.evidence.set(f.evidence_id, f);
      out.push({ packet_id: packetId, window_id: windowId, start_seconds: pkt.start_seconds, end_seconds: pkt.end_seconds, frames: pkt.frames.map((f) => ({ evidence_id: f.evidence_id, t: f.t })) });
    }
    return { packets: out, frames_used: this.framesUsed, frames_budget: cfg.max_evidence_frames_total };
  }

  async inspect(a: { packet_ids: string[]; question_uids: string[]; candidate_sport_uids?: string[]; followup?: boolean; reason?: string }, span: SpanContext) {
    const packets = a.packet_ids.map((id) => { const p = this.packets.get(id); if (!p) throw new LabError('sandbox_violation', `Unknown packet ${id}`); return p; });
    const all = this.allQuestions();
    const questions = a.question_uids.map((u) => { const q = all.get(u); if (!q) throw new LabError('sandbox_violation', `Question ${u} was not compiled for this job (retrieve its protocol or recognition profile first)`); return q; });
    if (questions.length > this.deps.ctx.lc.config.ontology.maximum_questions_per_run) throw new LabError('budget_exceeded', 'Too many questions for one inspection');
    const catSports = new Set(this.catalogue?.sports.map((s) => s.uid) ?? []);
    const candidates = (a.candidate_sport_uids ?? [this.compare?.primary?.sport_uid].filter(Boolean) as string[]).filter((s) => catSports.has(s));
    if (a.followup) {
      // Do not repeat the same question on the same evidence: a follow-up must change evidence or criteria.
      const repeat = this.inspections.some((r) => sameSet(r.packet_ids, a.packet_ids) && sameSet(r.question_uids, a.question_uids));
      if (repeat) throw new LabError('sandbox_violation', 'Follow-up repeats an earlier inspection without changing evidence or questions');
      this.deps.ctx.budget.reserveModelRequest('followup');
      this.additionalInspectionReasons.push(`Gemini follow-up: ${a.reason}`);
    } else this.deps.ctx.budget.reserveModelRequest('inspection');
    this.deps.setState('inspecting');
    const maxBytes = this.deps.ctx.lc.config.media.max_total_inline_evidence_mb * 1024 * 1024 - this.bytesSent;
    const fp = GeminiProvider.framePackets(packets, maxBytes);
    this.bytesSent += fp.bytes;
    const hypotheses = candidates.map((s) => { const c = this.discovery?.candidates.find((x) => x.sport_uid === s); return `${s}${c?.skill_uid ? ` / ${c.skill_uid}` : ''}${c ? ` (Pegasus uncertainty ${c.uncertainty})` : ''}`; });
    const text = inspectionText({ questions, hypotheses, ctx: this.deps.context, followupReason: a.followup ? a.reason! : null });
    const id = `in${++this.inspectSeq}`;
    const res = await span.child(a.followup ? 'followup' : 'gemini.inspect', { inspection_id: id, packets: a.packet_ids, questions: questions.length, frames: fp.frames, bytes: fp.bytes }, (c) => this.deps.gemini.generate(this.deps.ctx, c, { role: a.followup ? 'followup' : 'inspector', system: inspectionSystem(), parts: [{ text }, ...fp.parts], schema: contract('inspection').schema, spanName: `gemini.${id}_request`, maxOutputTokens: this.deps.ctx.lc.config.providers.gemini.inspector_max_output_tokens, attributes: { inspection_id: id }, artifactSummary: fp.manifest }));
    const approvedIds = [...this.deps.ontology.getContentApprovals().approved_drill_uids];
    const v = await span.child('parse_and_validate', { contract: 'inspection', inspection_id: id }, (c) => { const r = validateInspection(res.parsed, { questionIds: questions.map((q) => q.uid), packets, candidateSports: candidates, approvedContentIds: approvedIds, idPrefix: `${id}_f` }); c.set({ answers: r.answers.length, findings: r.findings.length, rejected: r.rejected.length }); return r; });
    this.inspections.push({ inspection_id: id, followup: !!a.followup, reason: a.reason ?? null, packet_ids: a.packet_ids, question_uids: questions.map((q) => q.uid), result: v, model: this.deps.gemini.models.inspector, frames: fp.frames, bytes: fp.bytes });
    return { inspection_id: id, activity_verdict: v.activity_verdict, answers: v.answers.map((x) => ({ question_id: x.question_id, answer: x.answer, visibility: x.visibility, state: x.state })), findings: v.findings.length, rejected: v.rejected.length, limitations: v.limitations };
  }

  validationSummary() {
    const answers = this.inspections.flatMap((i) => i.result.answers);
    return { inspections: this.inspections.length, answered: answers.filter((a) => a.state === 'supported' || a.state === 'contradicted').length, not_assessable: answers.filter((a) => a.state === 'not_assessable').length, rejected_claims: this.inspections.reduce((n, i) => n + i.result.rejected.length, 0), activity_verdicts: this.inspections.map((i) => i.result.activity_verdict) };
  }
}

function countBy(xs: string[]): Record<string, number> { const o: Record<string, number> = {}; for (const x of xs) o[x] = (o[x] ?? 0) + 1; return o; }
function sameSet(a: string[], b: string[]) { return a.length === b.length && a.every((x) => b.includes(x)); }
