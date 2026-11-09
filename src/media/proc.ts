import { spawn } from 'node:child_process';
import { LabError } from '../util/errors.js';

export interface ProcResult { code: number | null; stdout: Buffer; stderrTail: string; durationMs: number; killed: boolean }

/**
 * Run an executable with an argument array (never a shell string). Output is bounded,
 * the environment is minimal and the process is killed on abort or timeout.
 */
export function runProcess(bin: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal; maxStdoutBytes?: number; input?: Buffer | string; env?: NodeJS.ProcessEnv; cwd?: string } ): Promise<ProcResult> {
  const started = Date.now();
  const maxOut = opts.maxStdoutBytes ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? minimalEnv(), cwd: opts.cwd });
    } catch (e) { reject(new LabError('media', `Could not start ${bin}: ${(e as Error).message}`)); return; }
    const out: Buffer[] = []; let outLen = 0; let errTail = ''; let killed = false; let overflow = false;
    const kill = () => { if (!killed) { killed = true; try { child.kill('SIGKILL'); } catch { /* already gone */ } } };
    const timer = setTimeout(kill, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => { outLen += d.length; if (outLen > maxOut) { overflow = true; kill(); } else out.push(d); });
    child.stderr.on('data', (d: Buffer) => { errTail = (errTail + d.toString('utf8')).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); reject(new LabError('media', `Could not run ${bin}: ${e.message}. Check it is installed and on PATH (or set the *_BIN variable).`)); });
    child.on('close', (code) => {
      clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) { const err = new LabError('cancelled', 'Cancelled'); err.name = 'AbortError'; reject(err); return; }
      resolve({ code, stdout: Buffer.concat(out), stderrTail: overflow ? errTail + '\n[stdout limit exceeded]' : errTail, durationMs: Date.now() - started, killed });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input); else child.stdin.end();
  });
}

/** Environment for media subprocesses: PATH and OS essentials only, never provider keys. */
export function minimalEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export async function toolVersion(bin: string, args = ['-version']): Promise<string | null> {
  try {
    const r = await runProcess(bin, args, { timeoutMs: 15000, maxStdoutBytes: 1024 * 1024 });
    if (r.code !== 0) return null;
    return r.stdout.toString('utf8').split(/\r?\n/)[0]!.trim();
  } catch { return null; }
}
