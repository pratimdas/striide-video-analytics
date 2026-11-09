import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TraceStore } from '../telemetry/trace.js';
import { redact } from '../telemetry/trace.js';
import type { Budget } from '../telemetry/budget.js';
import type { CallRecord, PricingTable } from '../telemetry/ledger.js';
import type { LoadedConfig } from '../config/load.js';
import { scrubPaths } from '../util/paths.js';

/** Everything a job-scoped component needs. Secrets are only used for redaction. */
export interface RunContext {
  runId: string;
  runDir: string;
  lc: LoadedConfig;
  trace: TraceStore;
  budget: Budget;
  pricing: PricingTable;
  signal: AbortSignal;
  calls: CallRecord[];
  onCall?: (c: CallRecord) => void;
  /** Write a redacted internal artifact (never part of athlete exports). Returns run-relative path. */
  artifact(name: string, data: unknown): string;
}

export function makeArtifactWriter(runDir: string, secrets: string[], enabled: boolean): (name: string, data: unknown) => string {
  const dir = join(runDir, 'artifacts');
  return (name, data) => {
    const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
    const rel = `artifacts/${safe}`;
    if (!enabled) return rel + ' (not saved: save_redacted_raw_artifacts=false)';
    mkdirSync(dir, { recursive: true });
    const body = typeof data === 'string' ? redactText(data, secrets) : JSON.stringify(redactDeep(data, secrets), null, 2);
    writeFileSync(join(dir, safe), body);
    return rel;
  };
}

export function redactText(s: string, secrets: string[]): string {
  let out = s; for (const x of secrets) if (x) out = out.split(x).join('[REDACTED]');
  return out;
}

/** Deep redaction without the reference helper's 2000-character truncation (raw model output is kept whole). */
export function redactDeep(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets).replace(/(https?:\/\/[^\s"?]+)\?[^\s"]*/g, '$1?redacted');
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /api.?key|authorization|password|secret|token(?!s|_count|Count)|cookie|signed.?url/i.test(k) && typeof v === 'string' ? '[REDACTED]' : redactDeep(v, secrets)]));
  return value;
}

export { redact, scrubPaths };
