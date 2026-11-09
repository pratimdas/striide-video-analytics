import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import { LabDb, type RunState, type RunOutcome, type CacheKind } from '../store/db.js';
import { TraceStore, summarise, stageUnion, recoverInterruptedSpans, type SpanContext } from '../telemetry/trace.js';
import { Budget } from '../telemetry/budget.js';
import { loadPricing, runCost, type CallRecord } from '../telemetry/ledger.js';
import { makeArtifactWriter, type RunContext } from './context.js';
import { newRunId } from '../util/ids.js';
import { LabError, errorSummary } from '../util/errors.js';
import { hashObject, sha256Hex } from '../util/hash.js';
import { prepareMedia, type MediaManifest } from '../media/prepare.js';
import { openOntology, type OpenedOntology } from '../ontology/open.js';
import { TwelveLabsProvider, realTwelveLabsClient, accountFingerprint, type TwelveLabsClientLike } from '../providers/twelvelabs.js';
import { GeminiProvider, realGeminiClient, type GeminiClientLike } from '../providers/gemini.js';
import { ToolHost } from '../orchestration/toolhost.js';
import { runFixed } from '../orchestration/fixed.js';
import { CodeModeRunner, type CodeModeReport } from '../orchestration/codemode/run.js';
import { assess, type Assessment } from '../assessment/assess.js';
import { buildReports, athleteDto, type AthleteReport, type LabReport } from '../report/build.js';
import { renderAthleteHtml } from '../report/athlete-html.js';
import { athleteCsv, metricsCsv } from '../report/exports.js';
import { PROMPT_HASHES, contextIsEmpty, type DeclaredContext } from '../orchestration/prompts.js';
import { fromRoot } from '../util/paths.js';
import { IMPORTER_VERSION } from '../ontology/importer.js';
import { missingInputs } from '../config/load.js';

export interface RunRequest { videoPath: string; caseId?: string | null; context?: DeclaredContext | null; resumeFrom?: string | null; disableResultCache?: boolean }
export interface RunResult { runId: string; outcome: RunOutcome; runDir: string; error: { kind: string; message: string } | null; reportPath: string | null }

/** Injected only by tests; the CLI and UI always use the official SDK clients. */
export interface ProviderOverrides { twelvelabs?: TwelveLabsClientLike; gemini?: GeminiClientLike; label?: string }

const REVIEWED_PROGRAM_FILE = fromRoot('programs/reviewed/default-v1.js');
export const APP_VERSION = 'striideai-local-lab/0.1.0';

export function loadContext(path: string | null): DeclaredContext | null {
  if (!path) return null;
  const c = JSON.parse(readFileSync(path, 'utf8'));
  const allowed = ['sport', 'discipline', 'skill', 'format', 'age_years', 'athlete_id', 'target_person_hint', 'goal', 'handedness', 'ball_type', 'consent_confirmed'];
  for (const k of Object.keys(c)) if (!allowed.includes(k)) throw new LabError('config', `Unknown context field ${k}`);
  if (c.age_years !== null && c.age_years !== undefined && !(Number.isInteger(c.age_years) && c.age_years >= 3 && c.age_years <= 100)) throw new LabError('config', 'age_years must be an integer between 3 and 100, or null');
  const out: any = {}; for (const k of allowed) out[k] = c[k] ?? (k === 'consent_confirmed' ? false : null);
  return contextIsEmpty(out) ? null : out;
}

export class JobRunner extends EventEmitter {
  private active = new Map<string, AbortController>();
  constructor(readonly lc: LoadedConfig, readonly db: LabDb, private overrides: ProviderOverrides = {}) { super(); }

  cancel(runId: string): boolean { const c = this.active.get(runId); if (!c) return false; c.abort(new LabError('cancelled', 'Cancelled by user')); return true; }
  isActive(): boolean { return this.active.size > 0; }

