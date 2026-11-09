# BUILD_REPORT — StriideAi local analysis lab (Claude Code build)

Completion record required by docs/07_CODING_AGENT_COMPARISON.md. Everything below reflects commands that were actually run. Live provider checks have **not** run: no TwelveLabs or Gemini credentials were available to this build.

## 1. Environment and tools

| Item | Value |
|---|---|
| Coding agent | Claude Code, cloud session (container CLI 2.1.319), effort setting "medium", auto permission mode. The exact coding model is recorded in the session, not in repository files (session policy). |
| Build window | 2026-11-09 00:22 → about 01:20 UTC, one session, no resets |
| Human interventions | One launch prompt; no corrections or manual commands during the build |
| Coding-agent usage/cost | Unknown (not observable from inside the session) |
| Spec snapshot | Pack v0.2 committed unmodified as the first commit (`6d0c1ae`); ontology SHA-256 `145700e7…2bd0e` |
| OS (build) | Linux container (not Windows). Windows steps in docs/LAB_SETUP_WINDOWS.md are written but unexecuted on Windows |
| Node / npm | 22.23.4 / 10.9.9 |
| Packages (pinned, lockfile) | twelvelabs-js 1.3.8, @google/genai 3.0.0, falkordb 7.0.0, ajv 8.20.0, yaml 2.9.1, deno 2.9.6 (dev), typescript 5.9.3, tsx 4.23.15 |
| FFmpeg | 6.1.1 (libx264, libx265) |
| Docker / FalkorDB | Docker 29.9.2 (daemon started inside the build container); `falkordb/falkordb@sha256:bef8acb1d8ed9ff8d2ea251767e75c6c05cfa759f7c6bc7e1c122f27d0ea4d7f` |
| Playwright Chromium (tests only) | 153.0.8010.12, pre-installed in the build container |

Chosen modules: see docs/IMPLEMENTATION_MAP.md. The UI is server-rendered HTML with small inline scripts; a React/Vite build was not needed for two views. SQLite is Node's built-in `node:sqlite` (no native module to compile on Windows).

## 2. Features: implemented vs absent

### Setup, config, doctor
- A bug found by the tests and fixed: crash recovery now starts recovered span records on a fresh line after a torn write.
- Implemented: strict config schema (unknown keys rejected, bounded limits, `const` guardrails for pose metrics/rubric/export separation), env resolution, redacted resolved-config hash, all missing inputs reported together; doctor covers versions, libx264, Deno + sandbox self-test, writable output, input root, ontology hash, overlay, approvals, pricing/cap consistency, FalkorDB connection and live import counts, image digest, port, Docker. No paid inference.

### Ontology
- Implemented: `npm run ontology:import` with source hash check, structural validation (no repair), staged load → full round-trip verification (every node and relationship fingerprint) → `GRAPH.COPY` to `striide_lab_<sha16>` → re-verify → atomic manifest. UID indexes on all 23 labels. Re-import of a verified graph is a no-op; an invalid lab graph is refused unless `--replace-invalid-lab-graph`; unrelated graphs are never touched; stale staging graphs of the same source only are removed. Reversible serialisation for non-native values (none needed for this source).
- Read-only typed methods (getCatalogue, getRecognitionProfiles, getCandidateProtocols, getProtocol, getInspectionQuestions, getDrillCandidates, getContentApprovals, ID validation) over fixed, allowlisted query templates; equivalent `json_snapshot` adapter (diagnostics only, refused for analysis).
- Capability compiler: every numeric metric excluded with a reason (no pose/tracking source); faults/strengths tied to metrics excluded; detector "engineStatus" treated as specification only; categorical answer vocabularies outside yes/partly/no excluded with reason; low FPS produces a note, not a rejection.
- Draft recognition overlay used for conflicts only, labelled draft.

### Media
- Snapshot + before/after hashing, ffprobe, full decode check, normalisation to H.264/yuv420p without enhancement (upscale of sub-360 px sources is labelled "adds no detail"), separate browser playback copy for HEVC, frame-timing passthrough (`-enc_time_base demux`, `-bf 0`), per-frame seek maps for VFR, non-zero start and rotation; evidence frames extracted by exact frame timestamps.

