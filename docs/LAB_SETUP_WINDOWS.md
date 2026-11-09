# Windows setup and run guide (Claude Code build folder)

These are the exact steps for native Windows PowerShell. Commands were verified in a Linux build container (see BUILD_REPORT.md); the Windows-specific steps have not been executed on a Windows machine yet.

## 1. Prerequisites

```powershell
winget install OpenJS.NodeJS.LTS        # Node 22.13 or newer (node:sqlite and process.loadEnvFile are required)
winget install Gyan.FFmpeg              # ffmpeg + ffprobe on PATH, with libx264
winget install Docker.DockerDesktop     # Linux containers / WSL 2 backend; start Docker Desktop
node --version; ffmpeg -version; docker version
```

Deno does not need a separate install: `npm ci` installs the pinned Deno 2.9.6 binary for your platform (`node_modules/@deno/win32-x64/deno.exe`). Set `DENO_BIN` only to use a different executable.

## 2. Install and configure

```powershell
cd C:\StriideAiLab\claude-build
npm ci
Copy-Item .env.example .env
Copy-Item config.example.yaml config.local.yaml
notepad .env
notepad config.local.yaml
```

In `.env` (never paste values into chat):

- `TWELVE_LABS_API_KEY`, `GEMINI_API_KEY`
- `GEMINI_PLANNER_MODEL`, `GEMINI_INSPECTOR_MODEL` — exact model IDs available to your Gemini project (the same model for both is fine initially)
- `FALKORDB_PASSWORD` — 16–128 letters, digits, `_` or `-`
- For the Claude comparison folder (docs/07): `COMPOSE_PROJECT_NAME=striideai-claude-lab`, `FALKORDB_PORT=6380`, `FALKORDB_BROWSER_PORT=3001`

In `config.local.yaml`:

- `server.port: 8788`
- `paths.input_root: C:/StriideAiLab/videos` (forward slashes)
- keep `ontology.backend: falkordb`, `assessment.experimental_scoring: false`

## 3. Database, import and verification

```powershell
node bootstrap/falkordb.mjs up
npm run ontology:import -- --config config.local.yaml
node bootstrap/falkordb.mjs verify
npm run doctor -- --config config.local.yaml
```

Persistence check (does not delete the named volume):

```powershell
node bootstrap/falkordb.mjs stop
node bootstrap/falkordb.mjs up
node bootstrap/falkordb.mjs verify
```

Before comparable runs, set `FALKORDB_IMAGE` in `.env` to the digest printed by `npm run doctor` (`falkordb.image` row).

## 4. Offline checks (no provider calls)

```powershell
npm run build
npm test
npm run test:reference
node examples/telemetry-demo.mjs
```

The browser seek test in `npm test` needs Playwright with Chromium (`npm i -g playwright` then `npx playwright install chromium`); without it that single test reports itself skipped.

## 5. Live provider smoke test (billable, explicit)

```powershell
npm run provider:smoke -- --config config.local.yaml --yes
```

Uploads a synthetic 5-second test pattern, waits for readiness, makes one Pegasus 1.6 request and one Gemini request per configured role, deletes the asset and verifies deletion. Results: `runs/_smoke/<timestamp>/smoke.json`.

## 6. Analysis and UI

```powershell
npm run analyse -- --config config.local.yaml --video "C:/StriideAiLab/videos/clip.mp4"
npm run analyse -- --config config.local.yaml --video "C:/StriideAiLab/videos/clip.mp4" --mode ontology_fixed
npm run analyse -- --config config.local.yaml --video "C:/StriideAiLab/videos/clip.mp4" --context context.local.json
npm run ui -- --config config.local.yaml
```

Open `http://127.0.0.1:8788/`. Each run has `/runs/<run_id>/report` (athlete/coach view with playback), `/runs/<run_id>/console` (internal console) and `/dashboard` (optimisation dashboard). Interrupted runs can be resumed with `--resume <run_id>`; a re-run of the same clip creates a new run record and may be a labelled result-cache hit (`--no-result-cache` for fresh perception).

## 7. Batch evaluation and cleanup

```powershell
npm run batch -- --config config.local.yaml --manifest evaluation/cases.example.json --modes ontology_fixed,ontology_code
npm run cleanup -- --config config.local.yaml --local-cache
npm run cleanup -- --config config.local.yaml --provider-assets --dry-run
npm run cleanup -- --config config.local.yaml --provider-assets --yes
```

Copy `evaluation/cases.example.json` and replace the video names with files under `input_root`. Expected labels are never sent to providers.
