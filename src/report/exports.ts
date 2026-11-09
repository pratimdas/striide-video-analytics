import { toCsv } from '../util/csv.js';
import type { AthleteReport } from './build.js';

/** Athlete CSV: one row per finding / technique answer. Untrusted text cells are formula-escaped. */
export function athleteCsv(r: AthleteReport): string {
  const rows: Array<Record<string, unknown>> = [];
  for (const f of r.findings) rows.push({ report_id: r.report_id, report_version: r.report_version, kind: 'finding', id: f.finding_id, question: f.question, answer: '', state: f.state, visibility: f.visibility, observation: f.observation, interpretation: f.interpretation ?? '', evidence_seconds: f.evidence.map((e) => e.t.toFixed(3)).join(' ') });
  for (const q of r.technique) rows.push({ report_id: r.report_id, report_version: r.report_version, kind: 'protocol_question', id: '', question: q.question, answer: q.answer ?? 'not assessable', state: q.state, visibility: q.visibility, observation: q.observation, interpretation: '', evidence_seconds: q.evidence.map((e) => e.t.toFixed(3)).join(' ') });
  for (const s of r.sections) rows.push({ report_id: r.report_id, report_version: r.report_version, kind: 'section', id: s.key, question: s.title, answer: '', state: s.state, visibility: '', observation: s.reason ?? '', interpretation: '', evidence_seconds: '' });
  return toCsv(['report_id', 'report_version', 'kind', 'id', 'question', 'answer', 'state', 'visibility', 'observation', 'interpretation', 'evidence_seconds'], rows);
}

/** Internal metrics CSV (span rows with inclusive and exclusive time). */
export function metricsCsv(rows: Array<Record<string, any>>): string {
  return toCsv(['run_id', 'span_id', 'parent_span_id', 'name', 'status', 'start_offset_ms', 'end_offset_ms', 'duration_ms', 'self_ms', 'provider', 'role', 'model', 'attempt', 'request_id', 'http_status', 'finish_reason', 'input_tokens', 'output_tokens', 'error_type'],
    rows.map((r) => ({ ...r, start_offset_ms: r.start_offset_ms?.toFixed(1), end_offset_ms: r.end_offset_ms?.toFixed(1), duration_ms: r.duration_ms?.toFixed(1), self_ms: r.self_ms?.toFixed(1), provider: r.attributes?.provider ?? '', role: r.attributes?.role ?? '', model: r.attributes?.model ?? '', attempt: r.attributes?.attempt ?? '', request_id: r.attributes?.request_id ?? '', http_status: r.attributes?.http_status ?? '', finish_reason: r.attributes?.finish_reason ?? '', input_tokens: r.attributes?.usage?.input_tokens ?? '', output_tokens: r.attributes?.usage?.output_tokens ?? '', error_type: r.attributes?.error_type ?? '' })));
}