### Providers
- TwelveLabs: official SDK, direct asset upload streamed from disk, neutral filenames, optional HLS/thumbnails disabled, readiness polling with separate attempt/wait spans and typed failed/timeout outcomes, Pegasus 1.6 set explicitly (SDK default is 1.5), `asset_id` video reference, translated response schema, finish-reason handling, verified deletion.
- Gemini: official SDK with hidden retries disabled (`attempts: 1`), inline ordered JPEG frames with evidence IDs and source timestamps, 12 MB evidence cap, Files API upload + ACTIVE polling path, usage mapping (prompt/candidates/cached/thinking).
- Shared: error taxonomy (429 / 5xx / timeout (unknown outcome) / transport / auth / client / content / truncation), bounded retries within per-request and run budgets, one ledger record per attempt, redacted request/response artifacts.
- Mocks: offline test doubles in `test/mocks.ts` only; runs made with them are labelled "offline-mock" in provenance, the console and every athlete export.

### Orchestration and Code Mode
- One job-scoped ToolHost with the specified catalogue (media.describe, ontology.*, video.discover incl. windowed follow-up, media.extractEvidence, vision.inspect, assessment.validate/calculate, report.assemble); argument validation, tool-call/model/follow-up/frame budgets; reasons recorded for every additional inspection; a follow-up must change evidence or questions.
- `ontology_fixed`: reviewed program (`programs/reviewed/default-v1.js`) imported normally (no eval).
- `ontology_code`: planner turn(s) → static policy → restricted Deno executor; one repair turn; reviewed-program reuse inside the sandbox if generation is invalid (configurable); optional follow-up planning turn. Long host tasks suspend the segment and resume by deterministic replay (non-determinism detected and rejected). Self-test proves denials before generated code runs; failure disables Code Mode with an error (no host eval fallback).
- Deno flags: `--no-prompt --no-config --no-lock --no-npm --no-remote`, deny read/write/env/run/ffi/sys, net only to the ephemeral broker port, `--disallow-code-generation-from-strings`, 128 MB heap; minimal environment; watchdog and stdout cap. This is prototype containment, not production-grade isolation.

### Assessment and report
- Activity "established" only when Pegasus and the Gemini frame verdict agree with evidence; disagreement stays provisional/unknown; unresolved conflicts → `needs_context`; ambiguous target → `needs_context`.
- Claim checks withhold numeric measurements, injury/fatigue, strength, psychological, nutrition, age and grade claims and banned cues from the athlete view; measured/numeric findings are rejected.
- Scores null unless experimental scoring is enabled **and** an approved rubric exists **and** every criterion is evidenced; radar only with ≥3 approved scored axes.
- Drills: only registry-approved, sport-matched, age-eligible items (unknown age never passes a minimum age); all ontology drills are currently drafts and stay in the internal area.
- Report inventory (docs/02): all 18 sections always present with an explicit state and reason. Strengths/priorities grouping is labelled provisional (it assumes protocol questions describe target technique).
- Athlete JSON/HTML/CSV built from an allowlisted DTO (no telemetry, model IDs, asset IDs, paths or secrets); print/PDF styling with embedded evidence thumbnails; CSV formula escaping; all model text escaped.
- Internal console tabs: Overview, Timeline (waterfall + stage union + self time), Discovery/compare, Inspection (frames, answers, exclusions, disagreements), Ontology (graph hash, retrieved IDs, approval state, query timings), Requests (attempts, request IDs, usage, cost status, artifacts), Code Mode, Validation, Compare runs. Optimisation dashboard with median/p95 per stage, stated n, failure rate, coverage, follow-up rate, known-cost coverage and trace-derived suggestions.
- Server: loopback, Host/Origin checks, range requests, job media IDs only, coach feedback saved against report version + SHA-256, SSE progress with real state events, UI-observed time-to-first-report/replay readiness recorded separately.

