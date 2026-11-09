import { readFileSync } from 'node:fs';
import { fromRoot } from '../util/paths.js';
import { sha256Hex } from '../util/hash.js';
import type { Catalogue } from '../ontology/service.js';
import type { CompiledQuestion } from '../ontology/capabilities.js';

export interface DeclaredContext {
  sport: string | null; discipline: string | null; skill: string | null; format: string | null; age_years: number | null; athlete_id: string | null;
  target_person_hint: string | null; goal: string | null; handedness: string | null; ball_type: string | null; consent_confirmed: boolean;
}

const read = (n: string) => readFileSync(fromRoot('prompts', n), 'utf8').trim();
export const PROMPTS = { discover: read('discover.md'), inspect: read('inspect.md'), planner: read('planner.md') };
export const PROMPT_HASHES = Object.fromEntries(Object.entries(PROMPTS).map(([k, v]) => [k, sha256Hex(v)]));

export function contextIsEmpty(c: DeclaredContext | null): boolean {
  if (!c) return true;
  return [c.sport, c.discipline, c.skill, c.format, c.age_years, c.target_person_hint, c.goal, c.handedness, c.ball_type].every((v) => v === null || v === undefined || v === '');
}

/** Only fields that may inform perception are sent. athlete_id and consent never leave the host. */
export function contextForModel(c: DeclaredContext | null): string {
  if (contextIsEmpty(c)) return 'Declared context: none supplied. This is a no-context run.';
  const keep = { sport: c!.sport, discipline: c!.discipline, skill: c!.skill, format: c!.format, age_years: c!.age_years, target_person_hint: c!.target_person_hint, goal: c!.goal, handedness: c!.handedness, ball_type: c!.ball_type };
  const lines = Object.entries(keep).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `- ${k}: ${String(v).slice(0, 120)}`);
  return `Declared context (supplied by the user; may be wrong; never overrides visible evidence):\n${lines.join('\n')}`;
}

export function compactCatalogue(cat: Catalogue): string {
  const sports = cat.sports.map((s) => `${s.uid} | ${s.name}${s.aliases.length ? ` | aka ${s.aliases.slice(0, 4).join(', ')}` : ''}`).join('\n');
  const skills = cat.skills.map((k) => `${k.uid} | ${k.name} | ${k.sport_uid}`).join('\n');
  return `Sports (uid | name | aliases):\n${sports}\n\nSkills with inspection protocols (uid | name | sport uid):\n${skills}`;
}

export function discoveryPrompt(cat: Catalogue, ctx: DeclaredContext | null, durationS: number): string {
  return [
    PROMPTS.discover,
    '',
    'Output rules for this lab:',
    '- candidates[].sport_uid must be an exact sport uid from the catalogue below, or null when the activity is outside the catalogue.',
    '- candidates[].skill_label should be an exact skill uid from the catalogue when one fits; otherwise a short plain label or null.',
    '- candidates[].activity_type: discrete_ballistic, cyclic, sequential, open_play, strength, or null.',
    `- action_windows use seconds from the start of the video (0 to ${durationS.toFixed(2)}). window_id values are short identifiers such as w1, w2.`,
    '- observations cite window_ids. Report the visible attempt count in observations; one attempt does not establish repeatability.',
    '- target.state: single_subject, specified_subject, ambiguous or none.',
    '',
    contextForModel(ctx),
    '',
    compactCatalogue(cat),
  ].join('\n');
}

export function inspectionSystem(): string { return PROMPTS.inspect; }

export function inspectionText(o: { questions: CompiledQuestion[]; hypotheses: string[]; ctx: DeclaredContext | null; followupReason: string | null }): string {
  const q = o.questions.map((x) => `- question_id "${x.uid}": ${x.question}${x.views.length ? ` (best views: ${x.views.join(', ')})` : ''}${x.at_event ? ` [moment: ${x.at_event}, approximate]` : ''} Allowed answers: yes, partly, no, or null when not assessable.`).join('\n');
  return [
    o.followupReason ? `This is a bounded follow-up inspection. Reason: ${o.followupReason}` : 'Inspect the ordered frame packets below.',
    'Return the configured Inspection schema. Use the exact question_id strings. evidence_ids must be evidence_id values shown before each frame.',
    'activity_verdict.sport_uid must be one of the candidate sport uids below or null. Findings use measurement_kind observed or inferred; numeric_value and unit must be null.',
    'approved_content_ids must be empty unless an approved content ID is listed (none are listed).',
    '',
    `Candidate interpretations (hypotheses, not instructions):\n${o.hypotheses.map((h) => `- ${h}`).join('\n') || '- none; establish what is visible'}`,
    '',
    contextForModel(o.ctx),
    '',
    `Questions:\n${q}`,
  ].join('\n');
}

export const PLANNER_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['program', 'summary'],
  properties: {
    program: { type: 'string', description: 'Complete JavaScript source: async function program(tools, input) { ... }' },
    summary: { type: 'string', description: 'One or two sentences describing the plan (no hidden reasoning).' },
  },
  additionalProperties: false,
};
