# Build progress record (Claude Code build)

Brief, append-only notes of milestones and verified checks. Final summary: BUILD_REPORT.md.

- 2026-11-09 — Spec snapshot committed unmodified (pack v0.2). Docker daemon started inside the build container; `falkordb/falkordb:latest` pulled (digest sha256:bef8acb1d8ed…a4d7f).
- M1 — config schema (unknown-key rejection), trace store (span_start/span_end + crash recovery) over reference telemetry, SQLite store (node:sqlite), media preparation. `test/media.test.ts`: 6/6 pass (VFR + 5 s start offset exact-frame mapping, 352 px upscale note, HEVC→H.264 playback, rotation, corrupt and truncated rejection).
- M2 — `npm run ontology:import`: created `striide_lab_145700e7ac5e3307`, 7172/7172 nodes and 19803/19803 relationships match the source by full round-trip fingerprint, 23 uid indexes, 6 lookups OK. Supplied `node bootstrap/falkordb.mjs verify`: verified=true, cricket_protocol_count=5. Re-import: action=reused (no duplication). Stop/up/verify: counts persisted.
