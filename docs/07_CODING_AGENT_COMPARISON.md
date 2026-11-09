# Cursor vs Claude Code — shared comparison

## What is being compared

Both coding agents build the same local StriideAi application. BUILD_TASK.md is the canonical request. Model/provider settings inside the app remain TwelveLabs/Gemini. This is distinct from comparing the app's ontology_fixed and ontology_code execution modes.

If possible, use the same underlying coding model and comparable effort settings in both tools to isolate agent-tooling differences. If models differ, describe the result as a comparison of the complete agent + model setups. Record versions, enabled tooling and any global rules/plugins/memory affecting either build; do not modify machine-wide settings automatically.

## Independent starting points

Extract two fresh copies from the same archive. Save its hash and initialise each repository from the identical specification snapshot if using Git. Do not let either agent read the other's generated code or repairs during the first pass. Both may use the same official docs and package sources. Use the same environment, provider access, source videos and evaluation labels.

For independent Docker volumes and ports, use these local values:

| Setting | Cursor folder | Claude Code folder |
|---|---|---|
| COMPOSE_PROJECT_NAME in .env | striideai-cursor-lab | striideai-claude-lab |
| FALKORDB_PORT in .env | 6379 | 6380 |
| FALKORDB_BROWSER_PORT in .env | 3000 | 3001 |
| server.port in config.local.yaml | 8787 | 8788 |
| paths.output_root | ./runs | ./runs |

Each folder's relative runs directory, SQLite state and import manifest stay separate. The content-addressed graph prefix can remain striide_lab because each Compose project has its own database volume. Start/import/verify each database independently. Keep both image digests and ontology source hashes equal. No provider credentials are included in source snapshots.

## First-pass protocol

1. Give each agent its launcher prompt and the same BUILD_TASK.md. Allow the same time/spend allowance and access to local tools. Record interventions and permission-prompt overhead instead of silently helping one more than the other.
2. Let each implement and test without giving it solutions from the competing attempt. Log start/finish time, user active minutes, sessions/resets, manual commands and corrections.
3. Capture the first working milestone and the final checked state separately. An impressive preview is not a working upload/discovery/inspection/import pipeline.
4. Run the shared acceptance checks from docs/03 and docs/00 independently on each implementation. Agent-authored tests are evidence, not the sole judge. Preserve the original supplied contracts and reference tests.
5. Use the same videos/configuration and perform a fresh/cold run and a warmed run separately. Account-scoped provider asset caches and result-cache hits must be labelled. Do not accidentally give one build cached inference results.
6. Compare coaching content/evidence with a coach and, where practical, hide which agent built each report during review. Competitor grades are not ground truth.
7. Freeze a first-pass outcome before giving repair instructions. Track post-repair quality separately. Repeat a fresh build if the first result is close; one trial does not establish a universal winner.

## Completion record each agent must write

BUILD_REPORT.md must contain:
- Environment/tool versions and chosen implementation modules.
- Features implemented vs absent, using the common report/telemetry inventory.
- Exact setup, import, verify, analysis and UI commands.
- Actual offline tests with command, exit status and output artifact; live checks separately marked passed, failed or unrun.
- Verified graph name/hash/counts and persistence result, without credentials.
- Report, telemetry and evidence replay paths from real runs if available.
- Known failures, tradeoffs and remaining manual steps.
- Coding-agent usage/cost only if observable; otherwise unknown. Do not infer it from app provider usage.

## Scorecard

Score each category from 0 to 5 against observed evidence; weighted points = weight × score / 5. Do not calculate a final score while required categories are untested.

| Category | Weight | Evidence |
|---|---:|---|
| Local setup and ontology | 15 | Container health, correct import, count/hash/query checks, persistence and idempotence. |
| Working managed-provider flow | 20 | Real upload/readiness/discovery/inspection, bounded retries and recoverable failures. |
| Evidence and assessment fidelity | 20 | Correct context handling, useful findings, visual grounding, no fabricated measurements or unsupported grades. |
| Report and UX | 15 | Current branding, complete sections, working evidence seeking and separate exports. |
| Telemetry correctness | 10 | Truthful wall/self timing, uploads/polls/calls/retries/cache, missing costs preserved. |
| Maintainability and repeatability | 10 | Clear adapters/contracts, reproducible setup, useful tests and documentation. |
| Completion time and human effort | 5 | Time to verified working build, user minutes and intervention count. |
| Coding-agent usage/cost | 5 | Observable usage under comparable access; unknown stays unknown. |

Keep absolute pass/fail issues visible alongside any score: leaked credentials, fake successful provider output, incorrect graph import, unsupported numeric grades and broken evidence replay are not erased by attractive UI scores. If live access is unavailable for either build, report a provisional offline result and leave live categories untested.

There are two separate cost ledgers:
- Development: coding-agent subscription/API usage, elapsed build time and user effort.
- Operation: TwelveLabs/Gemini calls, local processing time and cost per video.

A quicker agent may produce a slower app, and a larger coding bill may produce a better implementation. Record both before choosing.
