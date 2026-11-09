import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Streams a file through SHA-256 so large videos are never loaded whole. */
export function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    let bytes = 0;
    createReadStream(path)
      .on('data', (chunk) => { h.update(chunk); bytes += (chunk as Buffer).length; })
      .on('error', reject)
      .on('end', () => resolve({ sha256: h.digest('hex'), bytes }));
  });
}

/** Deterministic JSON (sorted object keys) for hashing and comparison. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}

export function hashObject(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
