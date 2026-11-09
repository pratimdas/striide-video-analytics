# Required local FalkorDB setup, import and verification

Revision 0.1.1: local container setup is now explicit. This replaces the earlier optional managed/local choice for this experiment. The remainder of the app and its importer are still to be built by the coding agent.

## Prerequisites and configuration

Install Docker Desktop and enable its Linux-container backend (WSL 2 on Windows where required). Start Docker Desktop. Use a current Node LTS release.

Copy .env.example to .env. Set FALKORDB_PASSWORD to a local password of 16–128 letters, digits, underscores or hyphens; this avoids ambiguity in the image's whitespace-split REDIS_ARGS. Do not paste the password into chat. Keep host 127.0.0.1, port 6379 and TLS false for the default local container. An empty username uses the default Redis user. Change the host port if 6379 is occupied.

The Compose file includes the database and browser image, loopback-bound ports, authenticated health checking and a named volume at /var/lib/falkordb/data, the documented current data directory. The image defaults to latest for initial local setup. Before comparable performance runs, record its image ID/digest and set FALKORDB_IMAGE to that pinned digest. It has not been live-tested in this environment.

## Exact order

```powershell
# This helper is supplied and can start the container before Cursor builds the app.
node bootstrap/falkordb.mjs up

# The coding agent must implement these npm commands as part of the local application.
npm run ontology:import -- --config config.local.yaml
node bootstrap/falkordb.mjs verify
npm run doctor -- --config config.local.yaml
npm run analyse -- --config config.local.yaml --video "C:/StriideAiLab/videos/clip.mp4"
```

Copy config.example.yaml to config.local.yaml before import. An initial doctor --setup mode may check an empty database; the normal doctor and analyse commands require a verified ready import.

## Importer contract for the coding agent

Implement npm run ontology:import as a real command, not a placeholder. It must:

1. Connect to the running local container using the same .env/config as the application.
2. Verify the bundled source SHA-256 and read its structured node/edge format.
3. Load all 7,172 nodes and 19,803 relationships with original UIDs, labels, types and properties. Preserve complex values with explicit reversible serialization. Do not ask an LLM to regenerate the ontology.
4. Create a separate content-addressed lab graph whose name starts striide_lab_. Use a staging/ready process: a partial import must never become the active graph. Do not drop unrelated graphs. Reimporting the same validated source must not duplicate nodes or edges, including parallel relationships.
5. Add appropriate UID indexes without changing original node/edge counts. Persist the import and verify required lookups.
6. Write data/ontology-import.local.json only after validation. Required fields: ready=true, graph_name, source_sha256, node_count, edge_count, imported_at and image_digest (null only if unavailable and explicitly reported). Record timings/failures separately in internal telemetry.
7. Keep any import metadata outside the original graph's node/edge counts, e.g. in the host manifest/application storage. Do not add bookkeeping nodes that make verification fail.
8. Verify persistence by stopping and starting the service during acceptance testing and rechecking counts/lookups. Do not delete the named volume during this test.

The runtime must read the ready graph name from this manifest and verify the source/version before analysis. Never assume the source JSON's graph name is the active local graph. Recognition, candidate comparison and protocol inspection must query the same verified graph through typed read-only tools. Any derived-context cache records its graph/source hash. No silent fallback to JSON when the required database/import is missing.

## Verification and operations

The supplied verify helper reads the import manifest, checks the source hash, queries node/edge counts and performs cricket sport/protocol lookups. A healthy PING alone does not prove the ontology is loaded. The coding agent must also test retrieval of actual visual questions, camera constraints and drill candidates and report missing coverage.

```powershell
node bootstrap/falkordb.mjs status
node bootstrap/falkordb.mjs stop
node bootstrap/falkordb.mjs up
node bootstrap/falkordb.mjs verify
```

Do not run docker compose config in a screen share or copy its output to logs: resolved environment values can contain the local password. The setup helper does not invoke it.

Official reference: https://docs.falkordb.com/operations/docker