  /** Mark runs left unfinished by a crash as failed and close their open spans as interrupted. */
  recoverCrashed(): string[] {
    const ids: string[] = [];
    for (const r of this.db.unfinishedRuns()) {
      if (this.active.has(r.run_id)) continue;
      const rec = recoverInterruptedSpans(join(r.run_dir, 'trace.jsonl'));
      for (const s of rec) this.db.upsertSpan(s);
      this.db.updateRun(r.run_id, { outcome: 'failed', state: 'finished', error_kind: 'interrupted', error_message: 'Process stopped before the run finished; open spans were closed as interrupted. Use --resume to reuse checkpoints.', finished_at: new Date().toISOString() });
      ids.push(r.run_id);
    }
    return ids;
  }

  async run(req: RunRequest): Promise<RunResult> {
    const { lc, db } = this;
    if (this.active.size >= lc.config.budgets.max_concurrent_jobs) throw new LabError('budget_exceeded', 'Another run is in progress (max_concurrent_jobs = 1).');
    const runId = newRunId();
    const runDir = join(lc.abs.outputRoot, runId);
    if (existsSync(runDir)) throw new LabError('internal', 'Run directory already exists');
    mkdirSync(runDir, { recursive: true });
    const ctl = new AbortController(); this.active.set(runId, ctl);
    const createdAt = new Date().toISOString();
    const trace = new TraceStore({ runId, outputFile: join(runDir, 'trace.jsonl'), redactValues: lc.secretValues });
    trace.onEvent((e) => { if (e.event === 'span_start') db.insertSpanStart(e); else db.upsertSpan(e); this.emit('span', { runId, event: e }); });
    const context = req.context !== undefined ? req.context : loadContext(lc.abs.contextFile);
    db.insertRun({ run_id: runId, created_at: createdAt, case_id: req.caseId ?? null, mode: lc.config.experiment.mode, label: lc.config.experiment.label, state: 'queued', outcome: null, source_name: basename(req.videoPath), source_sha256: null, prepared_sha256: null, clip_key: null, config_hash: lc.resolvedConfigHash, ontology_hash: null, graph_name: null, run_dir: runDir, cache_kind: req.resumeFrom ? 'resumed' : 'cold', reused_from_run: req.resumeFrom ?? null, context_declared: context ? 1 : 0 });
    const setState = (s: RunState, detail?: string) => { db.updateRun(runId, { state: s }); db.addEvent(runId, trace.now(), s, detail ?? null); this.emit('state', { runId, state: s, elapsed_ms: trace.now(), detail: detail ?? null }); };
    const calls: CallRecord[] = [];
    const budget = new Budget(lc.config.budgets, lc.config.code_mode);
    const ctx: RunContext = { runId, runDir, lc, trace, budget, pricing: loadPricing(lc.abs.pricing), signal: ctl.signal, calls, onCall: (c) => { db.insertCall(runId, c); this.emit('call', { runId, call: c }); }, artifact: makeArtifactWriter(runDir, lc.secretValues, lc.config.reports.save_redacted_raw_artifacts) };
    const wallTimer = setTimeout(() => ctl.abort(new LabError('budget_exceeded', 'Run wall-time budget exhausted')), lc.config.budgets.max_job_wall_time_ms);
    let outcome: RunOutcome = 'failed'; let error: RunResult['error'] = null; let reportPath: string | null = null;
    let host: ToolHost | null = null; let media: MediaManifest | null = null; let onto: OpenedOntology | null = null; let codeReport: CodeModeReport | null = null; let assessment: Assessment | null = null;
    let cacheKind: CacheKind = req.resumeFrom ? 'resumed' : 'cold';
    let lastSpanCtx: SpanContext | null = null;
    try {
      await trace.span('run', { run_id: runId, mode: lc.config.experiment.mode, label: lc.config.experiment.label, case_id: req.caseId ?? null, context_declared: !!context, app_version: APP_VERSION, provider_clients: this.overrides.label ?? 'official_sdk' }, async (root) => {
        lastSpanCtx = root;
        await root.child('queue_wait', { queued_runs: this.active.size - 1 }, () => undefined);
        // The verified graph is required before any video analysis; there is no JSON fallback.
        setState('preparing', 'verifying ontology import');
        onto = await root.child('ontology.verify_ready', { backend: lc.config.ontology.backend }, async (c) => { const o = await openOntology(lc, { purpose: 'analysis' }); c.set({ graph_name: o.manifest?.graph_name ?? null, source_sha256: o.source.sha256 }); return o; });
        db.updateRun(runId, { ontology_hash: onto!.source.sha256, graph_name: onto!.manifest?.graph_name ?? null });
        const missing = this.overrides.twelvelabs && this.overrides.gemini ? [] : missingInputs(lc, 'analyse');
        if (missing.length) throw new LabError('config', `Missing inputs for analysis:\n  - ${missing.join('\n  - ')}`);

        setState('preparing', 'snapshot, hash, probe and normalise media');
        media = await root.child('prepare', {}, (span) => this.prepareOrReuse(span, req, runDir, ctl.signal));
        const clipKey = media!.source.sha256_before;
        db.updateRun(runId, { source_sha256: media!.source.sha256_before, prepared_sha256: media!.prepared.sha256, clip_key: clipKey });
        writeFileSync(join(runDir, 'media.manifest.json'), JSON.stringify(stripPaths(media!), null, 2));

        // Full result cache: same prepared media, configuration, ontology, prompts, program and context.
        const cacheKey = hashObject({ prepared: media!.prepared.sha256, config: lc.resolvedConfigHash, ontology: onto!.source.sha256, prompts: PROMPT_HASHES, program: sha256Hex(readFileSync(REVIEWED_PROGRAM_FILE)), context: context ?? null, app: APP_VERSION, providers: this.overrides.label ?? 'official_sdk' });
        if (lc.config.cache.result_cache && !req.disableResultCache && !req.resumeFrom) {
          const hit = await root.child('cache_lookup', { kind: 'result', key: cacheKey.slice(0, 16) }, () => db.getResultCache(cacheKey));
          const orig = hit ? db.getRun(hit) : undefined;
          if (orig && orig.outcome && existsSync(join(orig.run_dir, 'report.json'))) {
            await root.child('cache_hit', { kind: 'result', original_run: orig.run_id, note: 'no new provider usage; outputs reference the original run' }, () => undefined);
            cacheKind = 'result_cache_hit';
            for (const f of ['report.json', 'athlete.json', 'athlete.html', 'athlete.csv', 'assessment.internal.json', 'codemode.json', 'evidence.index.json']) if (existsSync(join(orig.run_dir, f))) copyFileSync(join(orig.run_dir, f), join(runDir, f));
            writeFileSync(join(runDir, 'cache.json'), JSON.stringify({ kind: 'result_cache_hit', original_run: orig.run_id, cache_key: cacheKey, note: 'Report reused from the original run; media and evidence are served from the original run folder. Not fresh perception.' }, null, 2));
            db.updateRun(runId, { cache_kind: 'result_cache_hit', reused_from_run: orig.run_id });
            outcome = orig.outcome as RunOutcome; reportPath = join(runDir, 'report.json');
            return;
          }
        }

        const tlKey = this.overrides.twelvelabs ? 'mock-account' : lc.env.twelvelabsKey!;
        const twelvelabs = new TwelveLabsProvider(this.overrides.twelvelabs ?? realTwelveLabsClient(lc.env.twelvelabsKey!, lc.config.providers.twelvelabs.base_url), lc.config.providers.twelvelabs);
        const gemini = new GeminiProvider(this.overrides.gemini ?? realGeminiClient(lc.env.geminiKey!), lc.config.providers.gemini, { planner: lc.env.plannerModel, inspector: lc.env.inspectorModel });
        let resume: { fromRun: string; requests: Record<string, unknown> } | null = null;
        if (req.resumeFrom) { const prev = db.getRun(req.resumeFrom); const f = prev ? join(prev.run_dir, 'checkpoint.requests.json') : null; if (f && existsSync(f)) resume = { fromRun: req.resumeFrom, requests: JSON.parse(readFileSync(f, 'utf8')) }; }
        host = new ToolHost({ ctx, db, ontology: onto!.service, twelvelabs, gemini, accountFingerprint: accountFingerprint(tlKey), media: media!, context, ffmpeg: lc.env.ffmpeg, setState, root, resume });
        const reviewedSource = readFileSync(REVIEWED_PROGRAM_FILE, 'utf8');
        let programError: unknown = null;
        try {
          if (lc.config.experiment.mode === 'ontology_code' && lc.config.code_mode.enabled) {
            const runner = new CodeModeRunner(host, reviewedSource);
            try { codeReport = await runner.run(root); } finally { codeReport = codeReport ?? runner.report; }
          } else await root.child('reviewed_program', { program: 'default-v1', origin: 'fixed' }, () => runFixed(host!, root));
        } catch (e) {
          // A failed program never yields a fabricated report. If validated inspections exist, a partial report is assembled from them.
          if (!host.inspections.length || (e as any)?.kind === 'cancelled' || (e as any)?.kind === 'sandbox_unavailable') throw e;
          programError = e;
        }
        if (host.asset && host.asset.reused && cacheKind === 'cold') cacheKind = 'warm_asset';
        db.updateRun(runId, { cache_kind: cacheKind });

        setState('assessing');
        assessment = await root.child('assess', {}, async (span) => {
          await span.child('finding_validate', {}, () => undefined);
          const a = await span.child('rubric_eligibility', {}, () => assess(host!));
          await span.child('scoring', { eligible: a.scores.eligible, reason: a.scores.reason }, () => undefined);
          await span.child('drill_filter', { approved: a.drills.approved.length, drafts: a.drills.internal_drafts.length }, () => undefined);
          await span.child('claim_check', { withheld: a.withheld.length }, () => undefined);
          return a;
        });
        if (programError) { assessment!.outcome = 'completed_partial'; assessment!.outcome_reasons.unshift(`Orchestration program stopped early (${errorSummary(programError).message}); the report uses only validated inspections.`); assessment!.validation.issues.push(`program error: ${errorSummary(programError).message}`); }

        setState('reporting');
        await root.child('report', {}, async (span) => {
          const provenance = this.provenance(runId, onto!, media!, codeReport, host!, cacheKind, req, context);
          const built = await span.child('template_assemble', {}, () => buildReports({ host: host!, a: assessment!, media: media!, context, runId, createdAt, mode: lc.config.experiment.mode, provenance }));
          const approvals = onto!.service.getContentApprovals();
          const dto = athleteDto({ report: built.report, a: assessment!, host: host!, reportVersion: 1, durationS: host!.describe().duration_s, playbackMediaId: media!.playback.media_id, playbackOffsetS: media!.timeline.playback_offset_s, contentLinks: approvals.content_links ?? [], approvedUrls: approvals.approved_content_urls });
          await span.child('json_write', { files: ['report.json', 'athlete.json', 'assessment.internal.json'] }, () => {
            writeFileSync(join(runDir, 'report.json'), JSON.stringify(built.report, null, 2));
            writeFileSync(join(runDir, 'athlete.json'), JSON.stringify(dto, null, 2));
            writeFileSync(join(runDir, 'assessment.internal.json'), JSON.stringify({ assessment, compare: host!.compare, discovery: host!.discovery, followups: host!.followupDiscoveries.map((f) => ({ window: f.window, question: f.question })), inspections: host!.inspections, additional_inspection_reasons: [...(host!.compare?.reasons ?? []), ...host!.additionalInspectionReasons], plans: [...host!.plans.values()], protocols: [...host!.protocols.values()].map((p) => ({ uid: p.uid, name: p.display_name, status: p.status, tier: p.tier, reviewed_by: p.reviewed_by })), ontology_log: onto!.service.log, query_stats: onto!.service.backend.stats, tool_log: host!.toolLog, proposal: host!.proposal, contract_valid: built.contractValid }, null, 2));
            writeFileSync(join(runDir, 'evidence.index.json'), JSON.stringify([...host!.packets.values()].map((p) => ({ packet_id: p.packet_id, window_id: p.window_id, start: p.start_seconds, end: p.end_seconds, frames: p.frames.map((f) => ({ evidence_id: f.evidence_id, t: f.t, frame_index: f.frame_index, file: f.rel_path, sha256: f.sha256 })) })), null, 2));
            if (codeReport) writeFileSync(join(runDir, 'codemode.json'), JSON.stringify(codeReport, null, 2));
          });
          await span.child('html_write', {}, () => writeFileSync(join(runDir, 'athlete.html'), renderAthleteHtml(dto, { mode: 'export', evidenceDir: join(runDir, 'evidence') })));
          await span.child('csv_write', {}, () => writeFileSync(join(runDir, 'athlete.csv'), athleteCsv(dto)));
          reportPath = join(runDir, 'report.json');
        });
        outcome = assessment!.outcome;
        if (outcome === 'completed' || outcome === 'completed_partial' || outcome === 'needs_context') db.putResultCache(cacheKey, runId);
      });
    } catch (e) {
      const s = errorSummary(ctl.signal.aborted && (ctl.signal.reason as any)?.kind ? ctl.signal.reason : e);
      error = s;
      outcome = s.kind === 'cancelled' ? 'cancelled' : s.kind === 'input_rejected' ? 'rejected' : 'failed';
      writeFileSync(join(runDir, 'diagnostic.json'), JSON.stringify({ outcome, error: s, state_at_failure: db.getRun(runId)?.state, note: 'No athlete report was produced. Internal telemetry remains available.', partial: host ? { discovery: (host as ToolHost).discovery, inspections: (host as ToolHost).inspections.length, tool_log: (host as ToolHost).toolLog } : null, codemode: codeReport }, null, 2));
      if (codeReport) writeFileSync(join(runDir, 'codemode.json'), JSON.stringify(codeReport, null, 2));
    } finally {
      clearTimeout(wallTimer);
      this.active.delete(runId);
      try { await (onto as OpenedOntology | null)?.service.backend.close(); } catch { /* ignore */ }
      const summary = summarise(trace.spans);
      const cost = runCost(calls);
      writeFileSync(join(runDir, 'calls.jsonl'), calls.map((c) => JSON.stringify(c)).join('\n') + (calls.length ? '\n' : ''));
      if (lc.config.reports.write_metrics_csv) writeFileSync(join(runDir, 'metrics.csv'), metricsCsv(summary.rows));
      const manifest = { run_id: runId, app_version: APP_VERSION, created_at: createdAt, finished_at: new Date().toISOString(), outcome, error, mode: lc.config.experiment.mode, label: lc.config.experiment.label, case_id: req.caseId ?? null, cache_kind: cacheKind, reused_from_run: db.getRun(runId)?.reused_from_run ?? null, wall_time_ms: summary.wall_time_ms, budget: budget.snapshot(), cost, stage_union_ms: stageUnion(trace.spans), config_hash: lc.resolvedConfigHash, prompt_hashes: PROMPT_HASHES, files: listFiles(runDir), provider_clients: this.overrides.label ?? 'official_sdk' };
      writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      db.updateRun(runId, { state: 'finished', outcome, wall_ms: summary.wall_time_ms, error_kind: error?.kind ?? null, error_message: error?.message ?? null, finished_at: new Date().toISOString(), report_version: reportPath ? 1 : 0 });
      db.addEvent(runId, trace.now(), 'finished', outcome);
      this.emit('state', { runId, state: 'finished', outcome, elapsed_ms: trace.now() });
      void lastSpanCtx;
    }
    return { runId, outcome, runDir, error, reportPath };
  }

