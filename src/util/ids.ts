import { randomBytes } from 'node:crypto';

/** Sortable unique run identifier: run_YYYYMMDDTHHMMSSZ_<random>. */
export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `run_${stamp}_${randomBytes(4).toString('hex')}`;
}

export function newId(prefix: string, bytes = 6): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

export const SAFE_ID = /^[A-Za-z0-9_.:@\/-]{1,200}$/;
export const RUN_ID = /^run_\d{8}T\d{6}Z_[0-9a-f]{8}$/;
export const MEDIA_ID = /^med_[0-9a-f]{12}$/;
