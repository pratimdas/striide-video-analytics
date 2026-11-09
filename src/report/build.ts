import type { Assessment } from '../assessment/assess.js';
import type { ToolHost } from '../orchestration/toolhost.js';
import type { MediaManifest } from '../media/prepare.js';
import type { DeclaredContext } from '../orchestration/prompts.js';
import type { RunOutcome } from '../store/db.js';
import { validateContract } from '../contracts.js';
import { scrubPaths } from '../util/paths.js';

export type SectionState = 'available' | 'partial' | 'not_assessable' | 'not_available' | 'review_needed' | 'disabled' | 'not_inferred';
export type Section = { state: SectionState; reason: string | null } & Record<string, unknown>;

/** Every section in docs/02 is always present with an explicit state; nothing silently disappears. */
export const SECTION_ORDER = ['header', 'video_and_context', 'summary', 'overall_grade', 'criterion_breakdown', 'radar', 'strengths', 'priorities', 'action_timeline', 'detailed_findings', 'technique', 'tactics_and_outcomes', 'strength_mental_nutrition', 'drills_and_content', 'next_session_plan', 'limitations', 'recording_guidance', 'review_and_feedback'] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];
export const SECTION_TITLES: Record<SectionKey, string> = {
  header: 'Header', video_and_context: 'Video and context', summary: 'Summary', overall_grade: 'Overall grade', criterion_breakdown: 'Criterion breakdown', radar: 'Radar', strengths: 'Strengths', priorities: 'Priorities',
  action_timeline: 'Action timeline', detailed_findings: 'Detailed findings', technique: 'Technique', tactics_and_outcomes: 'Tactics and outcomes', strength_mental_nutrition: 'Strength, mental resilience and nutrition',
  drills_and_content: 'Drills and content', next_session_plan: 'Next-session plan', limitations: 'Limitations', recording_guidance: 'Better recording guidance', review_and_feedback: 'Review and feedback',
};

export interface EvidenceRef { evidence_id: string; source_media_id: string; start_seconds: number; end_seconds: number; frame_pts_seconds: number[]; visibility: 'visible' | 'partly_visible' | 'not_visible' | 'uncertain'; artifact_refs: string[] }

