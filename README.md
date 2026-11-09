# StriideAi local analysis lab — Cursor and Claude Code build pack

Version 0.2 · 9 November 2026 · matched coding-agent handovers

Use Cursor or Claude Code to build a local Windows-friendly research application from this pack. This is an implementation specification with configuration, contracts, prompts, data and brand assets; the full analysis application is to be built by your chosen coding agent. The telemetry reference module and its tests are executable now.

## Your minimum inputs

1. TwelveLabs API key with access to Pegasus 1.6 and file uploads.
2. Gemini API key, enabled billing/quota as required, and exact model IDs available to your project. Use one supported multimodal model initially for both planner and inspector; record the roles separately.
3. A folder containing the actual test videos. Cloud share-page URLs and Windows file paths are not substitutes for provider-uploaded media.
4. Docker Desktop running Linux containers, plus the supplied Compose setup for local FalkorDB. Set its local password in .env, then import and verify the bundled ontology. The pipeline requires this verified graph; JSON mode is for isolated diagnostics only.
5. Current Node LTS, FFmpeg and ffprobe on PATH. The proposed local Code Mode executor uses the standalone Deno runtime with restricted permissions; Docker is required for the local FalkorDB service in this experiment.

The full supplied ontology and current StriideAi wordmarks, fonts and brand rules are included. No AWS credentials, S3 bucket, public tunnel or GPU is required. Video/selected frames still leave the PC when submitted to the two managed providers.


## Choose the coding agent

Both agents receive the same BUILD_TASK.md, architecture, contracts, ontology, provider settings, branding and acceptance checks.

- Cursor: open a fresh copy of this folder and paste CURSOR_START.md.
- Claude Code: open a second fresh copy, run claude in its root, and paste CLAUDE_CODE_START.md. CLAUDE.md supplies its project instructions; see CLAUDE_CODE_QUICKSTART.md.

For a fair comparison, read docs/07_CODING_AGENT_COMPARISON.md and keep Docker projects/ports, outputs and code changes separate. The coding-agent choice does not change the video-analysis models. No Anthropic API key is required by the application's configuration.

Shared read order: BUILD_TASK.md → AGENTS.md → docs/00_LOCAL_FALKORDB_SETUP.md → docs/01_LOCAL_BUILD_SPEC.md → docs/02_REPORT_AND_UI_SPEC.md → docs/03_TELEMETRY_AND_EVALUATION.md → docs/04_ONTOLOGY_AND_CODE_MODE.md → docs/05_PROVIDER_ADAPTERS.md → docs/07_CODING_AGENT_COMPARISON.md.

## Configure the local app

Copy .env.example to .env and config.example.yaml to config.local.yaml. Enter the keys, Gemini model IDs, video directory, output directory and FalkorDB connection details. Environment secrets stay separate from shareable YAML. Windows paths in YAML should use forward slashes, e.g. C:/StriideAiLab/videos.

The default experiment uses the real FalkorDB adapter and Code Mode. Keep reference search and experimental grades off initially. Review approved-content.example.json before enabling scoring or prescribing draft drills. No supplied ontology status is treated as proof of expert approval.

The supplied bootstrap helper starts and verifies the container. Ask your coding agent to implement the npm application/import commands:

```powershell
node bootstrap/falkordb.mjs up
npm run ontology:import -- --config config.local.yaml
node bootstrap/falkordb.mjs verify
npm run doctor -- --config config.local.yaml
npm run analyse -- --config config.local.yaml --video "C:/StriideAiLab/videos/clip.mp4"
npm run ui -- --config config.local.yaml
npm run batch -- --config config.local.yaml --manifest evaluation/cases.example.json
```

The doctor command performs local checks without billable analysis. A separately requested provider smoke test can verify upload and model access, with its calls and cost recorded.

## What every run produces

- Athlete/coach report: branded summary, context, video replay, strengths, priorities, phases, evidence, supported rubric results, suitable recommendations and capture guidance.
- Internal telemetry: waterfall, step table, provider/upload/poll timing, planner calls, inspection packets, ontology queries, actual usage, cost availability and validation failures.
- Machine-readable report.json, trace.jsonl, metrics.csv, manifest.json, redacted request/response artifacts and evidence files in a new run directory.
- Local reports served on 127.0.0.1; video seeking uses real media routes, not file:// URLs. Athlete exports exclude internal telemetry and raw artifacts.

If the video does not support a requested measurement or the rubric is not approved, retain the section and explain its status. Never populate decorative grades, radar charts, repeated-action claims or five-pillar assessments with invented values.

## Optional inputs that improve fidelity

- One existing Striide report JSON and an HTML/PDF export or screenshot to reproduce exact schema 2.1 fields and layout. Without these the lab uses its documented local schema, not a claimed drop-in production format.
- Existing worker prompts, current grading bands and coach-approved drill/content IDs.
- Known context for selected tests: age, sport/format, target athlete and goal. Leave these blank for genuine no-context discovery tests.
- Account-specific prices/allowances in pricing.local.json if you want monetary estimates. Unknown cost stays unknown, not £0 or $0.

## Included executable checks

```powershell
node --test examples/telemetry.test.mjs
node examples/telemetry-demo.mjs
```

The demo only exercises telemetry using local sample tasks. It does not analyse video or call either provider. examples/report-preview.html is a labelled layout fixture, not an analysis result.

## First evaluation

Use the same source videos and compare ontology_fixed with ontology_code under matched settings. Keep no-context labels separate from model inputs. Reuse uploads where valid, but distinguish cold runs, warm asset reuse and full result-cache hits. Review accuracy and evidence with a coach alongside latency/cost; faster unsupported reports are not an improvement.