### Runner, telemetry, batch
- States and outcomes as specified; cancel (UI/SIGINT); wall-time budget; immutable run folders; result cache (new run record, zero new usage, provenance to original run); warm asset reuse per account fingerprint with re-verification; resume from checkpoints (media + completed requests, zero-usage cache-hit records); crash recovery closes open spans as `interrupted`.
- Outputs per run: report.json, athlete.json/html/csv, trace.jsonl (start + end events), metrics.csv, calls.jsonl, manifest.json, media.manifest.json, evidence/, artifacts/ (redacted), assessment.internal.json, codemode.json, diagnostic.json on failure.
- Batch: case manifest, both modes, repeats, missing-video rows, heuristic agreement flags kept out of model inputs, aggregate stats. Cleanup: result cache / Deno cache, verified deletion of provider assets owned by this lab for the same account.

### Absent or limited
- No live run of TwelveLabs or Gemini (no credentials). Field names come from the official SDK type definitions; docs.twelvelabs.io was not reachable from the build environment.
- Gemini Files API transport is implemented in the adapter but the reviewed program uses inline frames; no live test.
- PDF is produced through the browser's print dialog; no headless PDF export step.
- Reference search remains disabled (no curated index). No schema 2.1 adapter (no sample supplied).
- Monetary caps are not enforced (pricing table is unset); doctor fails if a cap is configured without complete prices.
- Camera view is not classified; reported as "not classified".

## 3. Exact commands

```bash
node bootstrap/falkordb.mjs up
npm run ontology:import -- --config config.local.yaml
node bootstrap/falkordb.mjs verify
npm run doctor -- --config config.local.yaml
npm run build
npm test
npm run test:reference
node examples/telemetry-demo.mjs
npm run analyse -- --config config.local.yaml --video videos/testpattern.mp4
npm run ui -- --config config.local.yaml
npm run batch -- --config config.local.yaml --manifest evaluation/cases.example.json
npm run provider:smoke -- --config config.local.yaml --yes
```

Windows equivalents: docs/LAB_SETUP_WINDOWS.md.

## 4. Offline test results (actually run, 2026-11-09)

| Command | Exit | Result | Artifact |
|---|---:|---|---|
| `npm run build` (tsc strict + syntax checks) | 0 | clean | docs/validation/build.txt |
| `npm test` | 0 | 53 tests, 53 pass, 0 fail, 0 skipped (~81 s) | docs/validation/npm-test.tap.txt, npm-test.summary.txt |
| `npm run test:reference` (supplied telemetry tests) | 0 | 7/7 pass | docs/validation/reference-telemetry.tap.txt |
| `node examples/telemetry-demo.mjs` | 0 | demo output, zero provider calls | examples/demo-output (ignored) |
| `node bootstrap/falkordb.mjs verify` | 0 | verified=true, 7172 nodes, 19803 edges, 5 cricket protocols | docs/validation/falkordb-verify.json |
| `npm run doctor` | 1 | all checks OK except `inputs` (keys/model IDs absent) and a pricing warning | docs/validation/doctor.txt |
| `npm run analyse` on a test pattern | 1 | `failed` / `config`: all four missing inputs listed after the graph was verified; diagnostic page served | runs/ (ignored) |
| `npm run batch` with the example manifest | 0 | 6 cases recorded as `missing_video` | runs/_batch (ignored) |

Mapping to the docs/03 acceptance tests (offline evidence; provider behaviour simulated with labelled mocks except where noted):

