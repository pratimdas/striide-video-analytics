# Report and UI requirements

Two views per run: a coach/athlete report and a clearly separate internal console. Use the exact current StriideAi brand rules and assets in brand. Do not use the older magenta Striide stylesheet.

## Coach/athlete report inventory

| Section | Required behaviour |
|---|---|
| Header | StriideAi wordmark with secondary by Striide, report/run ID, date and assessment status. No inferred athlete name. |
| Video and context | Working playback, duration and view; supplied age/format/goal distinguished from visually established activity. |
| Summary | Concise supported account of what happened, principal strength and priority where assessable. |
| Overall grade/score | Preserve the slot; display only when an approved rubric and required evidence support it. Otherwise explain why unavailable. |
| Criterion breakdown | Rubric-defined dimensions, eligible values and coverage; no invented default sport metrics. |
| Radar | Render only when sufficient comparable approved scored axes exist; never replace null with zero or draw a normalised invented polygon. |
| Strengths | Each linked to a finding ID and evidence interval. |
| Priorities | Ranked supported improvements with reasoning and observability. No blanket causal diagnosis. |
| Action timeline | Attempts, approximate events and sport-appropriate phases; clear source-time mapping and approximate labels. |
| Detailed findings | Observation, interpretation, evidence, visibility, uncertainty and supported cue/content where approved. |
| Technique | Relevant protocol questions and findings; not generic prose. |
| Tactics and outcomes | Include only when the situation/ball/target/result is sufficiently visible; otherwise explicitly not assessable. |
| Strength, mental resilience and nutrition | Preserve a support-status row if included in the cross-product view; never infer strength deficits, mental state or nutrition needs from a short clip. Link approved resources only where appropriate, not as diagnosed faults. |
| Drills and content | Approved IDs, purpose, instructions and dosage only where reviewed and applicable; support Striide and CoachHQ links if configured. Unapproved suggestions stay in the internal draft area. |
| Next-session plan | Assemble from eligible approved items; no invented workload prescription. If none, state review needed and retain supported capture advice. |
| Limitations | Missing views, low detail, unavailable measurements, insufficient repetitions, unresolved identity/activity and omitted scores. |
| Better recording guidance | Protocol-derived, relevant camera/view/number-of-attempts advice. |
| Review and feedback | Coach can correct one finding or event interval and save against the exact report version. |

Do not force all five pillars into a positive/negative rating. Meaningful absence is part of the report. Preserve supported sections when others are unavailable. The prototype must not become a report that always abstains: make available observations and their coverage useful and assess with a coach.

## Internal console tabs

1. Overview: wall time, outcome, known cost subtotal, unknown cost components, calls/attempts, input/output sizes, coverage and effective mode/backend.
2. Timeline: Gantt/waterfall grouped by stage, provider and parent span. Parallel work overlaps; span totals are not wall time.
3. Discovery/compare: candidate IDs, supporting/contradicting evidence, ontology profiles and reason for each additional inspection. No hidden chain-of-thought.
4. Inspection: question-by-question answer, source frames/intervals, visibility, unsupported capability exclusions and model disagreement.
5. Ontology: graph hash, releases, exact retrieved IDs/subgraph, approval state and query timings.
6. Requests: redacted prompts, schemas, provider request IDs, raw text/JSON, usage, finish reason, retries and artifact links. Never keys or full credential-bearing URLs.
7. Code Mode: generated/reused program, version, executed tool calls, denied calls, planner turn counts and budgets.
8. Validation: missing references, rejected claims, score exclusions, template fallback and report assembly issues.
9. Compare runs: same clip across configurations, cold/warm/cache markers, quality review and delta timing/cost; incompatible scores are not charted as athletic progress.

## Interaction and export

- Serve video with browser range-request support, correct MIME type and path restrictions. Clicking an evidence timestamp must seek the correct video to that moment; include play/pause and short interval playback.
- The prototype can expose internal mode locally; an athlete HTML/PDF/JSON export must be generated from a separate allowlisted DTO. Hiding a telemetry tab with CSS is insufficient.
- Provide print/PDF styling; keep a working local HTML report for interactive playback. PDF includes evidence thumbnails and timestamps, not a promise of embedded playable video.
- Provide JSON and CSV export; CSV cells beginning =, +, - or @ must be safely escaped when they originate from untrusted text.
- Use font assets locally through a root stylesheet link. Reduced motion, keyboard focus and narrow-screen layouts are required.
- Escape model text and do not render arbitrary model HTML, script or URLs. Content links must come from approved configuration.

## Compatibility

The currently known production report is described as schema 2.1, but a complete real schema/sample has not been supplied here. Build against contracts/lab-contract.schema.json, offer an adapter boundary, and do not claim exact compatibility. Import a real sample later to map all legacy fields without throwing away raw output.
