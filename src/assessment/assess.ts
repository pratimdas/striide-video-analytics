import type { ToolHost } from '../orchestration/toolhost.js';
import type { ApprovalRegistry, DrillCandidate, SportSafety } from '../ontology/service.js';
import type { DeclaredContext } from '../orchestration/prompts.js';
import type { RunOutcome } from '../store/db.js';
import type { CompiledQuestion } from '../ontology/capabilities.js';

export type AnswerState = 'supported' | 'contradicted' | 'not_assessable' | 'uncertain';
export interface MergedAnswer {
  question_uid: string; question: string; protocol_uid: string; source: 'protocol' | 'recognition_overlay'; answer: 'yes' | 'partly' | 'no' | null;
  visibility: string; state: AnswerState; observation: string; evidence_ids: string[]; inspection_ids: string[]; disagreement: boolean; uncertainty: string | null; at_event: string | null; views: string[];
}
export interface Finding { finding_id: string; question_id: string; observation: string; interpretation: string | null; evidence_ids: string[]; state: AnswerState; measurement_kind: 'observed' | 'inferred' | 'measured' | 'not_assessable'; numeric_value: null; unit: null; uncertainty: string | null; approved_content_ids: string[] }
export interface DrillDecision { uid: string; name: string; eligible: boolean; reasons: string[]; drill: DrillCandidate }
export interface Assessment {
  activity: { sport_uid: string | null; sport_name: string | null; skill_uid: string | null; skill_name: string | null; protocol_uid: string | null; protocol_name: string | null; state: 'established' | 'provisional' | 'unknown'; disagreement: boolean; notes: string[] };
  answers: MergedAnswer[];
  findings: Finding[];
  strengths: Array<{ finding_id: string; question_uid: string; text: string; evidence_ids: string[] }>;
  priorities: Array<{ rank: number; finding_id: string; question_uid: string; text: string; reasoning: string; observability: string; evidence_ids: string[] }>;
  scores: { eligible: boolean; overall: number | null; rubric_id: string | null; reason: string | null; criteria: Array<{ question_uid: string; weight: number; value: number | null; coverage: string }> };
  radar: { render: boolean; reason: string };
  drills: { approved: DrillDecision[]; internal_drafts: DrillDecision[] };
  withheld: Array<{ where: string; reason: string }>;
  validation: { rejected_claims: Array<{ item: string; reason: string }>; notes: string[]; score_exclusions: string[]; template_fallbacks: string[]; issues: string[] };
  outcome: RunOutcome; outcome_reasons: string[];
  attempts_observed: number | null;
  polarity_note: string;
}

/** Text patterns that may never reach the athlete view (unsupported or unsafe claim types). */
const CLAIM_RULES: Array<[RegExp, string]> = [
  [/\b\d+(\.\d+)?\s*(°|deg\b|degrees?\b|km\/h|kph|mph|m\/s|cm\b|mm\b|metres?\b|meters?\b|ms\b|milliseconds?)/i, 'numeric measurement without an implemented measurement source'],
  [/\b(injur|pain|sore|strain|sprain|fatigue|tired|exhaust)/i, 'injury/pain/fatigue inference'],
  [/\b(weak(ness)?|lacks? (strength|power)|strength deficit|not strong|core strength)\b/i, 'strength inference from a short clip'],
  [/\b(anxious|anxiety|nervous|confiden(t|ce)|stress(ed)?|motivat|mental(ly)?|mindset|frustrat)/i, 'psychological-state inference'],
  [/\b(nutrition|diet|hydrat|overweight|underweight|calori|body fat)/i, 'nutrition/body inference'],
  [/\b(\d{1,2}[- ]?(year|yr)s?[- ]?old|aged \d+|age \d+)\b/i, 'age inference'],
  [/\b(grade [A-F][+-]?|score of \d|\d+\s*\/\s*10|\d+\s*out of\s*\d+|\d+(\.\d+)?\s*%)/i, 'grade/score claim'],
  [/\b(lock (the|your) knee|hyperextend|bend the back|arch (the|your) back hard)\b/i, 'unsafe cue'],
];

export function claimCheck(text: string, bannedCues: string[]): string | null {
  for (const [re, why] of CLAIM_RULES) if (re.test(text)) return why;
  const lower = text.toLowerCase();
  for (const c of bannedCues) if (c && lower.includes(c.toLowerCase())) return `banned cue "${c}"`;
  return null;
}

