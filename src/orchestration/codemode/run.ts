import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { LabError } from '../../util/errors.js';
import { sha256Hex } from '../../util/hash.js';
import { Broker, newNonce, resolveDeno, runDenoModule, sandboxSelfTest, segmentModule, DENO_FLAGS_VERSION, type SegmentOutcome } from './executor.js';
import { validateProgram, reviewedProgramText } from './validate.js';
import { LONG_TOOLS, TOOL_NAMES, type ToolHost } from '../toolhost.js';
import { PROMPTS, PLANNER_OUTPUT_SCHEMA } from '../prompts.js';
import type { SpanContext } from '../../telemetry/trace.js';

export interface ProgramRecord {
  program_id: string; origin: 'generated' | 'repaired' | 'reviewed_reuse' | 'reviewed_reuse_after_invalid_generation' | 'followup_generated';
  sha256: string; chars: number; artifact: string; validation_errors: string[]; planner_turn: number | null; planner_summary: string | null;
}
export interface SegmentRecord { program_id: string; segment: number; status: SegmentOutcome['status']; duration_ms: number; stdout_bytes: number; tool_calls_new: number; replayed: number; error: string | null; logs: string[] }
export interface CodeModeReport {
  enabled: boolean; executor: string; executor_version: string; deno_version: string | null; self_test: Record<string, string>; programs: ProgramRecord[]; segments: SegmentRecord[];
  denied_calls: Array<{ tool: string; reason: string }>; planner_turns: number; result: unknown; status: 'completed' | 'failed' | 'disabled'; error: string | null;
}

let selfTestCache: Awaited<ReturnType<typeof sandboxSelfTest>> | null = null;

function toolDocs(): string {
  return [
    'Typed tools (all async, called as tools.<namespace>.<name>(args)); results are JSON:',
    '- media.describe({}) -> duration_s, frame_count, width, height, avg_fps, variable_frame_rate, has_audio, transforms, notes',
    '- ontology.getCatalogue({}) -> sport_list[{uid,name}], skills[{uid,name,sport_uid,protocol_uids}]',
    '- ontology.getRecognitionProfiles({sport_uids: string[] (<=5)}) -> draft overlay profiles with question_uids',
    '- ontology.getProtocol({protocol_uid}) -> compiled qualitative questions [{uid, question, views, at_event}], exclusions, phases, capture',
    '- video.discover({}) -> candidates, action_windows[{window_id,start_seconds,end_seconds,label}], observations, target, limitations, compare{primary, competing, conflict, reasons}',
    '- video.discover({followup:{start_seconds,end_seconds,question}}) -> targeted Pegasus follow-up (uses the follow-up budget)',
    '- media.extractEvidence({windows:[{window_id | start_seconds,end_seconds, frames?, purpose?}], context_seconds?}) -> packets[{packet_id, frames[{evidence_id,t}]}], frames_used, frames_budget',
    '- vision.inspect({packet_ids, question_uids, candidate_sport_uids?, followup?, reason?}) -> activity_verdict, answers, limitations (follow-up needs a reason and changed evidence or questions)',
    '- assessment.validate({}), assessment.calculate({}) -> host summaries (host computes scores and eligibility)',
    '- report.assemble({proposal:{primary_protocol_uid?, notes?}}) -> proposal recorded; the host assembles and publishes',
    'Return a small JSON object. To request one more planning turn after seeing results, return {request_replan: {summary}}.',
  ].join('\n');
}

/**
 * Bounded Code Mode: planner turns generate/adapt a program; the program runs in the restricted Deno
 * executor in short segments with a replay journal, calling the same ToolHost as fixed mode.
 * If the executor or its negative tests fail, generated execution is disabled with a clear error.
 */
export class CodeModeRunner {
  readonly report: CodeModeReport;
  private deno: string;
  constructor(private host: ToolHost, private reviewedModuleSource: string) {
    this.deno = resolveDeno(host.deps.ctx.lc.env.deno);
    this.report = { enabled: true, executor: 'deno_restricted', executor_version: DENO_FLAGS_VERSION, deno_version: null, self_test: {}, programs: [], segments: [], denied_calls: [], planner_turns: 0, result: null, status: 'failed', error: null };
  }

