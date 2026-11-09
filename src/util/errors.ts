/** Typed failure taxonomy. Different provider outcomes must stay distinguishable. */
export type ErrorKind =
  | 'config'
  | 'input_rejected'
  | 'media'
  | 'ontology_unavailable'
  | 'ontology_invalid'
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_server'
  | 'provider_client'
  | 'provider_auth'
  | 'provider_transport'
  | 'provider_asset_failed'
  | 'provider_readiness_timeout'
  | 'model_content'
  | 'model_truncated'
  | 'schema_invalid'
  | 'budget_exceeded'
  | 'cancelled'
  | 'sandbox_unavailable'
  | 'sandbox_violation'
  | 'internal';

export class LabError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  constructor(kind: ErrorKind, message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'LabError';
    this.kind = kind;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details ?? {};
  }
}

export class CancelledError extends LabError {
  constructor(message = 'Run cancelled') { super('cancelled', message); this.name = 'AbortError'; }
}

export function isLabError(e: unknown): e is LabError { return e instanceof LabError; }

export function errorSummary(e: unknown): { kind: ErrorKind; message: string } {
  if (e instanceof LabError) return { kind: e.kind, message: e.message };
  if (e && typeof e === 'object' && (e as any).name === 'AbortError') return { kind: 'cancelled', message: String((e as any).message ?? 'aborted') };
  return { kind: 'internal', message: String((e as any)?.message ?? e) };
}
