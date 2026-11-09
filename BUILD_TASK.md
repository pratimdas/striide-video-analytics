Build the StriideAi local analysis lab described by this folder. This is a new local research app; preserve the supplied ontology and assets.

Read AGENTS.md and every numbered document in docs before choosing implementation details. Follow docs/00_LOCAL_FALKORDB_SETUP.md first: use the supplied Compose/bootstrap files, implement a real ontology importer and verify the imported graph before any video analysis. Read the ready graph name from data/ontology-import.local.json; never silently substitute JSON or an empty graph. Use the cloud architecture only as the logical reference; replace S3 with local files plus direct provider uploads, distributed jobs with a single local job runner, and application storage with SQLite/run folders.

Use Node LTS + TypeScript for the host, SQLite for run metadata, a small React/Vite UI if appropriate, FFmpeg/ffprobe via safe subprocess arguments, FalkorDB for the real ontology adapter, and the documented restricted Deno executor for Code Mode. Pin dependencies with a lockfile. Reuse official provider SDKs or documented HTTP requests; do not invent endpoint fields or silently downgrade models.

First produce a brief file/module map and implement immediately. Do not stop at the plan. Work in milestones:
1. Config validation, doctor, local media preparation, contracts and telemetry reference integration.
2. Idempotent ontology import, read-only query tools, capability filtering and draft recognition-profile overlay.
3. Real TwelveLabs direct upload/readiness/discovery and Gemini visual-inspection adapters, with mocks for tests.
4. Bounded Code Mode planning/execution and follow-up loop, using the same host tools as fixed mode. Prove its restrictions before enabling generated code; fail closed rather than executing in the host.
5. Branded report, working video/evidence seeking, internal telemetry dashboard and JSON/CSV exports.
6. Batch evaluation, feedback capture, documentation and live smoke-test command.

Implement the complete report inventory in docs/02. Missing or unsupported sections must show an explicit state, not disappear or be filled with invented content. Keep numerical grading disabled until a reviewed rubric is configured. Preserve raw diagnostic artifacts separately from athlete exports. Do not reproduce competitor recommendations or unsafe cues as coaching instructions.

Use the current brand assets/rules in brand, not older navy/magenta Striide materials. Do not require AWS, a public upload server, GPU, model fine-tuning, paid observability or a production auth system for this lab.

Implement meaningful tests for provider lifecycle failures, graph import/query correctness, evidence mapping, sandbox permissions, cap enforcement, unsupported grades, video seek, export separation and trace accounting. Run offline/mock checks first. If credentials are absent, finish the build and clearly document unrun live checks. Do not fabricate successful API calls or report content.

Finish with exact Windows setup/run instructions, the verified commands, any outstanding access issues and actual validation results.

Use docs/07_CODING_AGENT_COMPARISON.md for the shared completion record. Write BUILD_REPORT.md with implemented features, exact commands, genuine test outcomes, unrun checks and remaining issues. Do not alter supplied requirements or tests to make a failing implementation appear complete.
