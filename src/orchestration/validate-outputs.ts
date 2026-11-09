import { validateContract } from '../contracts.js';
import { LabError } from '../util/errors.js';
import type { Catalogue } from '../ontology/service.js';
import type { EvidencePacket } from '../media/evidence.js';
import type { DeclaredContext } from './prompts.js';

export interface ValidatedCandidate {
  rank: number; sport_uid: string | null; sport_in_catalogue: boolean; skill_uid: string | null; skill_label: string | null; activity_type: string | null;
  supporting_evidence: string[]; contradicting_evidence: string[]; uncertainty: 'low' | 'medium' | 'high' | 'unknown'; distinguishing_questions: string[];
}
export interface ActionWindow { window_id: string; start_seconds: number; end_seconds: number; label: string; approximate: true }
export interface ValidatedDiscovery {
  candidates: ValidatedCandidate[]; action_windows: ActionWindow[]; observations: Array<{ observation_id: string; text: string; window_ids: string[] }>;
  target: { state: 'single_subject' | 'specified_subject' | 'ambiguous' | 'none'; description: string }; limitations: string[]; notes: string[];
}

const UNC_RANK = { low: 0, medium: 1, high: 2, unknown: 3 } as const;

/** Schema validation is necessary but not sufficient: IDs, windows and references are checked against host state. */
export function validateDiscovery(raw: unknown, cat: Catalogue, durationS: number): ValidatedDiscovery {
  const v = validateContract('discovery', raw);
  if (!v.ok) throw new LabError('schema_invalid', `Discovery output failed the canonical contract: ${v.errors.slice(0, 5).join('; ')}`, { details: { errors: v.errors } });
  const d = raw as any; const notes: string[] = [];
  const sports = new Set(cat.sports.map((s) => s.uid));
  const skillByUid = new Map(cat.skills.map((k) => [k.uid, k]));
  const windows: ActionWindow[] = []; const seen = new Set<string>();
  for (const w of d.action_windows) {
    const id = String(w.window_id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || `w${windows.length + 1}`;
    if (seen.has(id)) { notes.push(`duplicate window ${id} dropped`); continue; }
    let s = Number(w.start_seconds), e = Number(w.end_seconds);
    if (!(e >= s)) { notes.push(`window ${id} has end before start; dropped`); continue; }
    if (s > durationS) { notes.push(`window ${id} starts after the clip ends; dropped`); continue; }
    if (e > durationS) { notes.push(`window ${id} end clamped to clip duration`); e = durationS; }
    s = Math.max(0, s);
    seen.add(id); windows.push({ window_id: id, start_seconds: s, end_seconds: e, label: String(w.label).slice(0, 200), approximate: true });
  }
  const candidates: ValidatedCandidate[] = d.candidates.map((c: any, i: number) => {
    const inCat = c.sport_uid !== null && sports.has(c.sport_uid);
    if (c.sport_uid !== null && !inCat) notes.push(`candidate ${i + 1} sport ${String(c.sport_uid).slice(0, 60)} is not in the catalogue; treated as out-of-catalogue`);
    let skillUid: string | null = null;
    if (typeof c.skill_label === 'string') {
      const k = skillByUid.get(c.skill_label);
      if (k && (!inCat || k.sport_uid === c.sport_uid)) skillUid = k.uid;
      else if (inCat) {
        const label = c.skill_label.toLowerCase();
        const match = cat.skills.find((s) => s.sport_uid === c.sport_uid && (s.name.toLowerCase() === label || s.aliases.some((a) => a.toLowerCase() === label)));
        if (match) skillUid = match.uid;
      }
    }
    return { rank: i + 1, sport_uid: inCat ? c.sport_uid : null, sport_in_catalogue: inCat, skill_uid: skillUid, skill_label: c.skill_label ?? null, activity_type: c.activity_type ?? null, supporting_evidence: c.supporting_evidence, contradicting_evidence: c.contradicting_evidence, uncertainty: c.uncertainty, distinguishing_questions: c.distinguishing_questions ?? [] };
  });
  candidates.sort((a, b) => UNC_RANK[a.uncertainty] - UNC_RANK[b.uncertainty] || a.rank - b.rank);
  const winIds = new Set(windows.map((w) => w.window_id));
  const observations = d.observations.map((o: any) => {
    const bad = o.window_ids.filter((x: string) => !winIds.has(x));
    if (bad.length) notes.push(`observation ${o.observation_id} cites unknown windows`);
    return { observation_id: String(o.observation_id).slice(0, 40), text: String(o.text).slice(0, 600), window_ids: o.window_ids.filter((x: string) => winIds.has(x)) };
  });
  return { candidates, action_windows: windows, observations, target: d.target, limitations: d.limitations.map((x: string) => String(x).slice(0, 400)), notes };
}

export interface CompareDecision {
  primary: ValidatedCandidate | null;
  competing: ValidatedCandidate[];
  conflict: boolean;
  declared_conflict: boolean;
  out_of_catalogue: boolean;
  reasons: string[];
}

/** Host-side comparison: venue or a shared gesture never settles the label; conflicts trigger bounded inspection. */
export function compareCandidates(d: ValidatedDiscovery, ctx: DeclaredContext | null, cat: Catalogue): CompareDecision {
  const inCat = d.candidates.filter((c) => c.sport_in_catalogue);
  const primary = inCat[0] ?? null;
  const reasons: string[] = [];
  const competing = inCat.filter((c) => primary && c.sport_uid !== primary.sport_uid && c.uncertainty !== 'high').slice(0, 2);
  if (competing.length) reasons.push(`Competing candidates ${[primary!, ...competing].map((c) => c.sport_uid).join(' vs ')}: recognition questions added to inspection.`);
  if (primary && primary.uncertainty !== 'low') reasons.push(`Primary candidate uncertainty is ${primary.uncertainty}: inspection must confirm the activity.`);
  let declaredConflict = false;
  if (ctx?.sport && primary) {
    const declared = cat.sports.find((s) => s.uid === ctx.sport || s.name.toLowerCase() === ctx.sport!.toLowerCase() || s.aliases.some((a) => a.toLowerCase() === ctx.sport!.toLowerCase()));
    if (!declared || declared.uid !== primary.sport_uid) { declaredConflict = true; reasons.push(`Declared sport "${ctx.sport}" differs from the visual candidate ${primary.sport_uid}; visible evidence is inspected rather than overridden.`); }
  }
  const outOfCat = !primary;
  if (outOfCat) reasons.push('No candidate matched the catalogue; the activity is treated as unknown/out-of-catalogue.');
  return { primary, competing, conflict: competing.length > 0 || declaredConflict, declared_conflict: declaredConflict, out_of_catalogue: outOfCat, reasons };
}

export interface ValidatedInspection {
  activity_verdict: { sport_uid: string | null; state: 'established' | 'provisional' | 'unknown'; evidence_ids: string[] };
  answers: Array<{ question_id: string; answer: 'yes' | 'partly' | 'no' | null; visibility: string; state: string; observation: string; evidence_ids: string[]; uncertainty: string | null }>;
  findings: Array<{ finding_id: string; question_id: string; observation: string; interpretation: string | null; evidence_ids: string[]; state: string; measurement_kind: string; numeric_value: null; unit: null; uncertainty: string | null; approved_content_ids: string[] }>;
  limitations: string[];
  rejected: Array<{ item: string; reason: string }>;
  notes: string[];
}

export function validateInspection(raw: unknown, o: { questionIds: string[]; packets: EvidencePacket[]; candidateSports: string[]; approvedContentIds: string[]; idPrefix: string }): ValidatedInspection {
  const v = validateContract('inspection', raw);
  if (!v.ok) throw new LabError('schema_invalid', `Inspection output failed the canonical contract: ${v.errors.slice(0, 5).join('; ')}`, { details: { errors: v.errors } });
  const r = raw as any; const rejected: ValidatedInspection['rejected'] = []; const notes: string[] = [];
  const evIds = new Set(o.packets.flatMap((p) => p.frames.map((f) => f.evidence_id)));
  const qIds = new Set(o.questionIds);
  const cleanEv = (ids: string[], where: string) => { const bad = ids.filter((x) => !evIds.has(x)); if (bad.length) notes.push(`${where}: ${bad.length} unknown evidence id(s) removed`); return ids.filter((x) => evIds.has(x)); };
  let verdictSport = r.activity_verdict.sport_uid;
  if (verdictSport !== null && !o.candidateSports.includes(verdictSport)) { notes.push(`activity verdict ${String(verdictSport).slice(0, 60)} is not a candidate; treated as unknown`); verdictSport = null; }
  const verdictEv = cleanEv(r.activity_verdict.evidence_ids, 'activity verdict');
  let verdictState = r.activity_verdict.state;
  if (verdictState === 'established' && (!verdictSport || verdictEv.length === 0)) { verdictState = verdictSport ? 'provisional' : 'unknown'; notes.push('activity verdict downgraded: no valid supporting evidence ids'); }
  const answers: ValidatedInspection['answers'] = [];
  for (const a of r.answers) {
    if (!qIds.has(a.question_id)) { rejected.push({ item: `answer ${String(a.question_id).slice(0, 80)}`, reason: 'question was not asked in this request' }); continue; }
    const ev = cleanEv(a.evidence_ids, `answer ${a.question_id}`);
    let state = a.state; let answer = a.answer;
    if ((state === 'supported' || state === 'contradicted') && ev.length === 0) { state = 'uncertain'; notes.push(`answer ${a.question_id}: no valid evidence, downgraded to uncertain`); }
    if (a.visibility === 'not_visible') { state = 'not_assessable'; answer = null; }
    answers.push({ question_id: a.question_id, answer, visibility: a.visibility, state, observation: String(a.observation).slice(0, 800), evidence_ids: ev, uncertainty: a.uncertainty ?? null });
  }
  for (const q of o.questionIds) if (!answers.some((a) => a.question_id === q)) answers.push({ question_id: q, answer: null, visibility: 'uncertain', state: 'not_assessable', observation: 'No answer was returned for this question.', evidence_ids: [], uncertainty: 'missing answer' });
  const findings: ValidatedInspection['findings'] = [];
  for (const [i, f] of r.findings.entries()) {
    if (!qIds.has(f.question_id)) { rejected.push({ item: `finding ${f.finding_id}`, reason: 'refers to a question that was not asked' }); continue; }
    if (f.measurement_kind === 'measured' || (f.numeric_value !== null && f.numeric_value !== undefined)) { rejected.push({ item: `finding ${f.finding_id}`, reason: 'numeric/measured claim without an implemented measurement source' }); continue; }
    const ev = cleanEv(f.evidence_ids, `finding ${f.finding_id}`);
    if (ev.length === 0 && f.state !== 'not_assessable') { rejected.push({ item: `finding ${f.finding_id}`, reason: 'no valid evidence ids' }); continue; }
    const approved = (f.approved_content_ids ?? []).filter((x: string) => o.approvedContentIds.includes(x));
    if ((f.approved_content_ids ?? []).length > approved.length) notes.push(`finding ${f.finding_id}: unapproved content ids removed`);
    findings.push({ finding_id: `${o.idPrefix}${i + 1}`, question_id: f.question_id, observation: String(f.observation).slice(0, 800), interpretation: f.interpretation ? String(f.interpretation).slice(0, 600) : null, evidence_ids: ev, state: f.state, measurement_kind: f.measurement_kind, numeric_value: null, unit: null, uncertainty: f.uncertainty ?? null, approved_content_ids: approved });
  }
  return { activity_verdict: { sport_uid: verdictSport, state: verdictState, evidence_ids: verdictEv }, answers, findings, limitations: r.limitations.map((x: string) => String(x).slice(0, 400)), rejected, notes };
}
