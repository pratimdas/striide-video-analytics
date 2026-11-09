import { randomUUID } from 'node:crypto';
import { LabError, type ErrorKind } from '../util/errors.js';
import { sleep } from '../util/time.js';
import type { RunContext } from '../jobs/context.js';
import type { SpanContext } from '../telemetry/trace.js';
import { estimateCost, type CallRecord } from '../telemetry/ledger.js';

export interface AttemptMeta {
  request_id?: string | null; http_status?: number | null; finish_reason?: string | null;
  usage?: CallRecord['usage']; usage_source?: CallRecord['usage_source'];
}

/** Map SDK/transport errors to the lab taxonomy. 429, 5xx, timeouts, transport and content failures stay distinct. */
export function classifyError(e: any, timedOut: boolean, cancelled: boolean): LabError {
  if (e instanceof LabError) return e;
  if (cancelled) { const c = new LabError('cancelled', 'Cancelled'); c.name = 'AbortError'; return c; }
  const status: number | undefined = e?.statusCode ?? e?.status ?? e?.response?.status;
  const msg = String(e?.message ?? e).slice(0, 400);
  if (timedOut || e?.name === 'TwelvelabsApiTimeoutError' || /timed? ?out|timeout/i.test(e?.name ?? '')) return new LabError('provider_timeout', `Request timed out (outcome unknown; the provider may still have processed and charged it): ${msg}`, { retryable: true, details: { unknown_outcome: true } });
  if (status === 429) return new LabError('provider_rate_limited', `Rate limited (429): ${msg}`, { retryable: true, details: { http_status: 429, retry_after: retryAfter(e) } });
  if (status === 401 || status === 403) return new LabError('provider_auth', `Authentication or permission failure (${status}). Check the API key and model access.`, { details: { http_status: status } });
  if (typeof status === 'number' && status >= 500) return new LabError('provider_server', `Provider server error (${status}): ${msg}`, { retryable: true, details: { http_status: status } });
  if (typeof status === 'number' && status >= 400) return new LabError('provider_client', `Provider rejected the request (${status}): ${msg}`, { details: { http_status: status, body: safeBody(e?.body) } });
  if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket|network/i.test(msg + ' ' + String(e?.cause?.code ?? ''))) return new LabError('provider_transport', `Network/transport failure: ${msg}`, { retryable: true });
  return new LabError('provider_transport', `Unexpected provider failure: ${msg}`, { retryable: false });
}

function retryAfter(e: any): number | null {
  const h = e?.rawResponse?.headers?.get?.('retry-after') ?? e?.headers?.['retry-after'];
  const n = Number(h); return Number.isFinite(n) && n >= 0 ? Math.min(n, 60) : null;
}
function safeBody(b: unknown): unknown { try { return JSON.parse(JSON.stringify(b ?? null)); } catch { return null; } }

/**
 * Execute one logical provider request with bounded retries. Every attempt is a child span and a ledger
 * record; backoff waits are separate spans. Retries never exceed the per-request and run-wide budgets.
 */
