import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LabError } from '../../util/errors.js';
import { PROJECT_ROOT } from '../../util/paths.js';
import { hashObject } from '../../util/hash.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BOOTSTRAP_TEMPLATE = readFileSync(join(HERE, 'bootstrap.template.js'), 'utf8');
export const DENO_FLAGS_VERSION = 'deno-restricted/1';

/** Resolve the pinned native Deno binary (npm "deno" package) or an explicit DENO_BIN. */
export function resolveDeno(configured: string): string {
  if (configured && configured !== 'deno' && !configured.includes('node_modules')) return configured;
  const plat = process.platform === 'win32' ? `win32-${process.arch}` : process.platform === 'darwin' ? `darwin-${process.arch}` : `linux-${process.arch}-glibc`;
  const exe = process.platform === 'win32' ? 'deno.exe' : 'deno';
  for (const p of [resolve(PROJECT_ROOT, 'node_modules', '@deno', plat, exe), resolve(PROJECT_ROOT, 'node_modules', 'deno', exe)]) if (existsSync(p)) return p;
  return configured || 'deno';
}

/** Minimal environment: no provider keys, NODE_OPTIONS, DENO_PERMISSION_BROKER_PATH or Deno config inheritance. */
export function sandboxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { DENO_DIR: resolve(PROJECT_ROOT, '.cache', 'deno'), NO_COLOR: '1', DENO_NO_UPDATE_CHECK: '1', DENO_NO_PROMPT: '1' };
  if (process.platform === 'win32') for (const k of ['SYSTEMROOT', 'SystemRoot', 'WINDIR']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

export function denoArgs(port: number, file: string): string[] {
  return ['run', '--no-prompt', '--no-config', '--no-lock', '--no-npm', '--no-remote', '--deny-read', '--deny-write', '--deny-env', '--deny-run', '--deny-ffi', '--deny-sys',
    `--allow-net=127.0.0.1:${port}`, '--v8-flags=--disallow-code-generation-from-strings,--max-old-space-size=128', file];
}

export interface SegmentOutcome {
  status: 'done' | 'suspended' | 'error' | 'killed_timeout' | 'killed_output' | 'crashed';
  result: unknown; error: string | null; error_name: string | null; logs: string[]; stdout_bytes: number; duration_ms: number; exit_code: number | null; stderr_tail: string;
}

/** Run one module in the restricted Deno process. The watchdog terminates runaway code and caps output. */
export function runDenoModule(o: { deno: string; moduleSource: string; file: string; stdin: object; nonce: string; port: number; timeoutMs: number; maxStdoutBytes: number; signal?: AbortSignal }): Promise<SegmentOutcome> {
  mkdirSync(dirname(o.file), { recursive: true });
  writeFileSync(o.file, o.moduleSource);
  const t0 = performance.now();
  return new Promise((resolveP) => {
    let child;
    try { child = spawn(o.deno, denoArgs(o.port, o.file), { shell: false, windowsHide: true, env: sandboxEnv(), stdio: ['pipe', 'pipe', 'pipe'], cwd: dirname(o.file) }); }
    catch (e) { resolveP({ status: 'crashed', result: null, error: `could not start Deno: ${(e as Error).message}`, error_name: 'SpawnError', logs: [], stdout_bytes: 0, duration_ms: 0, exit_code: null, stderr_tail: '' }); return; }
    let out = ''; let bytes = 0; let err = ''; let killedFor: 'timeout' | 'output' | null = null;
    const kill = (why: 'timeout' | 'output') => { if (!killedFor) { killedFor = why; try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const timer = setTimeout(() => kill('timeout'), o.timeoutMs);
    const onAbort = () => kill('timeout');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => { bytes += d.length; if (bytes > o.maxStdoutBytes) kill('output'); else out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-3000); });
    child.on('error', (e) => { clearTimeout(timer); resolveP({ status: 'crashed', result: null, error: `Deno failed to run: ${e.message}`, error_name: 'SpawnError', logs: [], stdout_bytes: bytes, duration_ms: performance.now() - t0, exit_code: null, stderr_tail: err }); });
    child.on('close', (code) => {
      clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort);
      const base = { stdout_bytes: bytes, duration_ms: performance.now() - t0, exit_code: code, stderr_tail: err.slice(-1500) };
      if (killedFor === 'timeout') return resolveP({ status: 'killed_timeout', result: null, error: `execution segment exceeded ${o.timeoutMs} ms and was terminated`, error_name: 'Watchdog', logs: [], ...base });
      if (killedFor === 'output') return resolveP({ status: 'killed_output', result: null, error: `program output exceeded ${o.maxStdoutBytes} bytes and was terminated`, error_name: 'Watchdog', logs: [], ...base });
      const idx = out.lastIndexOf(o.nonce);
      if (idx < 0) return resolveP({ status: 'crashed', result: null, error: `program ended without a result${/SyntaxError/.test(err) ? ' (syntax error)' : ''}: ${err.split('\n').find((l) => /error/i.test(l))?.slice(0, 300) ?? 'no output'}`, error_name: /SyntaxError/.test(err) ? 'SyntaxError' : 'Crash', logs: [], ...base });
      try {
        const msg = JSON.parse(out.slice(idx + o.nonce.length).split('\n')[0]!);
        resolveP({ status: msg.status, result: msg.result ?? null, error: msg.error ?? null, error_name: msg.error_name ?? null, logs: msg.logs ?? [], ...base });
      } catch { resolveP({ status: 'crashed', result: null, error: 'unreadable result line', error_name: 'Crash', logs: [], ...base }); }
    });
    child.stdin.end(JSON.stringify(o.stdin));
  });
}

