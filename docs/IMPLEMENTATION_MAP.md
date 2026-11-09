# Implementation map (Claude Code build)

Node LTS + TypeScript (run with `tsx`), SQLite via built-in `node:sqlite`, FFmpeg/ffprobe through argument arrays, FalkorDB via the official `falkordb` client, TwelveLabs via the official `twelvelabs-js` SDK, Gemini via the official `@google/genai` SDK, Code Mode in a pinned, restricted Deno (`deno` npm package). The UI is server-rendered HTML with small inline scripts (no React/Vite build step was needed for the two views).

| Area | Module | Notes |
|---|---|---|
| Config | `src/config/schema.ts`, `src/config/load.ts` | Strict schema, unknown-key rejection, bounded limits, env resolution, redacted resolved-config hash, all missing inputs listed together |
| Telemetry | `src/telemetry/trace.ts` (wraps unmodified `examples/telemetry.mjs`), `ledger.ts`, `budget.ts`, `aggregate.ts` | span_start + span_end JSONL and SQLite, crash recovery (`interrupted`), self time by interval union, per-attempt call ledger, unknown cost stays null, hard budgets |
| Store | `src/store/db.ts` | runs, events, spans, calls, asset cache (per account fingerprint), result cache, feedback, programs |
| Media | `src/media/proc.ts`, `probe.ts`, `prepare.ts`, `evidence.ts` | snapshot + before/after hashing, decode check, provider/browser normalisation without enhancement, per-frame seek maps (VFR, start offset, rotation), exact-frame evidence extraction |
| Ontology | `src/ontology/source.ts`, `importer.ts`, `backend.ts`, `service.ts`, `capabilities.ts`, `open.ts` | Staged content-addressed import with full round-trip verification; fixed-template read-only primitives over FalkorDB and an equivalent `json_snapshot` diagnostics adapter; typed methods; capability compiler; draft overlay; approval registry |
| Providers | `src/providers/call.ts`, `twelvelabs.ts`, `gemini.ts`, `schema-translate.ts` | Error taxonomy, bounded retries with backoff spans, direct asset upload, readiness polling, Pegasus 1.6 structured JSON, Gemini inline ordered frames / Files API, schema subset translation |
| Orchestration | `src/orchestration/toolhost.ts`, `fixed.ts`, `prompts.ts`, `validate-outputs.ts`, `programs/reviewed/default-v1.js` | One job-scoped tool host for both modes; reviewed program shared by fixed mode and Code Mode |
| Code Mode | `src/orchestration/codemode/{validate,executor,run}.ts`, `bootstrap.template.js` | Static policy, restricted Deno executor, loopback broker with capability token, replay journal for long host tasks, planner/repair/follow-up turns, self-test before enabling |
| Assessment | `src/assessment/assess.ts` | Activity agreement rules, answer merging, claim checks, drill eligibility (approval, sport, age), rubric gating, outcome |
| Report | `src/report/build.ts`, `athlete-html.ts`, `console-html.ts`, `exports.ts`, `styles.ts` | lab-contract report.json, full section inventory, allowlisted athlete DTO, branded HTML (live + export), 9-tab internal console, CSV with formula escaping |
| Server | `src/server/app.ts` | Loopback only, Host/Origin checks, range-request media by job media ID, evidence, exports, feedback, SSE progress, dashboard |
| Runner | `src/jobs/runner.ts`, `context.ts` | States/outcomes, cancel, wall-time budget, result cache, warm asset reuse, resume checkpoints, immutable run folders |
| CLI | `src/cli/*.ts` | `doctor`, `provider:smoke`, `ontology:import`, `analyse`, `ui`, `batch`, `cleanup` |
| Tests | `test/*.test.ts` | media, ontology (live graph), sandbox, pipeline (mock providers + live graph), UI (Playwright, optional) |
