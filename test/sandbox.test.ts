import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Broker, newNonce, resolveDeno, runDenoModule, sandboxSelfTest, segmentModule, sandboxEnv } from '../src/orchestration/codemode/executor.js';
import { validateProgram, reviewedProgramText } from '../src/orchestration/codemode/validate.js';
import { fromRoot } from '../src/util/paths.js';
import { tmp } from './helpers.js';

const deno = resolveDeno(process.env.DENO_BIN || 'deno');
const TOOLS = ['media.describe', 'video.discover', 'vision.inspect'];

async function runProgram(program: string, handler: (tool: string, args: any, seq: number) => Promise<unknown>, o: { timeoutMs?: number; maxStdout?: number; long?: string[]; segments?: number } = {}) {
  const dir = tmp('sbx-');
  const broker = new Broker(handler, (t) => (o.long ?? []).includes(t), () => undefined);
  const port = await broker.start();
  const outs = [];
  try {
    for (let seg = 1; seg <= (o.segments ?? 1); seg++) {
      const nonce = newNonce();
      const timeoutMs = o.timeoutMs ?? 5000;
      broker.beginSegment(seg, performance.now() + timeoutMs);
      const out = await runDenoModule({ deno, moduleSource: segmentModule(program), file: join(dir, `seg${seg}.js`), stdin: { port, token: broker.token, nonce, segment: seg, tools: TOOLS, input: { x: 1 } }, nonce, port, timeoutMs, maxStdoutBytes: o.maxStdout ?? 65536 });
      await broker.settle();
      outs.push(out);
      if (out.status !== 'suspended') break;
    }
  } finally { await broker.stop(); }
  return { outs, broker, dir };
}

test('restricted executor self-test: every denied capability is denied and the broker is reachable', async () => {
  const r = await sandboxSelfTest(deno, tmp('probe-'));
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const k of ['read_file', 'write_file', 'env', 'run_process', 'ffi', 'sys', 'net_other_port', 'net_external', 'eval', 'function_ctor', 'remote_import', 'npm_import', 'permission_prompt']) assert.notEqual(r.results[k], 'ALLOWED', k);
  assert.equal(r.results.broker, 'reachable');
});

test('sandbox environment does not inherit secrets or Node/Deno configuration', () => {
  process.env.GEMINI_API_KEY = 'should-not-leak'; process.env.NODE_OPTIONS = '--require x'; process.env.DENO_PERMISSION_BROKER_PATH = '/tmp/x';
  const env = sandboxEnv();
  assert.equal(env.GEMINI_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.DENO_PERMISSION_BROKER_PATH, undefined); assert.equal(env.PATH, undefined);
});

test('static policy rejects imports, runtime access, code generation and unknown tools', () => {
  const head = 'async function program(tools, input) {\n';
  const bad: Record<string, string> = {
    import: head + "const fs = await import('node:fs'); }",
    require: head + "require('fs'); }",
    deno: head + 'Deno.readTextFileSync("x"); }',
    eval: head + 'eval("1"); }',
    fetch: head + 'await fetch("http://x"); }',
    global: head + 'globalThis.x = 1; }',
    ctor: head + '(async () => {}).constructor("return 1"); }',
    unknown_tool: head + 'await tools.shell.run({}); }',
    computed: head + "await tools['video']['discover']({}); }",
    cypher: head + "await tools.ontology.getProtocol({ protocol_uid: 'x' }); const q = 'MATCH (n) DETACH DELETE n'; }",
    escape: head + 'const s = "\\u0069mport"; }',
    no_signature: 'const x = 1;',
  };
  for (const [k, src] of Object.entries(bad)) assert.equal(validateProgram(src).ok, false, k);
  const reviewed = reviewedProgramText(readFileSync(fromRoot('programs/reviewed/default-v1.js'), 'utf8'));
  assert.deepEqual(validateProgram(reviewed).errors, [], 'reviewed program passes its own policy');
});

