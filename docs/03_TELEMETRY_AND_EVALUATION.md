# Telemetry and evaluation

## Trace design

Every job has run_id, trace_id, case_id and mode/backend labels. Each span has span_id, parent_span_id, name, start/end UTC timestamps, monotonic start/end offsets, duration_ms, status and bounded redacted attributes. Use the reference examples/telemetry.mjs or an equivalent OpenTelemetry-compatible implementation. Local JSONL + SQLite + CSV is enough; no paid collector is required.

Emit span-start events immediately and span-end events on success/error/cancellation. Recover unclosed spans as interrupted after a crash. Keep failed runs queryable even when no report exists. The reference helper demonstrates timing/redaction/aggregation, but The coding agent must add start-event/crash recovery to the application trace store.

## Required spans

| Group | Detailed spans |
|---|---|
| Local preparation | queue_wait, source_snapshot, hashing, ffprobe, decode_check, resize_transcode, playback_transcode |
| Provider ingestion | twelvelabs.upload, twelvelabs.asset_ready_wait, individual readiness HTTP attempts |
| Discover | pegasus.discovery, response_receive, parse_and_validate |
| Compare | ontology.catalogue, recognition_profiles, candidate_compare, optional reference_search |
| Code Mode | planner_request per turn, code_validation, execution_segment, tool_call, denied_tool_call |
| Inspect | protocol_query, capability_compile, frame_extract per packet, optional gemini.file_upload/ready_wait, gemini.inspect, followup per request |
| Assess | finding_validate, rubric_eligibility, scoring, drill_filter, claim_check |
| Report | template_assemble, JSON/HTML/CSV writes, optional PDF export, final_persist |
| Recovery | retry_backoff, timeout, cache_lookup/hit, resume, cleanup |

Collect source/prepared bytes and duration, frame packet counts/dimensions/bytes, protocol IDs, actual model ID, request ID, prompt/schema hashes, reported token categories, finish reason, HTTP status, attempts and failure reasons.

## Timing correctness

- Root run wall time is elapsed monotonic time. Inclusive duration is a span's elapsed time. Self/exclusive duration subtracts the union of direct child intervals, not a sum that double-counts overlap.
- Never sum all spans to report total time. For parallel calls, show overlaps and a critical-path view or stage union duration.
- Upload time, readiness waiting, local polling/backoff and inference request round-trip must be separate. Client-observed readiness is not exact provider processing time. Provider queue/compute is unknown unless explicitly returned.
- In streaming mode record actual time to first byte/text if observable; leave null otherwise. Clock skew does not affect local monotonic durations.
- Instrument the UI's time-to-first-report and replay readiness separately from server completion. Do not label a headless CLI time as user-perceived UI latency.

## Cost correctness

Use provider-reported usage when available and a versioned account-specific pricing table for estimates. Different token categories must not be double-counted. Report estimated, reported, partial or unknown explicitly. Missing rates/usage are null, not zero; an internal known subtotal is not a complete run cost. Do not assume API output contains currency cost.

Log every planner, inspection, repair and retry request. Reused upload assets may still incur storage costs. Cache hits have no new inference cost but carry source provenance. Monetary caps require complete conservative bounds, including provider minima and retry allowances. Otherwise enforce the hard call/token/duration caps and show that currency exposure is not fully bounded.

## Optimisation dashboard

Show per-stage median and p95 across a stated number of completed runs, failure rate, accepted report coverage, additional-inspection rate and known-cost coverage. Group by clip duration/resolution, model, code mode, ontology hash and cold/warm state. Do not present p95 of three clips as stable production evidence.

Suggest optimisations from observed traces: avoid repeated uploads, reduce redundant evidence, batch compatible inspection questions, cache graph context, reuse reviewed programs or adjust concurrency. Every performance change must be evaluated against recognition/evidence quality. Parallelism can improve latency while increasing total cost.

## First evaluation set

Use the supplied case manifest as a template. Replace filenames with actual local videos. Hold expected labels and coach judgements outside model prompts and provider filenames. Run genuine no-context tests first, then separately test declared context.

Include: track cycling; junior indoor softball pace bowling; low-resolution batting; cricket/netball confusion; unfamiliar/out-of-ontology activity; multiple athletes; multiple attempts; irrelevant/no-action footage. Do not copy competitor grades as correct labels.

Measure activity accuracy on accepted cases together with accepted coverage and false-confident labels; evidence support; inappropriate/unsupported recommendations; useful-review coverage; repeated-run stability; duration and cost. Compare ontology_fixed vs ontology_code using matched media/ontology/inspection settings. Repeat selected clips; cache replay and fresh perception are different experiments.

## Acceptance tests

1. Corrupt/unsupported file returns a clear outcome and full timing trace.
2. 352-pixel-width input can be normalised for provider compatibility without claiming improved detail.
3. HEVC source gets browser-compatible playback when necessary; seeking remains correct.
4. Readiness failed/timeout terminates; polls, waiting and retries appear separately.
5. A conflicting sport label is reinspected within budget or remains uncertain; no irrelevant sport drills.
6. Missing view produces not_assessable, not a zero skill score.
7. An 11-year-old context excludes drills with minimum age 12; unknown age never passes that restriction.
8. No pose detector means no numeric pose metric, regardless of ontology definition.
9. No reviewed rubric means score null and no fake radar.
10. Parallel child spans are not added twice; root elapsed time is truthful.
11. Unknown provider price remains null; retry usage is included.
12. Secrets and internal raw output are absent from athlete export.
13. Evidence click actually seeks the matching source moment.
14. Graph import is idempotent, preserves UIDs and does not delete a production graph.
15. Generated code cannot read files/env, run processes, call unknown tools, escape media scope or exceed host limits.
16. A model error still produces an internal diagnostic page; no fabricated successful report.
