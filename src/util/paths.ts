import { realpathSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LabError } from './errors.js';

/** Project root (directory containing package.json). */
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'BUILD_TASK.md'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
export const PROJECT_ROOT = findRoot();

export function fromRoot(...p: string[]): string { return resolve(PROJECT_ROOT, ...p); }

/** Canonicalise and assert the path is inside root (symlinks resolved). */
export function assertInside(root: string, candidate: string): string {
  const realRoot = realpathSync(root);
  const abs = isAbsolute(candidate) ? candidate : resolve(realRoot, candidate);
  if (!existsSync(abs)) throw new LabError('input_rejected', 'File does not exist inside the approved input root.');
  const real = realpathSync(abs);
  const rel = relative(realRoot, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new LabError('input_rejected', 'Path is outside the approved input root.');
  }
  return real;
}

export function isFile(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }

/** Remove absolute paths / user directories from text destined for exports. */
export function scrubPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/][^\s"'<>]*/g, '[path]')
    .replace(/(?<![A-Za-z0-9])\/(?:home|Users|root|tmp|var|mnt|opt|private)\/[^\s"'<>]*/g, '[path]');
}