  /** Reuse a checkpointed media manifest when resuming (hashes must still match), else prepare fresh. */
  private async prepareOrReuse(span: SpanContext, req: RunRequest, runDir: string, signal: AbortSignal): Promise<MediaManifest> {
    const { lc } = this;
    if (!existsSync(req.videoPath) || !statSync(req.videoPath).isFile()) throw new LabError('input_rejected', 'The selected video file does not exist.');
    if (req.resumeFrom) {
      const prev = this.db.getRun(req.resumeFrom);
      const mf = prev ? join(prev.run_dir, 'media.checkpoint.json') : null;
      if (mf && existsSync(mf)) {
        const m: MediaManifest = JSON.parse(readFileSync(mf, 'utf8'));
        const { sha256File } = await import('../util/hash.js');
        const now = await span.child('hashing', { target: 'resume_source_check' }, () => sha256File(req.videoPath));
        const prep = existsSync(m.prepared.file) ? await sha256File(m.prepared.file) : null;
        if (now.sha256 === m.source.sha256_before && prep?.sha256 === m.prepared.sha256) {
          await span.child('resume', { from_run: req.resumeFrom, reused: 'media manifest and prepared media' }, () => undefined);
          writeFileSync(join(runDir, 'media.checkpoint.json'), JSON.stringify(m));
          return m;
        }
        await span.child('resume', { from_run: req.resumeFrom, reused: 'none (hash mismatch)' }, () => undefined);
      }
    }
    const m = await prepareMedia({ sourcePath: req.videoPath, originalName: basename(req.videoPath), runDir, cfg: lc.config.media, ffmpeg: lc.env.ffmpeg, ffprobe: lc.env.ffprobe, span, signal });
    writeFileSync(join(runDir, 'media.checkpoint.json'), JSON.stringify(m));
    return m;
  }