  async run(root: SpanContext): Promise<CodeModeReport> {
    const { ctx } = this.host.deps;
    const cm = ctx.lc.config.code_mode;
    const workDir = join(ctx.runDir, 'codemode'); mkdirSync(workDir, { recursive: true });
    const st = await root.child('code_validation', { check: 'sandbox_self_test', deno: this.deno.replace(/.*[\\/]/, '') }, async (c) => {
      const r = selfTestCache?.ok ? selfTestCache : await sandboxSelfTest(this.deno, workDir);
      if (r.ok) selfTestCache = r;
      c.set({ ok: r.ok, results: r.results, deno_version: r.deno_version });
      return r;
    });
    this.report.self_test = st.results; this.report.deno_version = st.deno_version;
    if (!st.ok) {
      this.report.status = 'disabled'; this.report.error = `Restricted executor unavailable: ${st.error}. Generated execution is disabled (no host eval fallback).`;
      throw new LabError('sandbox_unavailable', this.report.error);
    }
    const reviewed = reviewedProgramText(this.reviewedModuleSource);
    const rv = validateProgram(reviewed);
    if (!rv.ok) throw new LabError('internal', `Reviewed program fails the static policy: ${rv.errors.join('; ')}`);

    let program = await this.obtainProgram(root, reviewed, null);
    let result = await this.execute(root, program);
    // Bounded follow-up loop: one more planning turn when the program asks for it and budget remains.
    const replan = (result as any)?.request_replan;
    if (replan && ctx.budget.plannerTurns < cm.max_planner_turns && this.host.deps.gemini.models.planner) {
      const followSummary = { request: replan, discovery: this.host.discovery ? { candidates: this.host.discovery.candidates.slice(0, 3).map((c) => ({ sport_uid: c.sport_uid, skill_uid: c.skill_uid, uncertainty: c.uncertainty })), windows: this.host.discovery.action_windows } : null, inspections: this.host.inspections.map((i) => ({ id: i.inspection_id, verdict: i.result.activity_verdict, answered: i.result.answers.filter((a) => a.state === 'supported' || a.state === 'contradicted').length })), packets: [...this.host.packets.keys()], budget: ctx.budget.snapshot() };
      program = await this.obtainProgram(root, reviewed, followSummary);
      result = await this.execute(root, program);
    }
    this.report.result = result;
    this.report.status = 'completed';
    return this.report;
  }

  private input() {
    const { ctx } = this.host.deps; const b = ctx.budget;
    return {
      limits: { max_frames_per_packet: ctx.lc.config.media.max_frames_per_packet, max_evidence_frames_total: ctx.lc.config.media.max_evidence_frames_total, max_questions: ctx.lc.config.ontology.maximum_questions_per_run, max_protocols: ctx.lc.config.ontology.maximum_protocols_per_run },
      budgets: { followups_remaining: b.limits.max_followup_model_requests - b.followups, model_requests_remaining: b.limits.max_generated_model_requests - b.generatedRequests, tool_calls_remaining: ctx.lc.config.code_mode.max_tool_calls - b.toolCalls },
      declared_context_present: !!this.host.deps.context,
    };
  }

  private register(source: string, origin: ProgramRecord['origin'], errors: string[], turn: number | null, summary: string | null): ProgramRecord {
    const sha = sha256Hex(source);
    const id = `prog${this.report.programs.length + 1}`;
    const artifact = this.host.deps.ctx.artifact(`codemode.${id}.${origin}.js`, source);
    this.host.deps.db.saveProgram(sha, source, origin);
    const rec = { program_id: id, origin, sha256: sha, chars: source.length, artifact, validation_errors: errors, planner_turn: turn, planner_summary: summary };
    this.report.programs.push(rec);
    return rec;
  }

  /** Planner turns (bounded) produce a program; invalid output gets one repair turn, then the reviewed program if allowed. */
  private async obtainProgram(root: SpanContext, reviewed: string, followup: unknown): Promise<{ rec: ProgramRecord; source: string }> {
    const { ctx, gemini } = this.host.deps;
    const cm = ctx.lc.config.code_mode;
    let lastErrors: string[] = []; let lastSource: string | null = null;
    while (ctx.budget.plannerTurns < cm.max_planner_turns && gemini.models.planner) {
      const turn = ctx.budget.plannerTurns + 1;
      ctx.budget.reserveModelRequest('planner');
      this.report.planner_turns++;
      const text = [
        followup ? `Follow-up planning turn. Results so far (structured summary):\n${JSON.stringify(followup).slice(0, 6000)}` : 'Plan the orchestration for this job.',
        lastErrors.length ? `Your previous program was rejected by the static policy: ${lastErrors.join('; ')}. Return a corrected program.` : '',
        toolDocs(),
        `Job input object (available as input): ${JSON.stringify(this.input())}`,
        'Reviewed program (you may reuse it unchanged or adapt it):',
        reviewed,
      ].filter(Boolean).join('\n\n');
      const res = await root.child('planner_request', { turn, followup: !!followup }, (c) => gemini.generate(ctx, c, { role: 'planner', system: PROMPTS.planner, parts: [{ text }], schema: PLANNER_OUTPUT_SCHEMA, spanName: `gemini.planner_turn${turn}`, maxOutputTokens: ctx.lc.config.providers.gemini.planner_max_output_tokens, artifactSummary: [], attributes: { turn } }));
      const out = res.parsed as { program?: string; summary?: string };
      const source = String(out?.program ?? '');
      const v = await root.child('code_validation', { turn, chars: source.length }, (c) => { const r = validateProgram(source); c.set({ ok: r.ok, errors: r.errors, tools: r.tools_referenced }); return r; });
      const origin: ProgramRecord['origin'] = followup ? 'followup_generated' : source.trim() === reviewed.trim() ? 'reviewed_reuse' : lastSource !== null ? 'repaired' : 'generated';
      const rec = this.register(source || '(empty)', origin, v.errors, turn, out?.summary ? String(out.summary).slice(0, 400) : null);
      if (v.ok) return { rec, source };
      lastErrors = v.errors; lastSource = source;
    }
    if (followup) throw new LabError('budget_exceeded', 'No planner turn left for the requested follow-up plan');
    if (!cm.reuse_reviewed_programs) throw new LabError('sandbox_violation', `No valid generated program (${lastErrors.join('; ') || 'planner unavailable'}) and reviewed-program reuse is disabled`);
    const rec = this.register(reviewed, lastSource !== null ? 'reviewed_reuse_after_invalid_generation' : 'reviewed_reuse', [], null, null);
    return { rec, source: reviewed };
  }