export interface JournalEntry { seq: number; tool: string; args_hash: string; ok: boolean; result?: unknown; error?: string; denied?: boolean }
type Handler = (tool: string, args: unknown, seq: number) => Promise<unknown>;

/**
 * Job-scoped loopback broker: per-run capability token, deterministic replay journal and host tasks for
 * long operations. Validation of tools/arguments/budgets happens in the ToolHost on every request.
 */
export class Broker {
  private server: Server | null = null;
  port = 0;
  readonly token = randomBytes(24).toString('hex');
  journal: JournalEntry[] = [];
  pending: { seq: number; promise: Promise<void> } | null = null;
  inflight = new Set<Promise<void>>();
  segment = 0;
  segmentDeadline = 0;
  suspendedThisSegment = false;
  replayed = 0;
  violations: string[] = [];
  constructor(private handler: Handler, private isLong: (tool: string) => boolean, private onDenied: (tool: string, reason: string) => void) {}

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      const reply = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method !== 'POST' || req.url !== '/call' || req.headers.authorization !== `Bearer ${this.token}`) { this.onDenied('(unauthenticated)', 'request without the run capability'); return reply(403, { ok: false, denied: true, error: 'forbidden' }); }
      let body = ''; let size = 0;
      req.on('data', (d) => { size += d.length; if (size > 256 * 1024) { req.destroy(); } else body += d; });
      req.on('end', () => { this.handle(body).then((r) => reply(200, r), (e) => reply(200, { ok: false, error: String((e as Error).message ?? e) })); });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server!.address() as any).port;
    return this.port;
  }
  async stop(): Promise<void> { await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r())); }

  beginSegment(n: number, deadline: number) { this.segment = n; this.segmentDeadline = deadline; this.suspendedThisSegment = false; }

  private async handle(raw: string): Promise<unknown> {
    let msg: any; try { msg = JSON.parse(raw); } catch { return { ok: false, denied: true, error: 'malformed request' }; }
    const { seq, tool, args } = msg ?? {};
    if (this.suspendedThisSegment) return { suspend: true };
    if (!Number.isInteger(seq) || typeof tool !== 'string') return { ok: false, denied: true, error: 'malformed request' };
    const argsHash = hashObject(args ?? {});
    if (seq < this.journal.length) {
      const e = this.journal[seq]!;
      if (e.tool !== tool || e.args_hash !== argsHash) { this.violations.push(`replay mismatch at call ${seq}`); return { ok: false, denied: true, error: 'non-deterministic program: replayed call differs from the journal' }; }
      this.replayed++;
      return e.ok ? { ok: true, result: e.result } : { ok: false, denied: e.denied, error: e.error };
    }
    if (seq !== this.journal.length || this.pending) return { ok: false, denied: true, error: 'out-of-order call' };
    const run = this.handler(tool, args, seq).then(
      (result) => { this.journal[seq] = { seq, tool, args_hash: argsHash, ok: true, result }; },
      (e) => { this.journal[seq] = { seq, tool, args_hash: argsHash, ok: false, error: String(e?.message ?? e).slice(0, 500), denied: e?.kind === 'sandbox_violation' || e?.kind === 'budget_exceeded' }; },
    );
    this.inflight.add(run); run.finally(() => this.inflight.delete(run));
    if (this.isLong(tool)) {
      const remaining = this.segmentDeadline - performance.now() - 750;
      const done = await Promise.race([run.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), Math.max(0, remaining)))]);
      if (!done) { this.pending = { seq, promise: run }; this.suspendedThisSegment = true; return { suspend: true }; }
    } else await run;
    const e = this.journal[seq]!;
    return e.ok ? { ok: true, result: e.result } : { ok: false, denied: e.denied, error: e.error };
  }

  async settle(): Promise<void> {
    if (this.pending) { await this.pending.promise; this.pending = null; }
    await Promise.all([...this.inflight]);
  }
}

