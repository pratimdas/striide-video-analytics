# StriideAi local analysis lab — Claude Code

@AGENTS.md

Read BUILD_TASK.md and docs/00_LOCAL_FALKORDB_SETUP.md first, then every numbered specification. Implement the task through the shared acceptance checks; do not stop after planning or create a substitute mock-only pipeline.

This is a local Windows-friendly research application. Reuse the supplied Docker Compose/bootstrap files, real FalkorDB ontology, provider contracts, prompts, telemetry reference and current brand assets. The original ontology is immutable. Use its manifest/shape sample before targeted programmatic inspection; never load the whole ontology into the language-model prompt.

The coding-agent choice does not change the application stack: TwelveLabs Pegasus, Gemini, FalkorDB and bounded Code Mode remain as specified. Claude is the builder, not an additional inference provider. Do not add Anthropic credentials to the application's configuration.

Keep secrets in local ignored configuration. Read key names/templates as needed; let application commands use secret values without printing them. Keep this project's changes within its own directory and Docker Compose project. Do not change the competing build or machine-wide coding-agent settings.

Maintain a brief progress record. Run offline/mock checks before live provider checks. If credentials or Docker are unavailable, finish all independent implementation work and report the exact remaining checks; never fabricate success.

Use the shared acceptance criteria and finish with BUILD_REPORT.md. Record your actual model/tool version and human interventions when available. Do not claim to have beaten another agent without inspecting comparable results.