| # | Acceptance test | Evidence |
|---|---|---|
| 1 | Corrupt/unsupported file → clear outcome + trace | media.test (corrupt, truncated), pipeline "corrupt input is rejected" |
| 2 | 352 px input normalised without claiming detail | media.test "352-pixel-wide input…" |
| 3 | HEVC → browser playback, seeking correct | media.test HEVC (frame timeline identical, pixel-verified frame) |
| 4 | Readiness failed/timeout; polls/waits/retries separate | pipeline readiness failure + timeout + 429 retry tests |
| 5 | Conflicting sport label reinspected within budget or uncertain; no irrelevant drills | pipeline conflict + unresolved-conflict tests |
| 6 | Missing view → not_assessable, not zero | pipeline "missing view…" |
| 7 | Age 11 excludes min-age-12 drills; unknown age never passes | units.test "age 11 excludes…" (also sport mismatch, unapproved draft, banned cue) |
| 8 | No pose detector → no numeric pose metric | ontology capability test, pipeline numeric-claim rejection |
| 9 | No reviewed rubric → score null, no radar | pipeline fixed-mode test |
| 10 | Parallel spans not double-counted; root elapsed truthful | supplied reference tests; pipeline wall-time assertion |
| 11 | Unknown price null; retry usage included | pipeline 429 test (failed attempt counted as unknown) |
| 12 | Secrets and raw output absent from athlete export | pipeline + UI export tests |
| 13 | Evidence click seeks the matching moment | UI test: Playwright click → `currentTime` and decoded pixel luma identify the exact fixture frame (VFR clip with 5 s start offset) |
| 14 | Import idempotent, UIDs preserved, production graph untouched | ontology live-import test + manual re-import (`action: reused`) |
| 15 | Generated code cannot read files/env, run processes, call unknown tools, escape scope, exceed limits | sandbox tests (10) + pipeline Code Mode tests (repair, fallback, tool-budget denial) |
| 16 | Model error → internal diagnostic, no fabricated report | pipeline "model error…", UI diagnostic page |

## 5. Graph verification and persistence

- Graph `striide_lab_145700e7ac5e3307`, source SHA-256 `145700e7ac5e33070984abb4ffdc1f0ab0a9a0038b0b012b853828f16da2bd0e`, 7172 nodes / 19803 relationships; all nodes and relationships match the source by fingerprint; 23 UID indexes; lookups OK: sport, cricket protocols, visual questions, camera constraints, drill candidates, sport→protocol chain.
- Re-import: `action: reused` (no duplication, including the 15 parallel relationship groups).
- Persistence: `node bootstrap/falkordb.mjs stop` → `up` → `verify` returned the same counts (volume not deleted).
- Import telemetry: `runs/_ontology_import/<timestamp>/trace.jsonl` (local, ignored by git). Import time about 6 s including two full verifications.

## 6. Report, telemetry and evidence paths

Only offline-mock runs exist (from tests, in temporary folders, and labelled as fixtures). No real-footage report exists. A real run writes to `runs/<run_id>/` and is viewed at `http://127.0.0.1:8788/runs/<run_id>/report` and `/console`.

## 7. Live checks — status

| Check | Status |
|---|---|
| `npm run provider:smoke` (TwelveLabs upload/readiness/Pegasus 1.6, Gemini inspector/planner) | **Unrun** — keys and model IDs absent; command exits with the missing-input list |
| Real-footage analysis in `ontology_fixed` / `ontology_code` | **Unrun** |
| Cold vs warm vs cache comparison on real clips | **Unrun** (mechanics tested with mocks) |
| Coach review of report content | **Unrun** |
| Windows execution of these steps | **Unrun** (built and tested on Linux) |

## 8. Known issues, trade-offs and remaining manual steps

1. Provider request/response field names follow the official SDK types (TwelveLabs 1.3.8, @google/genai 3.0.0); the provider documentation sites could not be fetched from the build environment. `provider:smoke` must be run first with real keys.
2. Pegasus action-window times are assumed to be seconds from the start of the prepared clip. Prepared media is normalised to start at 0 to make this unambiguous, but this needs confirmation in the live smoke/analysis run.
3. Provider media limits (360 px minimum side, 3840×2160 maximum, HEVC accepted) are lab assumptions recorded in `src/media/prepare.ts`.
4. Strength/priority grouping assumes "yes" means target technique; flagged as provisional in every report.
5. All 346 ontology drills are drafts with no reviewer, so no drill can be prescribed until the local approval registry lists one.
6. Gemini Files API path and `cleanup --provider-assets` have no live test.
7. Static program policy is deliberately strict (e.g. the word `import` anywhere is rejected); the Deno permission layer is the real boundary and is prototype containment only.
8. `node:sqlite` prints an experimental warning on Node 22; npm scripts suppress it.
9. Manual steps for the user: set keys/model IDs and a FalkorDB password in `.env`, pin `FALKORDB_IMAGE` to the digest above, add real clips under `input_root`, run `provider:smoke`, then real analyses and a coach review.

## 9. Scorecard

Not scored: the live-provider categories are untested for this build, so per docs/07 no final score is calculated and no comparison with the Cursor build is claimed.
