import { readFileSync, existsSync } from 'node:fs';
import { costSummary } from './trace.js';
import { LabError } from '../util/errors.js';

/** One provider attempt (every planner, inspection, repair and retry request is logged). */
export interface CallRecord {
  call_id: string;
  span_id: string | null;
  provider: 'twelvelabs' | 'gemini';
  role: 'upload' | 'readiness_poll' | 'discovery' | 'planner' | 'inspector' | 'followup' | 'file_upload' | 'file_poll' | 'delete' | 'smoke';
  model: string | null;
  attempt: number;
  is_retry: boolean;
  outcome: 'ok' | 'error' | 'cancelled';
  error_kind: string | null;
  http_status: number | null;
  request_id: string | null;
  finish_reason: string | null;
  usage: { input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null; thinking_tokens: number | null; total_tokens: number | null; video_seconds: number | null } | null;
  usage_source: 'provider_reported' | 'not_reported' | 'not_applicable';
  cost_usd: number | null;
  cost_status: 'estimated' | 'unknown' | 'not_applicable';
  cost_note: string | null;
  duration_ms: number;
  generation: boolean;
  cache_hit: boolean;
  reused_from_run: string | null;
}

export interface PricingTable {
  version: string; currency: string; effective_date: string | null; source: string | null;
  rates: Record<string, Record<string, number | null>>;
}

export function loadPricing(path: string): PricingTable {
  if (!existsSync(path)) return { version: 'missing', currency: 'USD', effective_date: null, source: null, rates: {} };
  const p = JSON.parse(readFileSync(path, 'utf8'));
  if (p.currency !== 'USD') throw new LabError('config', 'Pricing table currency must be USD for this lab.');
  return p;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);

/**
 * Estimate cost from provider-reported usage and the account pricing table.
 * Any missing rate or usage figure yields null (unknown), never zero.
 */
export function estimateCost(pricing: PricingTable, rec: Pick<CallRecord, 'provider' | 'role' | 'usage' | 'generation'>): { cost_usd: number | null; cost_status: CallRecord['cost_status']; note: string | null } {
  if (!rec.generation) return { cost_usd: null, cost_status: 'not_applicable', note: 'non-generation request; storage/upload charges unknown unless priced' };
  const u = rec.usage;
  if (!u) return { cost_usd: null, cost_status: 'unknown', note: 'provider did not report usage' };
  if (rec.provider === 'twelvelabs') {
    const r = pricing.rates['pegasus1.6'] ?? {};
    const tokenRates = num(r.input_per_million_tokens) !== null || num(r.output_per_million_tokens) !== null;
    const minuteRate = num(r.per_video_minute);
    if (tokenRates && minuteRate !== null) return { cost_usd: null, cost_status: 'unknown', note: 'token and video-minute rates both configured; refusing to combine incompatible rates' };
    if (minuteRate !== null) {
      if (u.video_seconds === null) return { cost_usd: null, cost_status: 'unknown', note: 'video duration unknown for per-minute rate' };
      return { cost_usd: (u.video_seconds / 60) * minuteRate, cost_status: 'estimated', note: 'per_video_minute; minimum increments not modelled' };
    }
    const ri = num(r.input_per_million_tokens), ro = num(r.output_per_million_tokens);
    if (ri === null || ro === null || u.input_tokens === null || u.output_tokens === null) return { cost_usd: null, cost_status: 'unknown', note: 'missing Pegasus rate or token usage' };
    return { cost_usd: (u.input_tokens * ri + u.output_tokens * ro) / 1e6, cost_status: 'estimated', note: null };
  }
  const key = rec.role === 'planner' ? 'gemini_planner' : 'gemini_inspector';
  const r = pricing.rates[key] ?? {};
  const ri = num(r.input_per_million_tokens), ro = num(r.output_per_million_tokens), rc = num(r.cached_input_per_million_tokens), rt = num(r.thinking_per_million_tokens);
  if (ri === null || ro === null || u.input_tokens === null || u.output_tokens === null) return { cost_usd: null, cost_status: 'unknown', note: `missing ${key} rate or token usage` };
  const cached = u.cached_input_tokens ?? 0;
  if (cached > 0 && rc === null) return { cost_usd: null, cost_status: 'unknown', note: 'cached-input rate unknown' };
  const thinking = u.thinking_tokens ?? 0;
  if (thinking > 0 && rt === null) return { cost_usd: null, cost_status: 'unknown', note: 'thinking-token rate unknown' };
  // Gemini reports cached tokens as a subset of prompt tokens; thinking tokens are separate from candidates.
  const cost = ((u.input_tokens - cached) * ri + cached * (rc ?? 0) + u.output_tokens * ro + thinking * (rt ?? 0)) / 1e6;
  return { cost_usd: cost, cost_status: 'estimated', note: null };
}

export function runCost(calls: CallRecord[]) {
  const parts = calls.filter((c) => c.generation && !c.cache_hit).map((c) => ({ name: `${c.provider}.${c.role}#${c.attempt}:${c.call_id}`, cost_usd: c.cost_usd }));
  const base = costSummary(parts);
  return {
    ...base,
    status: parts.length === 0 ? ('unknown' as const) : base.status,
    // Upload/storage costs are never known from the API responses.
    non_generation_components_unpriced: calls.filter((c) => !c.generation && !c.cache_hit && (c.role === 'upload' || c.role === 'file_upload')).length,
    note: 'Known subtotal is not a complete run cost while any component is unknown.',
  };
}
