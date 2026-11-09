import type { ToolHost } from './toolhost.js';
import type { SpanContext } from '../telemetry/trace.js';
// The reviewed program is a trusted, version-controlled module imported normally (no eval).
import reviewedProgram from '../../programs/reviewed/default-v1.js';

/** Build the same namespaced tool surface the sandbox exposes, bound to the host in-process. */
export function inProcessTools(host: ToolHost, root: SpanContext) {
  let seq = 0;
  const call = (name: string) => (args: unknown) => host.call(name, args ?? {}, { origin: 'fixed', segment: null, seq: seq++, parent: root });
  return Object.freeze({
    media: Object.freeze({ describe: call('media.describe'), extractEvidence: call('media.extractEvidence') }),
    ontology: Object.freeze({ getCatalogue: call('ontology.getCatalogue'), getRecognitionProfiles: call('ontology.getRecognitionProfiles'), getProtocol: call('ontology.getProtocol') }),
    video: Object.freeze({ discover: call('video.discover') }),
    vision: Object.freeze({ inspect: call('vision.inspect') }),
    assessment: Object.freeze({ validate: call('assessment.validate'), calculate: call('assessment.calculate') }),
    report: Object.freeze({ assemble: call('report.assemble') }),
  });
}

/** ontology_fixed: the reviewed program with the same managed tools; no generated orchestration. */
export async function runFixed(host: ToolHost, root: SpanContext): Promise<unknown> {
  const { ctx } = host.deps;
  const input = {
    limits: { max_frames_per_packet: ctx.lc.config.media.max_frames_per_packet, max_evidence_frames_total: ctx.lc.config.media.max_evidence_frames_total, max_questions: ctx.lc.config.ontology.maximum_questions_per_run, max_protocols: ctx.lc.config.ontology.maximum_protocols_per_run },
    budgets: { followups_remaining: ctx.budget.limits.max_followup_model_requests - ctx.budget.followups, model_requests_remaining: ctx.budget.limits.max_generated_model_requests - ctx.budget.generatedRequests, tool_calls_remaining: ctx.lc.config.code_mode.max_tool_calls - ctx.budget.toolCalls },
    declared_context_present: !!host.deps.context,
  };
  return (reviewedProgram as any)(inProcessTools(host, root), input);
}
