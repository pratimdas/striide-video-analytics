# Build progress record (Claude Code build)

Brief, append-only notes of milestones and verified checks. Final summary: BUILD_REPORT.md.

- 2026-11-09 — Spec snapshot committed unmodified (pack v0.2). Docker daemon started inside the build container; `falkordb/falkordb:latest` pulled (digest sha256:bef8acb1d8ed…a4d7f).
- M1 — config schema (unknown-key rejection), trace store (span_start/span_end + crash recovery) over reference telemetry, SQLite store (node:sqlite), media preparation. `test/media.test.ts`: 6/6 pass (VFR + 5 s start offset exact-frame mapping, 352 px upscale note, HEVC→H.264 playback, rotation, corrupt and truncated rejection).
- M2 — `npm run ontology:import`: created `striide_lab_145700e7ac5e3307`, 7172/7172 nodes and 19803/19803 relationships match the source by full round-trip fingerprint, 23 uid indexes, 6 lookups OK. Supplied `node bootstrap/falkordb.mjs verify`: verified=true, cricket_protocol_count=5. Re-import: action=reused (no duplication). Stop/up/verify: counts persisted.
- M3/M4 — provider adapters (official SDKs; fields from SDK types), ToolHost, reviewed program, restricted Deno executor with replay journal. `test/sandbox.test.ts` 10/10.
- M5 — assessment, report inventory, athlete DTO/HTML/CSV, 9-tab console, loopback server. `test/pipeline.test.ts` 18/18 (mock providers + live graph), `test/ui.test.ts` 5/5 (Playwright: evidence click verified by decoded pixel luma on a VFR clip with 5 s start offset). Fixed: x264 B-frame start offset (now `-bf 0`), encoder time base quantising VFR (`-enc_time_base demux`), 375 px form overflow.
- M6 — doctor, provider:smoke, batch, cleanup, dashboard, docs. Full `npm test`: 53/53. Live provider checks unrun (no credentials). See BUILD_REPORT.md.
