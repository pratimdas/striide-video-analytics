// Type declarations for the supplied (unmodified) telemetry reference module.
export interface SpanRecord {
  event: 'span_end'; run_id: string; trace_id: string; span_id: string; parent_span_id: string | null; name: string;
  start_utc: string; end_utc: string; start_offset_ms: number; end_offset_ms: number; duration_ms: number;
  status: 'ok' | 'error' | 'cancelled' | 'interrupted'; attributes: Record<string, unknown>;
}
export function redact<T>(value: T, secrets?: string[]): T;
export function unionDuration(intervals: Array<[number, number]>): number;
export function summarise(spans: ReadonlyArray<{ span_id: string; parent_span_id: string | null; start_offset_ms: number; end_offset_ms: number; duration_ms: number }>): {
  wall_time_ms: number; span_count: number; failed_spans: number; rows: Array<Record<string, any> & { self_ms: number }>;
};
export function costSummary(parts: Array<{ name: string; cost_usd: number | null }>): {
  currency: 'USD'; status: 'estimated' | 'partial' | 'unknown'; known_subtotal_usd: number | null; unknown_components: string[];
};
export class TraceRecorder { constructor(o: { runId: string; outputFile?: string | null; redactValues?: string[] }); spans: SpanRecord[]; }