export async function providerCall<T>(ctx: RunContext, parent: SpanContext, o: {
  provider: CallRecord['provider']; role: CallRecord['role']; model: string | null; spanName: string; generation: boolean; timeoutMs: number;
  attributes?: Record<string, unknown>; maxRetries?: number; retryOn?: ErrorKind[];
  fn: (signal: AbortSignal, attempt: number) => Promise<{ value: T; meta: AttemptMeta }>;
}): Promise<{ value: T; calls: CallRecord[] }> {
  const maxRetries = o.maxRetries ?? ctx.lc.config.budgets.max_retries_per_request;
  const retryOn = o.retryOn ?? ['provider_rate_limited', 'provider_server', 'provider_transport', 'provider_timeout'];
  const made: CallRecord[] = [];
  for (let attempt = 1; ; attempt++) {
    ctx.budget.reserveHttpAttempt();
    if (o.generation) ctx.budget.reserveGenerationAttempt();
    const callId = randomUUID();
    const started = performance.now();
    let timedOut = false;
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => { timedOut = true; timeoutCtl.abort(new Error('timeout')); }, Math.min(o.timeoutMs, Math.max(1000, ctx.budget.remainingWallMs())));
    const signal = AbortSignal.any([ctx.signal, timeoutCtl.signal]);
    let rec: CallRecord | null = null;
    try {
      const { value, meta } = await parent.child(o.spanName, { ...o.attributes, provider: o.provider, role: o.role, model: o.model, attempt, call_id: callId }, async (span) => {
        try {
          const r = await o.fn(signal, attempt);
          span.set({ request_id: r.meta.request_id ?? null, http_status: r.meta.http_status ?? null, finish_reason: r.meta.finish_reason ?? null, usage: r.meta.usage ?? null });
          return r;
        } catch (e) { throw classifyError(e, timedOut, ctx.signal.aborted); }
      });
      rec = record(ctx, o, callId, attempt, 'ok', null, meta, performance.now() - started);
      made.push(rec);
      return { value, calls: made };
    } catch (e) {
      const err = e instanceof LabError ? e : classifyError(e, timedOut, ctx.signal.aborted);
      rec = record(ctx, o, callId, attempt, err.kind === 'cancelled' ? 'cancelled' : 'error', err, { http_status: (err.details.http_status as number) ?? null, usage: null, usage_source: 'not_reported' }, performance.now() - started);
      made.push(rec);
      const canRetry = err.retryable && retryOn.includes(err.kind) && attempt <= maxRetries && !ctx.signal.aborted;
      if (!canRetry) { (err.details as any).attempts = attempt; throw err; }
      const wait = Math.min(30000, ((err.details.retry_after as number) ?? 0) * 1000 || 1000 * 2 ** (attempt - 1));
      if (wait >= ctx.budget.remainingWallMs()) throw new LabError('budget_exceeded', 'No wall-time budget left for a retry', { cause: err });
      await parent.child('retry_backoff', { provider: o.provider, role: o.role, attempt, wait_ms: wait, reason: err.kind }, () => sleep(wait, ctx.signal));
    } finally { clearTimeout(timer); }
  }
}

function record(ctx: RunContext, o: { provider: CallRecord['provider']; role: CallRecord['role']; model: string | null; generation: boolean }, callId: string, attempt: number, outcome: CallRecord['outcome'], err: LabError | null, meta: AttemptMeta, ms: number): CallRecord {
  const usage = meta.usage ?? null;
  const cost = estimateCost(ctx.pricing, { provider: o.provider, role: o.role, usage, generation: o.generation });
  const rec: CallRecord = {
    call_id: callId, span_id: null, provider: o.provider, role: o.role, model: o.model, attempt, is_retry: attempt > 1, outcome, error_kind: err?.kind ?? null,
    http_status: meta.http_status ?? null, request_id: meta.request_id ?? null, finish_reason: meta.finish_reason ?? null, usage,
    usage_source: meta.usage_source ?? (usage ? 'provider_reported' : o.generation ? 'not_reported' : 'not_applicable'),
    // A failed generation attempt may still be charged; its cost is unknown, never zero.
    cost_usd: outcome === 'ok' ? cost.cost_usd : null, cost_status: !o.generation ? 'not_applicable' : outcome === 'ok' ? cost.cost_status : 'unknown',
    cost_note: outcome === 'ok' ? cost.note : o.generation ? 'failed or timed-out attempt: charge unknown' : null,
    duration_ms: ms, generation: o.generation, cache_hit: false, reused_from_run: null,
  };
  ctx.calls.push(rec); ctx.onCall?.(rec);
  return rec;
}

export function requestIdFrom(headers: any): string | null {
  if (!headers) return null;
  const get = (k: string) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]);
  for (const k of ['x-request-id', 'request-id', 'x-goog-request-id', 'x-amzn-requestid', 'x-cloud-trace-context']) { const v = get(k); if (v) return String(v).slice(0, 120); }
  return null;
}
