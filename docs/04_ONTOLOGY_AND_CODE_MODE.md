# Ontology and Code Mode

## Ontology import and query

The supplied combined file is already a graph: nodes use uid, label and props; edges use type, from, to and props. Do not ask an LLM to re-extract a graph. Read data/ontology-manifest.json first and stream/process the source rather than loading it into model context.

Import into a content-addressed lab graph, e.g. striide_lab_<file_sha256_prefix>. Preserve full UIDs, edge types, source/release properties, docJson strings and original source bytes. Allowlist label/type identifiers from the validated source; parameterise values. Serialise nested structures explicitly where graph property types require it. Validate node counts, endpoint existence and content hashes; record discrepancies rather than silently repairing. Reimporting the same digest is a no-op or validated upsert, never destructive reset.

Use typed read-only methods: getCatalogue, getRecognitionProfiles, getCandidateProtocols, getInspectionQuestions, getDrillCandidates and getContentApprovals. Queries are fixed and bounded; generated code cannot issue arbitrary Cypher or write to the graph. User-supplied IDs must be validated against the imported graph. The JSON adapter must return equivalent snapshots for offline tests, with a conspicuous backend=json_snapshot label.

The supplied ontology has useful activity types, phases, questions, camera/FPS conditions, drills and safety constraints. Some numeric metrics require pose or 3D capabilities that this lab does not have. The capability compiler must exclude those, preserve the reason and use supported qualitative questions only. A minFps requirement on a particular measurement is not an automatic reason to reject all other observations.

Keep recognition profiles as a versioned supplemental overlay until reviewed. The provided draft illustrates contrasting criteria for cricket bowling and netball; it is not labelled validated. Never let venue/equipment alone force a sport label.

Approval registry is independent of ontology tier/status: generated, curated and frozen do not prove that reviewedBy is populated or that bands are calibrated. Default approved-content.example.json is empty. Draft findings/questions can be explored internally. Publish numerical grades/prescriptive drills only after explicit approval and evidence eligibility.

## Local Code Mode executor

Use the Code Mode pattern, not a mandatory Cloudflare deployment. The proposed local executor is a separate Deno process communicating with a job-scoped host broker. Generated JavaScript calls typed tools; the host performs all provider, graph and media work.

Implementation requirements:
- Start from a trusted bootstrap with no external dependencies; supply generated program text through a controlled channel, not a shell command string.
- Use Deno no-prompt and deny filesystem, environment, subprocess, FFI and system-information permissions. Permit network only to the exact ephemeral 127.0.0.1 broker port if HTTP RPC is used; do not grant broad network access.
- Spawn with a minimal environment. In particular do not inherit provider keys, NODE_OPTIONS, DENO_PERMISSION_BROKER_PATH or permissive Deno configuration.
- No dynamic imports or package downloads in generated programs; validate/reject import syntax and test the runtime restrictions. Configure pinned/cached dependencies for the trusted bootstrap only.
- The broker binds loopback on an ephemeral port, requires a per-run capability and validates schema, job scope, allowed tool, call count and budget on every request. Never expose a generic fetch, shell, filesystem or arbitrary-query tool.
- Long provider operations should use job task IDs: a short execution segment submits/polls host work, checkpoints, then returns. Do not kill an otherwise valid 180-second model request merely because the local code segment has a 10-second limit.
- A watchdog terminates runaway code and caps output size. Deno permissions are a prototype containment layer, not a claim of production-grade adversarial isolation. A deployment executor can later use stronger isolated infrastructure behind the same interface.
- If the restricted executor or its negative tests fail, disable generated execution with a clear error. Do not silently use host eval or call ordinary fixed orchestration Code Mode.

## Typed tool catalogue

Expose only job-scoped methods with validated arguments/results:

media.describe, ontology.getCatalogue, ontology.getRecognitionProfiles, ontology.getProtocol, video.discover, media.extractEvidence, vision.inspect, assessment.validate, assessment.calculate, report.assemble. Optional video.searchReferences remains disabled without a curated index.

The host controls arithmetic, eligibility, content approval, cost and result publication. Program output is a proposal, never authority to change those controls. Store generated code, executed tool spans and structured evidence summaries; do not request hidden reasoning traces.
