import { LabError, errorSummary } from '../util/errors.js';

export interface ParsedArgs { flags: Record<string, string | boolean>; positional: string[] }

export function parseArgs(argv: string[], allowed: string[], booleans: string[] = []): ParsedArgs {
  const flags: Record<string, string | boolean> = {}; const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s) as [string, string | undefined];
    if (![...allowed, ...booleans, 'help'].includes(k)) throw new LabError('config', `Unknown option --${k}. Allowed: ${[...allowed, ...booleans].map((x) => '--' + x).join(' ')}`);
    if (booleans.includes(k) || k === 'help') { flags[k] = true; continue; }
    const v = inline ?? argv[++i];
    if (v === undefined || v.startsWith('--')) throw new LabError('config', `Option --${k} needs a value`);
    flags[k] = v;
  }
  return { flags, positional };
}

export function str(flags: ParsedArgs['flags'], k: string, def?: string): string {
  const v = flags[k];
  if (typeof v === 'string') return v;
  if (def !== undefined) return def;
  throw new LabError('config', `Missing required option --${k}`);
}

/** Uniform CLI wrapper: typed errors become clear messages and a non-zero exit code. */
export async function main(fn: () => Promise<number | void>): Promise<void> {
  try { const code = await fn(); process.exitCode = typeof code === 'number' ? code : 0; }
  catch (e) {
    const s = errorSummary(e);
    console.error(`[${s.kind}] ${s.message}`);
    process.exitCode = s.kind === 'config' ? 2 : 1;
  }
}