  private provenance(runId: string, onto: OpenedOntology, media: MediaManifest, code: CodeModeReport | null, host: ToolHost, cacheKind: CacheKind, req: RunRequest, context: DeclaredContext | null): Record<string, unknown> {
    const lc = this.lc;
    return {
      app_version: APP_VERSION, run_id: runId, mode: lc.config.experiment.mode, label: lc.config.experiment.label, cache_kind: cacheKind, resumed_from: req.resumeFrom ?? null,
      provider_clients: this.overrides.label ?? 'official_sdk', fixture: !!this.overrides.label,
      ontology: { backend: onto.service.backend.kind, graph_name: onto.manifest?.graph_name ?? null, source_sha256: onto.source.sha256, declared_content_hash: onto.source.meta.contentHash, importer: IMPORTER_VERSION, image_digest: onto.manifest?.image_digest ?? null, recognition_overlay: host.profiles?.overlay_version ?? null },
      models: { discovery: lc.config.providers.twelvelabs.model, inspector: lc.env.inspectorModel, planner: lc.config.experiment.mode === 'ontology_code' ? lc.env.plannerModel : null },
      media: { source_sha256: media.source.sha256_before, prepared_sha256: media.prepared.sha256, playback_sha256: media.playback.sha256, transforms: media.prepared.transforms, playback_transforms: media.playback.transforms, timeline: media.timeline },
      asset: host.asset ? { reused: host.asset.reused, owner_run: host.asset.owner_run } : null,
      prompts: PROMPT_HASHES, config_hash: lc.resolvedConfigHash, code_mode: code ? { executor: code.executor, executor_version: code.executor_version, deno_version: code.deno_version, programs: code.programs.map((p) => ({ id: p.program_id, origin: p.origin, sha256: p.sha256 })) } : null,
      context_declared: !!context, narration: lc.config.assessment.narration,
    };
  }
}

function stripPaths(m: MediaManifest): unknown {
  const s = (r: any) => ({ ...r, file: undefined, seek_map_file: undefined });
  return { ...m, snapshot: s(m.snapshot), prepared: s(m.prepared), playback: s(m.playback), source: { ...m.source } };
}

function listFiles(dir: string): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  const walk = (d: string, rel: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(p, r); else out.push({ path: r, bytes: statSync(p).size }); } };
  try { walk(dir, ''); } catch { /* ignore */ }
  return out;
}

export type { LabReport, AthleteReport };