export interface LabReport {
  schema_version: 'lab-report-0.1'; run_id: string; status: RunOutcome;
  activity: { sport_uid: string | null; skill_uid: string | null; state: 'established' | 'provisional' | 'unknown' };
  context: Record<string, unknown>; summary: string; findings: Assessment['findings']; evidence: EvidenceRef[];
  scores: { eligible: boolean; overall: number | null; rubric_id: string | null; reason: string | null; criteria: object[] };
  limitations: string[]; recommendations: object[]; phases: object[]; pillar_support: Record<string, unknown>; provenance: Record<string, unknown>; sections: Record<string, unknown>;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

export function summaryText(a: Assessment, attemptsWindows: number): { text: string; template: string } {
  const label = a.activity.skill_name ? `${a.activity.skill_name} (${a.activity.sport_name})` : a.activity.sport_name ?? 'an activity that could not be identified with confidence';
  const stateWord = a.activity.state === 'established' ? 'established from the frames' : a.activity.state === 'provisional' ? 'provisional' : 'not established';
  const proto = a.answers.filter((x) => x.source === 'protocol');
  const assessed = proto.filter((x) => x.state === 'supported' || x.state === 'contradicted').length;
  const parts = [`The clip shows ${label}; the activity label is ${stateWord}.`];
  if (attemptsWindows) parts.push(`${attemptsWindows} approximate action window${attemptsWindows === 1 ? '' : 's'} ${attemptsWindows === 1 ? 'was' : 'were'} identified.`);
  if (proto.length) parts.push(`${assessed} of ${proto.length} protocol question${proto.length === 1 ? '' : 's'} could be assessed from the visible footage.`);
  const q = (x: string) => x.replace(/\s*Answer only from what is visible\.?/i, '').trim();
  if (a.strengths[0]) parts.push(`Principal strength: the frames support "yes" to "${q(a.strengths[0].text)}"`);
  if (a.priorities[0]) parts.push(`Main priority to review with a coach: "${q(a.priorities[0].text)}"`);
  return { text: parts.join(' '), template: 'summary-template-v1' };
}

export function buildReports(o: { host: ToolHost; a: Assessment; media: MediaManifest; context: DeclaredContext | null; runId: string; createdAt: string; mode: string; provenance: Record<string, unknown> }) {
  const { host, a, media } = o;
  const playbackId = media.playback.media_id;
  const vis = new Map<string, EvidenceRef['visibility']>();
  const order: Record<string, number> = { visible: 0, partly_visible: 1, uncertain: 2, not_visible: 3 };
  for (const ans of a.answers) for (const id of ans.evidence_ids) { const v = (ans.visibility as EvidenceRef['visibility']) ?? 'uncertain'; if (!vis.has(id) || order[v]! < order[vis.get(id)!]!) vis.set(id, v); }
  const usedIds = new Set([...a.findings.flatMap((f) => f.evidence_ids), ...a.answers.flatMap((x) => x.evidence_ids)]);
  const evidence: EvidenceRef[] = [];
  for (const p of host.packets.values()) {
    evidence.push({ evidence_id: p.packet_id, source_media_id: playbackId, start_seconds: p.context_start_seconds, end_seconds: p.context_end_seconds, frame_pts_seconds: p.frames.map((f) => f.t), visibility: 'uncertain', artifact_refs: p.frames.map((f) => f.rel_path) });
    for (const f of p.frames) if (usedIds.has(f.evidence_id)) evidence.push({ evidence_id: f.evidence_id, source_media_id: playbackId, start_seconds: f.t, end_seconds: f.t, frame_pts_seconds: [f.t], visibility: vis.get(f.evidence_id) ?? 'uncertain', artifact_refs: [f.rel_path] });
  }
  const windows = host.discovery?.action_windows ?? [];
  const summary = summaryText(a, windows.length);
  const plan = a.activity.protocol_uid ? host.plans.get(a.activity.protocol_uid) ?? null : null;
  const durationS = host.describe().duration_s;

  const limitations: string[] = [];
  limitations.push(...media.notes);
  if (a.attempts_observed === 1 || windows.length <= 1) limitations.push('A single observed attempt cannot establish repeatability.');
  if (plan?.fps_note) limitations.push(plan.fps_note);
  if (plan) { const nMetric = plan.exclusions.filter((e) => e.kind === 'metric').length; if (nMetric) limitations.push(`${nMetric} numeric measurement${nMetric === 1 ? '' : 's'} defined by the protocol ${nMetric === 1 ? 'is' : 'are'} unavailable: no validated pose or tracking source is implemented in this lab.`); }
  const notVisible = a.answers.filter((x) => x.state === 'not_assessable');
  if (notVisible.length) limitations.push(`${notVisible.length} question${notVisible.length === 1 ? ' was' : 's were'} not assessable from the available view or detail (not counted as a failed skill).`);
  if (a.activity.state !== 'established') limitations.push(`Activity label is ${a.activity.state}.`);
  if (!a.scores.eligible) limitations.push(`No score is shown: ${a.scores.reason}`);
  for (const l of [...(host.discovery?.limitations ?? []), ...host.inspections.flatMap((i) => i.result.limitations)]) { const clean = scrubPaths(l); if (!limitations.includes(clean)) limitations.push(clean); }
  if (a.withheld.length) limitations.push(`${a.withheld.length} model statement${a.withheld.length === 1 ? ' was' : 's were'} withheld because they contained unsupported claim types.`);

  const capture: string[] = [];
  if (plan) { capture.push(...plan.capture.tips); if (plan.capture.preferred_views.length) capture.push(`Preferred camera views for this protocol: ${plan.capture.preferred_views.join(', ')}.`); if (plan.capture.recommended_fps) capture.push(`Record at ${plan.capture.recommended_fps} fps or higher where the phone supports it (protocol minimum ${plan.capture.min_fps ?? 'not stated'} fps).`); }
  if (windows.length <= 1) capture.push('Record several comparable attempts in one clip so consistency can be reviewed.');
  if (media.prepared.transforms.some((t) => /upscaled/.test(t))) capture.push('Use a higher recording resolution; the source was below the provider minimum.');
  if (a.activity.state !== 'established') capture.push('Keep the whole athlete and the full action in frame from start to finish so the activity can be recognised.');
  if (host.discovery?.target.state === 'ambiguous') capture.push('Frame one athlete clearly, or provide a target-person hint, when several people are visible.');

  const phases = (plan?.phases ?? []).map((p) => ({ name: p.name, order: p.order, from_event: p.from_event, to_event: p.to_event, timing: 'not measured: no event detector is implemented; see approximate action windows' }));
  const timeline = windows.map((w) => ({ window_id: w.window_id, start_seconds: w.start_seconds, end_seconds: w.end_seconds, label: w.label, approximate: true, source: 'video discovery model (approximate)' }));

  const sec = (state: SectionState, reason: string | null = null): Section => ({ state, reason });
  const anyAssessed = a.answers.some((x) => x.source === 'protocol' && (x.state === 'supported' || x.state === 'contradicted'));
  const sections: Record<SectionKey, Section> = {
    header: { ...sec('available'), report_id: o.runId, created_at: o.createdAt, assessment_status: o.a.outcome },
    video_and_context: { ...sec('available'), duration_s: durationS, view: 'not established (camera view is not classified by this lab)', declared_context: declaredContext(o.context), visual_activity: { sport: a.activity.sport_name, skill: a.activity.skill_name, state: a.activity.state } },
    summary: { ...sec(a.activity.state === 'unknown' ? 'partial' : 'available', a.activity.state === 'unknown' ? 'activity not established' : null), template: summary.template },
    overall_grade: sec(a.scores.eligible ? 'available' : 'not_available', a.scores.eligible ? null : a.scores.reason),
    criterion_breakdown: { ...sec(a.scores.criteria.length ? (a.scores.eligible ? 'available' : 'partial') : 'not_available', a.scores.criteria.length ? (a.scores.eligible ? null : a.scores.reason) : 'No reviewed rubric defines criteria for this protocol; no default sport metrics are invented.'), coverage: { protocol_questions: a.answers.filter((x) => x.source === 'protocol').length, assessed: a.answers.filter((x) => x.source === 'protocol' && (x.state === 'supported' || x.state === 'contradicted')).length } },
    radar: sec(a.radar.render ? 'available' : 'not_available', a.radar.render ? null : `Not drawn: ${a.radar.reason}. Missing values are never shown as zero.`),
    strengths: sec(a.strengths.length ? 'available' : anyAssessed ? 'not_assessable' : 'not_assessable', a.strengths.length ? null : 'No strength is supported by visible evidence in this clip.'),
    priorities: sec(a.priorities.length ? 'available' : 'not_assessable', a.priorities.length ? null : 'No improvement priority is supported by visible evidence in this clip.'),
    action_timeline: sec(timeline.length ? 'available' : 'not_available', timeline.length ? 'Times are approximate model windows; phase timing is not measured.' : 'No action windows were identified.'),
    detailed_findings: sec(a.findings.length ? 'available' : 'not_assessable', a.findings.length ? null : 'No finding passed evidence validation.'),
    technique: sec(anyAssessed ? 'available' : 'not_assessable', anyAssessed ? null : 'No protocol question could be assessed from the visible footage.'),
    tactics_and_outcomes: sec('not_assessable', 'Situation, ball flight, target and result are not assessed by this lab protocol set; they are not inferred from a short clip.'),
    strength_mental_nutrition: { ...sec('not_inferred', 'Strength, mental resilience and nutrition are never inferred from a short clip. Approved resources can be linked here by a coach.'), pillars: { strength: 'not_inferred', mental_resilience: 'not_inferred', nutrition: 'not_inferred' } },
    drills_and_content: sec(a.drills.approved.length ? 'available' : 'review_needed', a.drills.approved.length ? null : `No reviewed drill is approved and applicable (${a.drills.internal_drafts.length} draft candidate${a.drills.internal_drafts.length === 1 ? '' : 's'} kept in the internal area).`),
    next_session_plan: sec(a.drills.approved.length ? 'available' : 'review_needed', a.drills.approved.length ? 'Assembled only from approved items; no workload is invented.' : 'Coach review needed; no approved items are available, so only recording guidance is offered.'),
    limitations: sec('available'),
    recording_guidance: sec(capture.length ? 'available' : 'not_available', capture.length ? null : 'No protocol-specific guidance available.'),
    review_and_feedback: sec('available', 'A coach can correct one finding or event interval and save it against this report version.'),
  };

  const pillar_support = { technique: anyAssessed ? 'assessed_qualitatively' : 'not_assessable', tactics: 'not_assessable', strength: 'not_inferred', mental_resilience: 'not_inferred', nutrition: 'not_inferred' };
  const recommendations = a.drills.approved.map((d) => ({ drill_uid: d.uid, name: d.name, purpose: d.drill.focus, instructions: d.drill.cues, dosage: d.drill.dosage, safety_note: d.drill.safety_note }));
  const report: LabReport = {
    schema_version: 'lab-report-0.1', run_id: o.runId, status: a.outcome,
    activity: { sport_uid: a.activity.sport_uid, skill_uid: a.activity.skill_uid, state: a.activity.state },
    context: declaredContext(o.context), summary: summary.text, findings: a.findings, evidence,
    scores: { eligible: a.scores.eligible, overall: a.scores.overall, rubric_id: a.scores.rubric_id, reason: a.scores.reason, criteria: a.scores.criteria },
    limitations, recommendations, phases, pillar_support, provenance: o.provenance,
    sections: { ...sections, _timeline: timeline, _capture_guidance: capture, _strengths: a.strengths, _priorities: a.priorities, _answers: a.answers.map((x) => ({ question_uid: x.question_uid, question: x.question, source: x.source, answer: x.answer, visibility: x.visibility, state: x.state, observation: x.observation, evidence_ids: x.evidence_ids, disagreement: x.disagreement, at_event: x.at_event })), _polarity_note: a.polarity_note, _activity: a.activity, _outcome_reasons: a.outcome_reasons },
  };
  const v = validateContract('lab-contract', report);
  if (!v.ok) a.validation.issues.push(`report.json failed the lab contract: ${v.errors.join('; ')}`);
  return { report, contractValid: v.ok, timeline, capture, sections };
}

export function declaredContext(c: DeclaredContext | null): Record<string, unknown> {
  if (!c) return { supplied: false };
  const out: Record<string, unknown> = { supplied: true };
  for (const k of ['sport', 'discipline', 'skill', 'format', 'age_years', 'goal', 'handedness', 'ball_type', 'target_person_hint'] as const) if (c[k] !== null && c[k] !== undefined && c[k] !== '') out[k] = c[k];
  return out;
}

/**
 * Athlete/coach export DTO, built from an explicit allowlist. It contains no telemetry, raw provider output,
 * model IDs, filesystem paths, provider asset IDs or secrets. Hiding an internal tab with CSS is not used.
 */
export interface AthleteReport {
  schema: 'striideai-athlete-report-0.1'; report_id: string; report_version: number; created_at: string; status: RunOutcome; status_label: string;
  activity: { sport: string | null; skill: string | null; protocol: string | null; state: string };
  context: Record<string, unknown>; video: { duration_s: number; media_id: string; playback_offset_s: number };
  summary: string;
  sections: Array<{ key: SectionKey; title: string; state: SectionState; reason: string | null }>;
  grade: { shown: boolean; value: number | null; reason: string | null };
  criteria: Array<{ question: string; coverage: string; value: number | null }>;
  strengths: Array<{ finding_id: string; text: string; evidence: Array<{ evidence_id: string; t: number }> }>;
  priorities: Array<{ rank: number; finding_id: string; text: string; reasoning: string; observability: string; evidence: Array<{ evidence_id: string; t: number }> }>;
  timeline: Array<{ label: string; start_seconds: number; end_seconds: number; approximate: true }>;
  phases: Array<{ name: string; timing: string }>;
  findings: Array<{ finding_id: string; question: string; observation: string; interpretation: string | null; state: string; visibility: string; uncertainty: string | null; evidence: Array<{ evidence_id: string; t: number; thumbnail: string }> }>;
  technique: Array<{ question: string; answer: string | null; state: string; visibility: string; observation: string; evidence: Array<{ evidence_id: string; t: number }> }>;
  pillars: Record<string, string>;
  drills: Array<{ name: string; purpose: string[]; instructions: string[]; dosage: unknown; safety_note: string | null; links: Array<{ label: string; url: string }> }>;
  next_session: string;
  limitations: string[];
  recording_guidance: string[];
  notes: string[];
  /** Present only for runs made with offline test doubles; such output is never a real analysis. */
  fixture_notice: string | null;
}

const STATUS_LABEL: Record<RunOutcome, string> = { completed: 'Assessment complete', completed_partial: 'Partial assessment', needs_context: 'More context needed', rejected: 'Video not accepted', failed: 'Analysis failed', cancelled: 'Cancelled' };

export function athleteDto(o: { report: LabReport; a: Assessment; host: ToolHost; reportVersion: number; durationS: number; playbackMediaId: string; playbackOffsetS: number; contentLinks: Array<{ drill_uid: string; label: string; url: string }>; approvedUrls: string[] }): AthleteReport {
  const { report, a, host } = o;
  const t = (id: string) => host.evidence.get(id)?.t ?? null;
  const ev = (ids: string[]) => ids.map((id) => ({ evidence_id: id, t: t(id) })).filter((x): x is { evidence_id: string; t: number } => x.t !== null);
  const clean = (s: string) => scrubPaths(s).replace(/\s*Answer only from what is visible\.?/i, '');
  const qText = new Map(a.answers.map((x) => [x.question_uid, clean(x.question)]));
  const sections = SECTION_ORDER.map((k) => { const s = (report.sections as any)[k] as Section; return { key: k, title: SECTION_TITLES[k], state: s.state, reason: s.reason }; });
  return {
    schema: 'striideai-athlete-report-0.1', report_id: report.run_id, report_version: o.reportVersion, created_at: String((report.sections as any).header.created_at), status: report.status, status_label: STATUS_LABEL[report.status],
    activity: { sport: a.activity.sport_name, skill: a.activity.skill_name, protocol: a.activity.protocol_name, state: a.activity.state },
    context: report.context, video: { duration_s: o.durationS, media_id: o.playbackMediaId, playback_offset_s: o.playbackOffsetS },
    summary: clean(report.summary), sections,
    grade: { shown: a.scores.eligible, value: a.scores.eligible ? a.scores.overall : null, reason: a.scores.reason },
    criteria: a.scores.criteria.map((c) => ({ question: qText.get(c.question_uid) ?? 'criterion', coverage: c.coverage, value: c.value })),
    strengths: a.strengths.map((s) => ({ finding_id: s.finding_id, text: clean(s.text), evidence: ev(s.evidence_ids) })),
    priorities: a.priorities.map((p) => ({ rank: p.rank, finding_id: p.finding_id, text: clean(p.text), reasoning: p.reasoning, observability: p.observability, evidence: ev(p.evidence_ids) })),
    timeline: (host.discovery?.action_windows ?? []).map((w) => ({ label: clean(w.label), start_seconds: w.start_seconds, end_seconds: w.end_seconds, approximate: true as const })),
    phases: report.phases.map((p: any) => ({ name: p.name, timing: 'approximate; not measured' })),
    findings: a.findings.map((f) => { const ans = a.answers.find((x) => x.question_uid === f.question_id); return { finding_id: f.finding_id, question: qText.get(f.question_id) ?? '', observation: clean(f.observation), interpretation: f.interpretation ? clean(f.interpretation) : null, state: f.state, visibility: ans?.visibility ?? 'uncertain', uncertainty: f.uncertainty ? clean(f.uncertainty) : null, evidence: ev(f.evidence_ids).map((e) => ({ ...e, thumbnail: `evidence/${e.evidence_id}.jpg` })) }; }),
    technique: a.answers.filter((x) => x.source === 'protocol').map((x) => ({ question: clean(x.question), answer: x.answer, state: x.state, visibility: x.visibility, observation: clean(x.observation), evidence: ev(x.evidence_ids) })),
    pillars: report.pillar_support as Record<string, string>,
    drills: a.drills.approved.map((d) => ({ name: d.name, purpose: d.drill.focus, instructions: d.drill.cues, dosage: d.drill.dosage, safety_note: d.drill.safety_note, links: o.contentLinks.filter((l) => l.drill_uid === d.uid && o.approvedUrls.includes(l.url)).map((l) => ({ label: l.label, url: l.url })) })),
    next_session: a.drills.approved.length ? 'Use the approved drills above as agreed with your coach; no workload is prescribed by this report.' : 'Coach review needed. No approved drills are available for this clip, so no session plan is generated. Use the recording guidance to capture a clip that supports a fuller review.',
    limitations: report.limitations.map(clean),
    recording_guidance: ((report.sections as any)._capture_guidance as string[]).map(clean),
    notes: [a.polarity_note, ...a.activity.notes.map(clean)],
    fixture_notice: (report.provenance as any).fixture ? 'Generated with offline mock providers for testing. This is not an analysis of real footage by TwelveLabs or Gemini.' : null,
  };
}
