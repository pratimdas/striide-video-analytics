import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
// Reference implementation supplied with the pack (unmodified): redaction, interval union, self time, cost summary.
import { redact, summarise, unionDuration, costSummary } from '../../examples/telemetry.mjs';
import type { SpanRecord } from '../../examples/telemetry.mjs';

export { redact, summarise, unionDuration, costSummary };
export type { SpanRecord };

export interface SpanStartEvent {
  event: 'span_start'; run_id: string; trace_id: string; span_id: string; parent_span_id: string | null; name: string;
  start_utc: string; start_offset_ms: number; attributes: Record<string, unknown>;
}

export interface SpanContext {
  spanId: string;
  set(more: Record<string, unknown>): void;
  child<T>(name: string, attributes: Record<string, unknown>, fn: (ctx: SpanContext) => Promise<T> | T): Promise<T>;
}

export type SpanListener = (e: SpanStartEvent | SpanRecord) => void;

/**
 * Application trace store. Extends the reference recorder with immediate span_start events,
 * cancellation status, listeners for live progress, and crash recovery (unclosed spans -> interrupted).
 */
export class TraceStore {
  readonly runId: string;
  readonly traceId: string;
  readonly started: number;
  readonly startedUtc: string;
  readonly spans: SpanRecord[] = [];
  readonly open = new Map<string, SpanStartEvent>();
  private listeners: SpanListener[] = [];
  constructor(private opts: { runId: string; outputFile?: string | null; redactValues?: string[]; traceId?: string }) {
    this.runId = opts.runId;
    this.traceId = opts.traceId ?? randomUUID();
    this.started = performance.now();
    this.startedUtc = new Date().toISOString();
    if (opts.outputFile) mkdirSync(dirname(opts.outputFile), { recursive: true });
  }
  onEvent(l: SpanListener): () => void { this.listeners.push(l); return () => { this.listeners = this.listeners.filter((x) => x !== l); }; }
  addSecrets(values: string[]): void { this.opts.redactValues = [...(this.opts.redactValues ?? []), ...values.filter(Boolean)]; }
  now(): number { return performance.now() - this.started; }

  private write(e: SpanStartEvent | SpanRecord) {
    if (this.opts.outputFile) appendFileSync(this.opts.outputFile, JSON.stringify(e) + '\n');
    for (const l of this.listeners) { try { l(e); } catch { /* listener errors never break tracing */ } }
  }

  async span<T>(name: string, attributes: Record<string, unknown>, fn: (ctx: SpanContext) => Promise<T> | T, parentSpanId: string | null = null): Promise<T> {
    const id = randomUUID();
    const start = performance.now();
    const startUtc = new Date().toISOString();
    const attrs: Record<string, unknown> = { ...attributes };
    const startEvent: SpanStartEvent = { event: 'span_start', run_id: this.runId, trace_id: this.traceId, span_id: id, parent_span_id: parentSpanId, name, start_utc: startUtc, start_offset_ms: start - this.started, attributes: redact(attributes, this.opts.redactValues ?? []) };
    this.open.set(id, startEvent);
    this.write(startEvent);
    let status: SpanRecord['status'] = 'ok';
    const ctx: SpanContext = { spanId: id, set: (more) => { Object.assign(attrs, more); }, child: (n, a, f) => this.span(n, a, f, id) };
    try { return await fn(ctx); }
    catch (error: any) {
      status = error?.name === 'AbortError' || error?.kind === 'cancelled' ? 'cancelled' : 'error';
      attrs.error_type = error?.kind ?? error?.name ?? 'Error';
      attrs.error_message = String(error?.message ?? error);
      throw error;
    } finally {
      const end = performance.now();
      const record: SpanRecord = { event: 'span_end', run_id: this.runId, trace_id: this.traceId, span_id: id, parent_span_id: parentSpanId, name, start_utc: startUtc, end_utc: new Date().toISOString(), start_offset_ms: start - this.started, end_offset_ms: end - this.started, duration_ms: end - start, status, attributes: redact(attrs, this.opts.redactValues ?? []) };
      this.open.delete(id);
      this.spans.push(record);
      this.write(record);
    }
  }

