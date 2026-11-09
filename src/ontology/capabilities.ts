import type { ProtocolDetail, QuestionDetail } from './service.js';

/**
 * What this lab can actually measure. There is no pose, ball, implement or calibration pipeline,
 * so every numeric ontology metric is excluded regardless of its definition. Ontology detector
 * engineStatus values ("pending", "in_spec") describe specifications, not running detectors.
 */
export const LAB_CAPABILITIES = {
  implemented_capabilities: [] as string[],
  implemented_detectors: [] as string[],
  qualitative_visual_inspection: true,
  event_localisation: 'approximate_model_windows' as const,
};

/** Answer vocabularies representable in the lab inspection contract (yes/partly/no or null). */
const CANON = new Set(['yes', 'partly', 'no']);
const NULLISH = /^(unclear|not_visible|.*_not_visible|no_board_visible|unknown)$/;

export interface CompiledQuestion {
  uid: string; question_id: string; question: string; protocol_uid: string; answer_enum: string[]; views: string[]; crop: string | null;
  at_event: string | null; event_timing: 'approximate' | 'not_applicable'; notes: string[]; source: 'protocol' | 'recognition_overlay';
}
export interface Exclusion { kind: 'metric' | 'question' | 'fault' | 'strength' | 'event'; uid: string; reason: string }
export interface CompiledPlan {
  protocol_uid: string; questions: CompiledQuestion[]; exclusions: Exclusion[]; capture: { preferred_views: string[]; min_fps: number | null; recommended_fps: number | null; tips: string[] };
  fps_note: string | null; phases: ProtocolDetail['phases'];
}

export function representable(enumValues: string[]): boolean {
  return enumValues.length > 0 && enumValues.every((v) => CANON.has(v) || NULLISH.test(v)) && enumValues.some((v) => CANON.has(v));
}

/** Compile a protocol into supported qualitative questions, preserving every exclusion and its reason. */
export function compileProtocol(p: ProtocolDetail, opts: { sourceFps: number | null; maxQuestions: number; allowPoseMetrics: false }): CompiledPlan {
  const exclusions: Exclusion[] = [];
  for (const m of p.metrics) {
    const caps = m.requires_capabilities.map((c) => c.replace(/^capability:/, ''));
    const measureKinds = [...new Set(m.measures.map((x) => x.kind).filter(Boolean))];
    const reason = caps.length
      ? `requires ${caps.join(', ')} capability, not implemented in this lab`
      : `numeric ${m.fn ?? 'measurement'} from ${measureKinds.join('/') || 'keypoint'} measures needs a validated pose/tracking source; none is implemented`;
    exclusions.push({ kind: 'metric', uid: m.uid, reason });
  }
  for (const f of p.faults) exclusions.push({ kind: 'fault', uid: f.uid, reason: 'fault is triggered by numeric metric bands that this lab cannot measure; not reported as a finding' });
  for (const s of p.strengths) exclusions.push({ kind: 'strength', uid: s.uid, reason: 'strength template depends on a numeric metric; not reported' });
  for (const e of p.events) if (e.detector) exclusions.push({ kind: 'event', uid: e.uid, reason: `detector ${e.detector.uid} (${e.detector.engine_status ?? 'unknown'}) is a specification, not a running detector; event timing is approximate from model windows` });

  const questions: CompiledQuestion[] = [];
  for (const q of p.questions) {
    if (!representable(q.answer_enum)) { exclusions.push({ kind: 'question', uid: q.uid, reason: `answer vocabulary [${q.answer_enum.join('/')}] cannot be represented by the lab inspection contract (yes/partly/no/null); retained internally only` }); continue; }
    const notes: string[] = [];
    if (q.cross_check_metric_uids.length) notes.push('metric cross-check unavailable (no measurement source)');
    if (q.at_event) notes.push(`asked at ${q.at_event.kind}; located approximately, not by a detector`);
    if (opts.sourceFps && q.offsets_ms.length > 1) {
      const span = Math.max(...q.offsets_ms) - Math.min(...q.offsets_ms);
      if (span > 0 && span < 1000 / opts.sourceFps) notes.push(`frame offsets ${q.offsets_ms.join('/')} ms are finer than the ${opts.sourceFps.toFixed(0)} fps recording`);
    }
    questions.push({ uid: q.uid, question_id: q.question_id, question: q.question, protocol_uid: p.uid, answer_enum: q.answer_enum, views: q.views, crop: q.crop, at_event: q.at_event?.kind ?? null, event_timing: q.at_event ? 'approximate' : 'not_applicable', notes, source: 'protocol' });
  }
  const kept = questions.slice(0, opts.maxQuestions);
  for (const q of questions.slice(opts.maxQuestions)) exclusions.push({ kind: 'question', uid: q.uid, reason: `over the per-run question budget (${opts.maxQuestions})` });
  const fpsNote = opts.sourceFps && p.min_fps && opts.sourceFps < p.min_fps ? `Recorded at about ${opts.sourceFps.toFixed(0)} fps; the protocol lists ${p.min_fps} fps for measurements. Qualitative observations are still made where visible.` : null;
  return { protocol_uid: p.uid, questions: kept, exclusions, capture: { preferred_views: p.preferred_views, min_fps: p.min_fps, recommended_fps: p.recommended_fps, tips: p.capture_tips }, fps_note: fpsNote, phases: p.phases };
}

export function questionFromOverlay(sportUid: string, activity: string, index: number, text: string): CompiledQuestion {
  return { uid: `overlay:${sportUid.replace(/^sport:/, '')}.${activity}/q${index + 1}`, question_id: `recognition_${index + 1}`, question: text, protocol_uid: 'overlay', answer_enum: ['yes', 'partly', 'no'], views: [], crop: null, at_event: null, event_timing: 'not_applicable', notes: ['draft recognition overlay question (not validated)'], source: 'recognition_overlay' };
}

export type { QuestionDetail };