/** Drill eligibility: local approval registry, sport match and age restrictions. Unknown age never passes a minimum age. */
export function filterDrills(drills: DrillCandidate[], o: { approvals: ApprovalRegistry; sportKey: string | null; activityEstablished: boolean; ageYears: number | null; sportSafety: SportSafety | null; bannedCues: string[] }): { approved: DrillDecision[]; internal_drafts: DrillDecision[] } {
  const approved: DrillDecision[] = [], drafts: DrillDecision[] = [];
  for (const d of drills) {
    const reasons: string[] = [];
    if (!o.approvals.approved_drill_uids.includes(d.uid)) reasons.push('not approved in the local content registry (ontology status/tier is not approval)');
    if (!o.activityEstablished) reasons.push('activity not established');
    if (o.sportKey && d.sport && d.sport !== o.sportKey) reasons.push(`drill is for ${d.sport}, not ${o.sportKey}`);
    const minAges = [d.min_age, o.sportSafety?.safety_min_age ?? null].filter((x): x is number => typeof x === 'number');
    if (minAges.length) {
      const need = Math.max(...minAges);
      if (o.ageYears === null) reasons.push(`minimum age ${need} cannot be confirmed: age unknown`);
      else if (o.ageYears < need) reasons.push(`declared age ${o.ageYears} is below the minimum age ${need}`);
    }
    const cue = d.cues.find((c) => claimCheck(c, o.bannedCues));
    if (cue) reasons.push(`cue fails safety check: ${claimCheck(cue, o.bannedCues)}`);
    const dec = { uid: d.uid, name: d.name, eligible: reasons.length === 0, reasons, drill: d };
    (dec.eligible ? approved : drafts).push(dec);
  }
  return { approved, internal_drafts: drafts };
}

function mergeAnswers(host: ToolHost, questions: Map<string, CompiledQuestion>): MergedAnswer[] {
  const by = new Map<string, MergedAnswer>();
  for (const ins of host.inspections) {
    for (const a of ins.result.answers) {
      const q = questions.get(a.question_id);
      const prev = by.get(a.question_id);
      const cur: MergedAnswer = { question_uid: a.question_id, question: q?.question ?? a.question_id, protocol_uid: q?.protocol_uid ?? 'unknown', source: q?.source ?? 'protocol', answer: a.answer, visibility: a.visibility, state: a.state as AnswerState, observation: a.observation, evidence_ids: a.evidence_ids, inspection_ids: [ins.inspection_id], disagreement: false, uncertainty: a.uncertainty, at_event: q?.at_event ?? null, views: q?.views ?? [] };
      if (!prev) { by.set(a.question_id, cur); continue; }
      const informative = (x: MergedAnswer) => x.state === 'supported' || x.state === 'contradicted';
      if (informative(prev) && informative(cur) && prev.answer !== null && cur.answer !== null && prev.answer !== cur.answer) {
        by.set(a.question_id, { ...prev, state: 'uncertain', disagreement: true, inspection_ids: [...prev.inspection_ids, ins.inspection_id], uncertainty: `inspections disagree (${prev.answer} vs ${cur.answer})`, evidence_ids: [...new Set([...prev.evidence_ids, ...cur.evidence_ids])] });
      } else if (!informative(prev) && informative(cur)) by.set(a.question_id, { ...cur, inspection_ids: [...prev.inspection_ids, ins.inspection_id] });
      else by.set(a.question_id, { ...prev, inspection_ids: [...prev.inspection_ids, ins.inspection_id] });
    }
  }
  return [...by.values()];
}