  /** Execute a program in short segments; long host tasks suspend the segment and resume by deterministic replay. */
  private async execute(root: SpanContext, p: { rec: ProgramRecord; source: string }): Promise<unknown> {
    const { ctx } = this.host.deps;
    const cm = ctx.lc.config.code_mode;
    let segmentNo = 0;
    const broker: Broker = new Broker(
      (tool: string, args: unknown, seq: number): Promise<unknown> => this.host.call(tool, args, { origin: 'code', segment: segmentNo, seq, parent: root }),
      (tool) => (LONG_TOOLS as readonly string[]).includes(tool),
      (tool, reason) => { this.report.denied_calls.push({ tool, reason }); },
    );
    const port = await broker.start();
    try {
      for (let seg = 1; ; seg++) {
        ctx.budget.reserveSegment();
        const before = broker.journal.length; const replayedBefore = broker.replayed;
        const nonce = newNonce();
        const deadline = performance.now() + cm.execution_segment_timeout_ms;
        segmentNo = seg;
        broker.beginSegment(seg, deadline);
        const out = await root.child('execution_segment', { program_id: p.rec.program_id, segment: seg, timeout_ms: cm.execution_segment_timeout_ms }, async (c) => {
          const o = await runDenoModule({ deno: this.deno, moduleSource: segmentModule(p.source), file: join(ctx.runDir, 'codemode', `${p.rec.program_id}.segment${seg}.js`), stdin: { port, token: broker.token, nonce, segment: seg, tools: TOOL_NAMES, input: this.input() }, nonce, port, timeoutMs: cm.execution_segment_timeout_ms, maxStdoutBytes: cm.max_stdout_bytes, signal: ctx.signal });
          await broker.settle();
          c.set({ status: o.status, stdout_bytes: o.stdout_bytes, new_tool_calls: broker.journal.length - before, replayed: broker.replayed - replayedBefore, error: o.error });
          return o;
        });
        for (const v of broker.violations.splice(0)) this.report.denied_calls.push({ tool: '(replay)', reason: v });
        this.report.segments.push({ program_id: p.rec.program_id, segment: seg, status: out.status, duration_ms: out.duration_ms, stdout_bytes: out.stdout_bytes, tool_calls_new: broker.journal.length - before, replayed: broker.replayed - replayedBefore, error: out.error, logs: out.logs.slice(0, 50) });
        writeFileSync(join(ctx.runDir, 'codemode', `${p.rec.program_id}.journal.json`), JSON.stringify(broker.journal.map((e: any) => ({ seq: e.seq, tool: e.tool, args_hash: e.args_hash, ok: e.ok, error: e.error ?? null })), null, 2));
        if (ctx.signal.aborted) throw new LabError('cancelled', 'Cancelled');
        if (out.status === 'suspended') continue;
        if (out.status === 'done') return out.result;
        throw new LabError(out.status === 'error' ? 'sandbox_violation' : 'sandbox_unavailable', `Code Mode program ${p.rec.program_id} ${out.status}: ${out.error ?? 'unknown error'}`);
      }
    } finally { await broker.stop(); }
  }
}

/** Collect denied tool calls from the host log for the console. */
export function deniedFromHost(host: ToolHost) { return host.toolLog.filter((t) => t.status === 'denied'); }