  /** Record an already-measured interval (e.g. a provider retry backoff measured elsewhere). */
  record(name: string, parentSpanId: string | null, startOffset: number, endOffset: number, status: SpanRecord['status'], attributes: Record<string, unknown>): SpanRecord {
    const rec: SpanRecord = { event: 'span_end', run_id: this.runId, trace_id: this.traceId, span_id: randomUUID(), parent_span_id: parentSpanId, name, start_utc: new Date(Date.now() - (this.now() - startOffset)).toISOString(), end_utc: new Date(Date.now() - (this.now() - endOffset)).toISOString(), start_offset_ms: startOffset, end_offset_ms: endOffset, duration_ms: Math.max(0, endOffset - startOffset), status, attributes: redact(attributes, this.opts.redactValues ?? []) };
    this.spans.push(rec); this.write(rec); return rec;
  }

  summary() { return summarise(this.spans); }
}

/**
 * Crash recovery: any span_start without a matching span_end is closed as `interrupted`
 * at the last offset observed in the trace. Returns the recovered span_end records (also appended to the file).
 */
export function recoverInterruptedSpans(traceFile: string): SpanRecord[] {
  if (!existsSync(traceFile)) return [];
  const lines = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean);
  const starts = new Map<string, SpanStartEvent>();
  const ended = new Set<string>();
  let lastOffset = 0; let lastUtc: string | null = null;
  for (const line of lines) {
    let e: any; try { e = JSON.parse(line); } catch { continue; } // a torn final line after a crash is ignored
    if (e.event === 'span_start') { starts.set(e.span_id, e); lastOffset = Math.max(lastOffset, e.start_offset_ms); lastUtc = e.start_utc; }
    if (e.event === 'span_end') { ended.add(e.span_id); if (e.end_offset_ms >= lastOffset) { lastOffset = e.end_offset_ms; lastUtc = e.end_utc; } }
  }
  const recovered: SpanRecord[] = [];
  for (const [id, s] of starts) {
    if (ended.has(id)) continue;
    const rec: SpanRecord = { event: 'span_end', run_id: s.run_id, trace_id: s.trace_id, span_id: id, parent_span_id: s.parent_span_id, name: s.name, start_utc: s.start_utc, end_utc: lastUtc ?? s.start_utc, start_offset_ms: s.start_offset_ms, end_offset_ms: Math.max(lastOffset, s.start_offset_ms), duration_ms: Math.max(0, lastOffset - s.start_offset_ms), status: 'interrupted', attributes: { ...s.attributes, recovered_after_crash: true, end_is_lower_bound: true } };
    recovered.push(rec);
    appendFileSync(traceFile, JSON.stringify(rec) + '\n');
  }
  return recovered;
}

export function readSpans(traceFile: string): SpanRecord[] {
  if (!existsSync(traceFile)) return [];
  const out: SpanRecord[] = [];
  for (const line of readFileSync(traceFile, 'utf8').split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e.event === 'span_end') out.push(e); } catch { /* torn line */ }
  }
  return out;
}

/** Per-stage aggregation: union duration of spans with the same name (parallel work is not double-counted). */
export function stageUnion(spans: SpanRecord[]): Record<string, { count: number; union_ms: number; sum_inclusive_ms: number; errors: number }> {
  const groups: Record<string, SpanRecord[]> = {};
  for (const s of spans) (groups[s.name] ??= []).push(s);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { count: v.length, union_ms: unionDuration(v.map((s) => [s.start_offset_ms, s.end_offset_ms] as [number, number])), sum_inclusive_ms: v.reduce((n, s) => n + s.duration_ms, 0), errors: v.filter((s) => s.status === 'error').length }]));
}
