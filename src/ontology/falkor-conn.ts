import { FalkorDB } from 'falkordb';
import { spawnSync } from 'node:child_process';
import { LabError } from '../util/errors.js';
import type { ResolvedEnv } from '../config/load.js';
import { PROJECT_ROOT } from '../util/paths.js';
import { resolve } from 'node:path';

export async function connectFalkor(env: ResolvedEnv['falkor'], timeoutMs = 5000): Promise<FalkorDB> {
  if (!env.host || !env.port || !env.password) throw new LabError('ontology_unavailable', 'FalkorDB connection settings are incomplete (host, port and password are required).');
  const opts: any = { socket: { host: env.host, port: env.port, connectTimeout: timeoutMs, tls: env.tls || undefined, reconnectStrategy: false }, password: env.password };
  if (env.username) opts.username = env.username;
  try {
    const db = await Promise.race([
      FalkorDB.connect(opts),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('connection timed out')), timeoutMs + 500)),
    ]);
    (db as any).on?.('error', () => { /* surfaced through failed queries */ });
    return db;
  } catch (e) {
    const msg = String((e as Error).message ?? e).replace(env.password, '[REDACTED]');
    throw new LabError('ontology_unavailable', `Cannot connect to FalkorDB at ${env.host}:${env.port} (${msg}). Start it with: node bootstrap/falkordb.mjs up`);
  }
}

/**
 * Image ID/digest of the running Compose service, if Docker is reachable. Returns null with a reason
 * otherwise; callers must report a null digest explicitly.
 */
export function composeImageDigest(): { digest: string | null; image_id: string | null; reason: string | null } {
  try {
    const base = ['compose', '--env-file', resolve(PROJECT_ROOT, '.env'), '-f', resolve(PROJECT_ROOT, 'compose.falkordb.yaml')];
    const ps = spawnSync('docker', [...base, 'ps', '-q', 'falkordb'], { cwd: PROJECT_ROOT, shell: false, encoding: 'utf8', timeout: 20000 });
    const id = ps.stdout?.trim().split(/\s+/)[0];
    if (ps.status !== 0 || !id) return { digest: null, image_id: null, reason: 'docker compose did not report a running falkordb container' };
    const img = spawnSync('docker', ['inspect', '--format', '{{.Image}}', id], { shell: false, encoding: 'utf8', timeout: 20000 });
    const imageId = img.stdout?.trim() || null;
    if (!imageId) return { digest: null, image_id: null, reason: 'docker inspect returned no image id' };
    const dig = spawnSync('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', imageId], { shell: false, encoding: 'utf8', timeout: 20000 });
    let digests: string[] = []; try { digests = JSON.parse(dig.stdout || '[]'); } catch { /* ignore */ }
    return { digest: digests[0] ?? null, image_id: imageId, reason: digests[0] ? null : 'image has no repository digest (locally built?)' };
  } catch (e) {
    return { digest: null, image_id: null, reason: `docker unavailable: ${(e as Error).message}` };
  }
}