export async function assess(host: ToolHost): Promise<Assessment> {
  const ctx: DeclaredContext | null = host.deps.context;
  const approvals = host.deps.ontology.getContentApprovals();
  const cfg = host.deps.ctx.lc.config;
  const questions = host.allQuestions();
  const validation: Assessment['validation'] = { rejected_claims: host.inspections.flatMap((i) => i.result.rejected), notes: [...(host.discovery?.notes ?? []), ...host.inspections.flatMap((i) => i.result.notes)], score_exclusions: [], template_fallbacks: [], issues: [] };
  const outcomeReasons: string[] = [];

  // Activity: Pegasus candidate and Gemini verdict on actual frames must agree to be established.
  const primary = host.compare?.primary ?? null;
  const verdicts = host.inspections.map((i) => i.result.activity_verdict);
  const last = verdicts.at(-1) ?? null;
  const notes: string[] = [];
  let sport: string | null = null; let state: Assessment['activity']['state'] = 'unknown'; let disagreement = false;
  if (last && last.sport_uid && primary?.sport_uid) {
    if (last.sport_uid === primary.sport_uid) { sport = last.sport_uid; state = last.state === 'established' ? 'established' : 'provisional'; }
    else {
      disagreement = true; notes.push(`Discovery suggested ${primary.sport_uid}; frame inspection indicated ${last.sport_uid}.`);
      const confirmed = host.inspections.some((i) => i.followup && i.result.activity_verdict.sport_uid === last.sport_uid && i.result.activity_verdict.state === 'established');
      if (confirmed) { sport = last.sport_uid; state = 'provisional'; notes.push('A follow-up inspection supported the inspector verdict; kept provisional because the providers disagreed.'); }
    }
  } else if (primary?.sport_uid) {
    sport = primary.sport_uid; state = primary.uncertainty === 'low' && (!last || last.state !== 'unknown') ? 'provisional' : 'unknown';
    if (!last) notes.push('No frame inspection verdict; Pegasus output alone is not independent visual verification.');
    else notes.push('Frame inspection did not establish the activity.');
    if (state === 'unknown') sport = null;
  }
  if (host.compare?.declared_conflict) notes.push('Declared context conflicts with the visual candidate; visible evidence was not overridden.');
  const cat = host.catalogue;
  const skillUid = sport && primary?.sport_uid === sport ? primary.skill_uid : null;
  let protocolUid: string | null = null;
  const plansForSport = [...host.plans.keys()].filter((u) => { const d = host.protocols.get(u); return d && sport && `sport:${d.sport}` === sport; });
  if (host.proposal?.primary_protocol_uid && plansForSport.includes(host.proposal.primary_protocol_uid)) protocolUid = host.proposal.primary_protocol_uid;
  else if (host.proposal?.primary_protocol_uid) { protocolUid = plansForSport[0] ?? null; validation.issues.push('Program proposed a protocol that does not match the established sport; the host ignored it.'); }
  else protocolUid = plansForSport[0] ?? null;
  const proto = protocolUid ? host.protocols.get(protocolUid)! : null;

  // Answers and findings (claim-checked for the athlete view).
  const answers = mergeAnswers(host, questions);
  const sportSafety = sport ? (await host.deps.ontology.getSportSafety([sport]))[0] ?? null : null;
  const banned = sportSafety?.banned_cues ?? [];
  const withheld: Assessment['withheld'] = [];
  const findings: Finding[] = [];
  for (const ins of host.inspections) for (const f of ins.result.findings) {
    const merged = answers.find((a) => a.question_uid === f.question_id);
    const text = `${f.observation} ${f.interpretation ?? ''}`;
    const bad = claimCheck(text, banned);
    if (bad) { withheld.push({ where: `finding ${f.finding_id}`, reason: bad }); validation.rejected_claims.push({ item: `finding ${f.finding_id}`, reason: `withheld from athlete view: ${bad}` }); continue; }
    findings.push({ ...f, state: (merged?.disagreement ? 'uncertain' : f.state) as AnswerState, measurement_kind: f.measurement_kind as Finding['measurement_kind'], numeric_value: null, unit: null });
  }
  for (const a of answers) { const bad = claimCheck(a.observation, banned); if (bad) { withheld.push({ where: `answer ${a.question_uid}`, reason: bad }); a.observation = '[Withheld: the model text contained an unsupported claim type.]'; } }

  // Strengths/priorities: protocol answers only, linked to findings; grouping assumes protocol questions describe target technique.
  const protoAnswers = answers.filter((a) => a.source === 'protocol' && (!protocolUid || a.protocol_uid === protocolUid));
  const findingFor = (a: MergedAnswer) => findings.find((f) => f.question_id === a.question_uid && f.evidence_ids.length > 0);
  const strengths: Assessment['strengths'] = []; const priorities: Assessment['priorities'] = [];
  if (state !== 'unknown') {
    for (const a of protoAnswers) {
      const f = findingFor(a); if (!f || a.disagreement) continue;
      if (a.state === 'supported' && a.answer === 'yes') strengths.push({ finding_id: f.finding_id, question_uid: a.question_uid, text: a.question, evidence_ids: f.evidence_ids });
    }
    const rank = (a: MergedAnswer) => (a.answer === 'no' ? 0 : 1) + (a.visibility === 'visible' ? 0 : 0.5);
    const cands = protoAnswers.filter((a) => (a.state === 'supported' || a.state === 'contradicted') && (a.answer === 'no' || a.answer === 'partly') && !a.disagreement && findingFor(a)).sort((x, y) => rank(x) - rank(y));
    cands.slice(0, 3).forEach((a, i) => { const f = findingFor(a)!; priorities.push({ rank: i + 1, finding_id: f.finding_id, question_uid: a.question_uid, text: a.question, reasoning: `Answered "${a.answer}" from ${a.visibility === 'visible' ? 'clearly visible' : 'partly visible'} frames; reviewed with a coach before acting.`, observability: a.visibility, evidence_ids: f.evidence_ids }); });
  }

  // Scores: only with an approved rubric, experimental scoring enabled and full evidence coverage.
  const rubric = approvals.rubrics?.find((r) => r.protocol_uid === protocolUid && approvals.approved_rubric_ids.includes(r.rubric_id)) ?? null;
  const scores: Assessment['scores'] = { eligible: false, overall: null, rubric_id: rubric?.rubric_id ?? null, reason: null, criteria: [] };
  if (!cfg.assessment.experimental_scoring) scores.reason = 'Scoring is disabled (assessment.experimental_scoring is false).';
  else if (!rubric) scores.reason = 'No reviewed rubric is configured for this protocol.';
  else if (state !== 'established') scores.reason = 'The activity is not established, so no rubric applies.';
  if (rubric) {
    scores.criteria = rubric.criteria.map((c) => { const a = answers.find((x) => x.question_uid === c.question_uid); const ok = a && (a.state === 'supported' || a.state === 'contradicted') && a.answer !== null && !a.disagreement; return { question_uid: c.question_uid, weight: c.weight, value: ok ? (a!.answer === 'yes' ? 1 : a!.answer === 'partly' ? 0.5 : 0) : null, coverage: ok ? 'assessed' : 'not assessable' }; });
    if (!scores.reason && scores.criteria.some((c) => c.value === null)) scores.reason = 'Not every rubric criterion is supported by visible evidence; no partial score is published.';
    if (!scores.reason) { const w = scores.criteria.reduce((n, c) => n + c.weight, 0); scores.overall = Math.round((scores.criteria.reduce((n, c) => n + c.weight * c.value!, 0) / w) * rubric.scale_max * 10) / 10; scores.eligible = true; }
  }
  if (!scores.eligible) validation.score_exclusions.push(scores.reason ?? 'not eligible');
  const radar = scores.eligible && scores.criteria.length >= 3 && scores.criteria.every((c) => c.value !== null) ? { render: true, reason: 'approved scored axes available' } : { render: false, reason: scores.eligible ? 'fewer than three approved scored axes' : `no approved scored axes (${scores.reason})` };

  // Drills.
  const drills = sport && (skillUid || protocolUid) ? await host.deps.ontology.getDrillCandidates({ skillUid, protocolUid }) : [];
  const drillDecisions = filterDrills(drills, { approvals, sportKey: sport ? sport.replace(/^sport:/, '') : null, activityEstablished: state === 'established', ageYears: ctx?.age_years ?? null, sportSafety, bannedCues: banned });

  // Outcome.
  let outcome: RunOutcome = 'completed_partial';
  const answered = protoAnswers.filter((a) => a.state === 'supported' || a.state === 'contradicted').length;
  const target = host.discovery?.target.state;
  if (!host.inspections.length) { outcomeReasons.push('No frame inspection completed.'); }
  if ((target === 'ambiguous') && !ctx?.target_person_hint) { outcome = 'needs_context'; outcomeReasons.push('Several people are visible and the target athlete is ambiguous; add a target-person hint.'); }
  else if (state === 'unknown' && (host.compare?.conflict || disagreement)) { outcome = 'needs_context'; outcomeReasons.push('Competing activity interpretations remained unresolved within the inspection budget.'); }
  else if (state === 'established' && proto && answered >= Math.max(1, Math.ceil(protoAnswers.length / 2))) { outcome = 'completed'; outcomeReasons.push('Activity established and most protocol questions were assessable.'); }
  else outcomeReasons.push(state === 'unknown' ? 'Activity could not be established; available observations are reported without technique assessment.' : 'Some protocol questions or the activity label are not fully supported.');
  if (target === 'none') outcomeReasons.push('No clear target athlete or action was visible.');

  const attemptText = host.discovery?.observations.map((o) => o.text).join(' ') ?? '';
  const attemptMatch = attemptText.match(/\b(one|single|1|two|2|three|3|four|4|five|5|six|6)\s+(attempts?|deliveries|delivery|repetitions?|reps?|shots?|throws?|strokes?)\b/i);
  const words: Record<string, number> = { one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const attempts = attemptMatch ? (words[attemptMatch[1]!.toLowerCase()] ?? Number(attemptMatch[1])) : null;

  return {
    activity: { sport_uid: sport, sport_name: cat?.sports.find((s) => s.uid === sport)?.name ?? null, skill_uid: skillUid, skill_name: cat?.skills.find((k) => k.uid === skillUid)?.name ?? null, protocol_uid: protocolUid, protocol_name: proto?.display_name ?? null, state, disagreement, notes },
    answers, findings, strengths, priorities, scores, radar, drills: drillDecisions, withheld, validation, outcome, outcome_reasons: outcomeReasons, attempts_observed: attempts,
    polarity_note: 'Strengths and priorities assume each protocol question describes the target technique ("yes" = target seen). This grouping is provisional and needs coach review.',
  };
}