/** Placeholder replaced by the generated or reviewed program text. */
export function segmentModule(programText: string): string {
  return BOOTSTRAP_TEMPLATE.replace('/*__PROGRAM__*/', () => programText);
}

/**
 * Prove the runtime restrictions before generated code is enabled: a trusted probe attempts denied
 * operations inside the same executor configuration. Any allowed operation disables generated execution.
 */
export async function sandboxSelfTest(deno: string, workDir: string): Promise<{ ok: boolean; results: Record<string, string>; deno_version: string | null; error: string | null }> {
  const broker = new Broker(async () => ({ pong: true }), () => false, () => undefined);
  const port = await broker.start();
  const nonce = 'N' + randomBytes(8).toString('hex');
  const probe = `
const cfg = JSON.parse(await new Response(Deno.stdin.readable).text());
const r = {};
const attempt = async (k, f) => { try { await f(); r[k] = 'ALLOWED'; } catch (e) { r[k] = e && e.name ? e.name : 'Error'; } };
await attempt('read_file', () => Deno.readTextFileSync(${JSON.stringify(join(PROJECT_ROOT, 'package.json'))}));
await attempt('write_file', () => Deno.writeTextFileSync(${JSON.stringify(join(workDir, 'probe-write.txt'))}, 'x'));
await attempt('env', () => { const v = Deno.env.get('PATH'); if (v === undefined) throw new Error('no env'); });
await attempt('run_process', () => new Deno.Command(${JSON.stringify(process.execPath)}, { args: ['-v'] }).outputSync());
await attempt('ffi', () => Deno.dlopen('libc.so.6', {}));
await attempt('sys', () => Deno.hostname());
await attempt('net_other_port', async () => { await fetch('http://127.0.0.1:' + (cfg.port === 1 ? 2 : 1) + '/'); });
await attempt('net_external', async () => { await fetch('https://example.com/'); });
await attempt('eval', () => eval('1'));
await attempt('function_ctor', () => new Function('return 1')());
await attempt('remote_import', async () => { await import('https://example.com/x.js'); });
await attempt('npm_import', async () => { await import('npm:left-pad'); });
await attempt('permission_prompt', async () => { const s = await Deno.permissions.request({ name: 'read' }); if (s.state !== 'granted') throw new Error('denied'); });
let broker = 'error';
try { const res = await fetch('http://127.0.0.1:' + cfg.port + '/call', { method: 'POST', headers: { authorization: 'Bearer ' + cfg.token }, body: JSON.stringify({ seq: 0, tool: 'probe', args: {} }) }); broker = (await res.json()).ok ? 'reachable' : 'rejected'; } catch (e) { broker = 'unreachable'; }
r.broker = broker;
Deno.stdout.writeSync(new TextEncoder().encode(cfg.nonce + JSON.stringify({ status: 'done', result: { results: r, version: Deno.version.deno }, logs: [] }) + '\\n'));
Deno.exit(0);`;
  try {
    const out = await runDenoModule({ deno, moduleSource: probe, file: join(workDir, 'sandbox-probe.js'), stdin: { port, token: broker.token, nonce }, nonce, port, timeoutMs: 20000, maxStdoutBytes: 65536 });
    if (out.status !== 'done') return { ok: false, results: {}, deno_version: null, error: out.error ?? 'probe failed' };
    const res = (out.result as any).results as Record<string, string>;
    const deniedKeys = Object.keys(res).filter((k) => k !== 'broker');
    const ok = deniedKeys.every((k) => res[k] !== 'ALLOWED') && res.broker === 'reachable' && !existsSync(join(workDir, 'probe-write.txt'));
    return { ok, results: res, deno_version: (out.result as any).version ?? null, error: ok ? null : 'a restricted operation was allowed or the broker was unreachable' };
  } finally { await broker.stop(); }
}

export function newNonce(): string { return 'R' + randomBytes(12).toString('hex') + ':'; }
export { LabError };
