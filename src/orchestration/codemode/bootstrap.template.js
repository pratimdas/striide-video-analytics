// Trusted bootstrap for one Code Mode execution segment (StriideAi local lab).
// Runs inside Deno with --no-prompt, filesystem/env/run/ffi/sys denied, network limited to the
// job broker port and code generation from strings disabled. No external dependencies.
// The capability token and output nonce live only inside this closure; the program cannot reach them.
const { tools, input, __finish } = await (async () => {
  const raw = await new Response(Deno.stdin.readable).text();
  const cfg = JSON.parse(raw);
  const send = globalThis.fetch.bind(globalThis);
  const stringify = JSON.stringify, parse = JSON.parse, write = (s) => Deno.stdout.writeSync(new TextEncoder().encode(s));
  const url = `http://127.0.0.1:${cfg.port}/call`;
  const auth = `Bearer ${cfg.token}`;
  const nonce = cfg.nonce;
  let seq = 0; let suspended = false; const logs = [];
  class SuspendSignal extends Error { constructor() { super('segment suspended for a long host task'); this.name = 'SuspendSignal'; } }
  async function call(name, args) {
    if (suspended) throw new SuspendSignal();
    const mySeq = seq++;
    let res;
    try {
      res = await send(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: stringify({ seq: mySeq, segment: cfg.segment, tool: name, args: args === undefined ? {} : args }) });
    } catch (e) { throw new Error('broker unavailable'); }
    const body = parse(await res.text());
    if (body.suspend) { suspended = true; throw new SuspendSignal(); }
    if (!body.ok) { const err = new Error(body.error || 'tool call failed'); err.name = body.denied ? 'ToolDenied' : 'ToolError'; throw err; }
    return body.result;
  }
  const t = {};
  for (const full of cfg.tools) {
    const [ns, fn] = full.split('.');
    t[ns] = t[ns] || {};
    t[ns][fn] = (args) => call(full, args);
  }
  for (const ns of Object.keys(t)) Object.freeze(t[ns]);
  Object.freeze(t);
  const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
  // Program console output is captured (bounded) rather than mixed with the result channel.
  const cap = (...a) => { if (logs.length < 200) logs.push(a.map((x) => { try { return typeof x === 'string' ? x : stringify(x); } catch { return String(x); } }).join(' ').slice(0, 500)); };
  globalThis.console = Object.freeze({ log: cap, info: cap, warn: cap, error: cap, debug: cap });
  const finish = (status, payload) => { write(`\n${nonce}${stringify({ status: suspended ? 'suspended' : status, ...payload, logs })}\n`); Deno.exit(0); };
  return { tools: t, input: deepFreeze(cfg.input), __finish: finish };
})();

/*__PROGRAM__*/

try {
  const result = await program(tools, input);
  __finish('done', { result: result === undefined ? null : result });
} catch (e) {
  __finish(e && e.name === 'SuspendSignal' ? 'suspended' : 'error', { error: String((e && e.message) || e).slice(0, 1000), error_name: e && e.name });
}