test('runtime denial even if static validation were bypassed: files, env, processes and unauthenticated broker calls', async () => {
  const program = `async function program(tools, input) {
    const r = {};
    try { Deno.readTextFileSync(${JSON.stringify(fromRoot('.env.example'))}); r.read = 'ALLOWED'; } catch (e) { r.read = e.name; }
    try { Deno.env.toObject(); r.env = 'ALLOWED'; } catch (e) { r.env = e.name; }
    try { new Deno.Command('node').outputSync(); r.run = 'ALLOWED'; } catch (e) { r.run = e.name; }
    try { const p = 'http://127.0.0.1:' + 6380 + '/'; await fetch(p); r.net = 'ALLOWED'; } catch (e) { r.net = e.name; }
    return r;
  }`;
  const { outs } = await runProgram(program, async () => ({}));
  assert.equal(outs[0]!.status, 'done', outs[0]!.error ?? '');
  const r = outs[0]!.result as Record<string, string>;
  for (const k of ['read', 'env', 'run', 'net']) assert.notEqual(r[k], 'ALLOWED', k);
});

test('tool calls go through the broker; host errors surface as denials', async () => {
  const program = `async function program(tools, input) {
    const a = await tools.media.describe({});
    let denied = null;
    try { await tools.vision.inspect({ bad: true }); } catch (e) { denied = e.name + ':' + e.message; }
    return { a, denied, input };
  }`;
  const calls: string[] = [];
  const { outs } = await runProgram(program, async (tool, args) => { calls.push(tool); if (tool === 'vision.inspect') { const e: any = new Error('Invalid arguments'); e.kind = 'sandbox_violation'; throw e; } return { ok: 1 }; });
  assert.equal(outs[0]!.status, 'done');
  const r = outs[0]!.result as any;
  assert.deepEqual(r.a, { ok: 1 }); assert.match(r.denied, /ToolDenied:Invalid arguments/); assert.deepEqual(r.input, { x: 1 });
  assert.deepEqual(calls, ['media.describe', 'vision.inspect']);
});

test('watchdog terminates runaway code', async () => {
  const t0 = Date.now();
  const { outs } = await runProgram('async function program(tools, input) { let i = 0; for (;;) { i++; } }', async () => ({}), { timeoutMs: 1500 });
  assert.equal(outs[0]!.status, 'killed_timeout');
  assert.ok(Date.now() - t0 < 6000);
});

test('stdout cap terminates oversized output', async () => {
  const { outs } = await runProgram('async function program(tools, input) { const s = "x".repeat(10000); for (let i = 0; i < 100; i++) await Promise.resolve(); return { big: s.repeat(20) }; }', async () => ({}), { maxStdout: 4096 });
  assert.equal(outs[0]!.status, 'killed_output');
});

test('long host task suspends the segment and resumes by deterministic replay', async () => {
  let discoverRuns = 0;
  const program = `async function program(tools, input) {
    const m = await tools.media.describe({});
    const d = await tools.video.discover({});
    return { m, d };
  }`;
  const { outs, broker } = await runProgram(program, async (tool) => { if (tool === 'video.discover') { discoverRuns++; await new Promise((r) => setTimeout(r, 2500)); return { windows: 2 }; } return { dur: 3 }; }, { timeoutMs: 1500, long: ['video.discover'], segments: 4 });
  assert.equal(outs[0]!.status, 'suspended', 'first segment suspended instead of being killed');
  assert.equal(outs.at(-1)!.status, 'done');
  assert.deepEqual(outs.at(-1)!.result, { m: { dur: 3 }, d: { windows: 2 } });
  assert.equal(discoverRuns, 1, 'the long provider request was not repeated');
  assert.ok(broker.replayed >= 1, 'earlier calls were replayed from the journal');
});

test('non-deterministic programs are rejected on replay', async () => {
  const program = `async function program(tools, input) {
    await tools.media.describe({});
    await tools.video.discover({ n: Date.now() });
    return 1;
  }`;
  const { outs } = await runProgram(program, async (tool) => { if (tool === 'video.discover') { await new Promise((r) => setTimeout(r, 1800)); } return {}; }, { timeoutMs: 1200, long: ['video.discover'], segments: 3 });
  assert.equal(outs[0]!.status, 'suspended');
  const last = outs.at(-1)!;
  assert.notEqual(last.status, 'done');
  assert.ok(/non-deterministic/.test(String(last.error)));
});

test('generated code cannot write into the project', async () => {
  const target = fromRoot('should-not-exist.txt');
  const { outs } = await runProgram(`async function program(tools, input) { try { Deno.writeTextFileSync(${JSON.stringify(target)}, 'x'); return 'ALLOWED'; } catch (e) { return e.name; } }`, async () => ({}));
  assert.notEqual(outs[0]!.result, 'ALLOWED');
  assert.equal(existsSync(target), false);
});
