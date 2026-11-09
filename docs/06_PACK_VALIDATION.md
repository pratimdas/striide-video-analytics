# Validation of this handover pack

The full local analysis application is specified for the coding agent to build. It is not implemented by this pack.

Checked before delivery:

- Seven executable telemetry-reference tests passed: overlapping intervals, exclusive timing, failed operations, parent/child relationships, secret redaction and missing/partial cost handling.
- Local telemetry demo ran with zero provider requests and explicitly labelled demo output.
- All JSON files parsed; canonical JSON schemas passed Draft 2020-12 schema validation.
- Example report and generated demo spans validated against the respective contracts.
- YAML configuration parsed; real FalkorDB and Code Mode are selected, experimental scores are disabled.
- Bundled ontology digest matches the unmodified supplied file: 7,172 nodes and 19,803 edges.
- Markdown fences, local HTML asset references, font files and font licences were checked.

Not run: live provider calls, graph import against a running instance, the proposed Deno executor or the complete local app. The report HTML is a layout fixture; browser visual QA was unavailable in this build environment. The coding agent must perform the application and UI checks described in the specifications.

Revision 0.1.1: Compose/bootstrap setup and the importer/verification contract were added. The Node helper passed syntax and help-command checks; Compose YAML and its persistence/authentication settings were inspected. Container startup and live graph verification remain unrun here.

Revision 0.2 adds matched Cursor/Claude Code launchers, a root CLAUDE.md importing shared rules, one canonical BUILD_TASK.md, independent Compose project naming and a blank comparison scorecard. Neither coding agent has been benchmarked here.
