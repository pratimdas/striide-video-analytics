# StriideAi — Managed Video Analysis Sequence Architecture
Version 0.1 — proposed design for review
Date: 8 November 2026

This design extends the existing hybrid worker: TwelveLabs Pegasus understands the video and Gemini helps produce the coaching assessment. It adds bounded Code Mode orchestration, protocol retrieval from FalkorDB, actual visual evidence for Gemini, and application-enforced assessment rules.

It is a proposed target flow, not a claim that every step exists in the current implementation. Endpoint names, statuses and contracts below are illustrative. The existing queue, database and worker implementation should be reused; this document does not prescribe a new queue product or database.

## Architecture decisions

- Private S3 holds the original video and derived evidence.
- The client uploads directly using a presigned PUT URL issued by the Striide API. A separate server-issued presigned GET URL lets TwelveLabs fetch the verified analysis input.
- The API creates and owns the job. The client never chooses arbitrary bucket keys, providers or provider credentials.
- A durable job mechanism dispatches work. The existing worker owns the lifecycle, checkpoints, retries, cost accounting and final result.
- Code Mode is an isolated orchestration capability associated with that worker. It is not an additional sport-analysis model. Its generated programs call typed, host-controlled tools.
- Gemini can serve as a Code Mode planner and as a visual inspector. These are distinct model requests and are logged and budgeted separately.
- Validated reusable execution programs can avoid generating a new program for every straightforward clip. Uncached adaptive runs incur planner calls.
- FalkorDB stores the versioned sport ontology and protocols. Existing application storage holds jobs, reports, feedback and usage; a second ontology store is unnecessary.
- Pegasus discovers activities and approximate event windows. Gemini receives actual visual input for protocol inspection rather than only Pegasus's JSON.
- Application code validates evidence and eligibility and applies approved scoring rules only where the inputs and rubric support them.
- No self-hosted pose models, GPU fleet, custom model training, ADK or Step Functions migration is required by this design.

The worker and Code Mode are shown in one lane for readability. In implementation, generated code executes in an isolated runtime. API keys, IAM access, media processing and database operations stay inside host tool implementations. This does not require moving the rest of Striide's infrastructure to Cloudflare.

## Phase 1 — Upload, verify and prepare

~~~mermaid
sequenceDiagram
    autonumber
    participant App as Striide app
    participant API as Striide API
    participant S3 as Private S3
    participant Jobs as Existing job queue
    participant W as Existing worker

    App->>API: Create analysis with file metadata and optional context
    API->>API: Authenticate, authorise and create upload session
    API-->>App: Job ID, presigned PUT URL and required headers
    App->>S3: PUT video bytes to assigned upload key
    S3-->>App: Upload acknowledgement
    App->>API: Confirm upload for job ID
    API->>S3: HEAD assigned object and verify metadata
    S3-->>API: Object metadata and version if enabled
    opt Source versioning is unavailable
        API->>S3: Copy to server-owned source snapshot
        S3-->>API: Stable snapshot reference
    end
    API->>API: Pin source snapshot and enqueue once
    API->>Jobs: Dispatch job ID and source reference
    API-->>App: Accepted with status URL
    Jobs->>W: Claim job with lease
    W->>S3: Read pinned source
    S3-->>W: Original video bytes
    W->>W: Probe, decode and validate media
    alt Unusable or invalid video
        W->>W: Record rejection and stop analysis
    else Usable video
        opt Repairable provider input mismatch
            W->>W: Create compatible analysis copy on CPU
            W->>S3: Save derivative and source mapping
        end
    end
    Note over App,W: App polls the authorised status endpoint throughout later phases
~~~

### Activities and controls

1. **Create upload session.** Accept filename, declared size and MIME type plus optional sport, goal, athlete profile reference and target-person hints. Context can be absent. Verify permission to analyse the selected athlete's footage; preserve declared age and format when supplied. Never infer identity or age from appearance.
2. **Assign the object key server-side.** Scope it to tenant, upload and job. Return a short-lived PUT URL and any signed headers. Configure S3 CORS for permitted app origins. A signed Content-Type is not proof that the bytes are a valid video.
3. **Upload directly to S3.** For large recordings, a multipart/resumable implementation may replace the single PUT while preserving the rest of this flow. S3 is private; presigned URLs grant limited access.
4. **Confirm and verify.** Look up the object key from the authenticated upload session, not an arbitrary client-supplied URL. Check object presence, size, expected headers and checksum where supported. Complete only once per upload session.
5. **Pin immutable input.** With bucket versioning, persist the verified version ID and use it in subsequent reads and provider URLs. Without versioning, make a server-owned snapshot outside the client-writable upload prefix before dispatch. Presigned upload URLs can be reused until expiry; pinning prevents a later overwrite from changing the job input.
6. **Dispatch durably.** Use an outbox or the queue/database's equivalent recovery mechanism so an accepted job cannot be lost between state persistence and enqueue. Duplicate delivery must resume the same job rather than create duplicate assessments.
7. **Prepare media in the worker.** Probe container, codec, dimensions, duration, source timestamps and rotation; attempt decoding. Compute a content digest and retain a source-time mapping. Distinguish invalid media, provider input requirements, visual usability and downstream model errors.
8. **Normalise only when needed.** Create a compatible derivative using CPU tools such as FFmpeg in the existing worker. Respect provider resolution, aspect-ratio and duration limits. Resizing can satisfy an input constraint but cannot restore detail. Preserve the original and record every transformation. If a usable partial review remains possible, continue with per-question restrictions.
9. **End invalid jobs explicitly.** Unsupported or corrupt files produce a clear rejection reason; provider outages produce a retryable or failed job, not a claim that the video is unrecognisable.

## Phase 2 — Discover and compare

~~~mermaid
sequenceDiagram
    autonumber
    participant W as Worker and Code Mode
    participant G as Gemini
    participant F as FalkorDB
    participant T as TwelveLabs
    participant S3 as Private S3

    W->>W: Load checkpoint, provider settings and execution budget
    W->>F: Fetch compact activity catalogue
    F-->>W: Sport IDs, aliases and activity types
    opt Adaptive run needs a new execution program
        W->>G: Request tool program with allowed types and limits
        G-->>W: Generated orchestration code
        W->>W: Execute in isolated runtime through host tools
    end
    W->>W: Sign GET access to pinned analysis input
    W->>T: Pegasus analyze with video URL and discovery schema
    T->>S3: GET the verified analysis video
    S3-->>T: Video bytes
    T-->>W: Candidates, actions, windows and visible evidence
    W->>W: Validate and checkpoint raw discovery output
    W->>F: Fetch recognition profiles for leading candidates
    F-->>W: Diagnostic cues, confusions and discriminating questions
    W->>W: Compare structured evidence and identify gaps
    opt Reference retrieval is enabled and useful
        W->>T: Search curated Marengo reference index
        T-->>W: Labelled reference matches and intervals
    end
    W->>W: Set provisional activity and visual checks for Phase 3
~~~

### Activities and controls

1. **Load execution configuration.** Explicitly select Pegasus 1.6 rather than relying on provider defaults. Pin the ontology release, prompt, schema, capability registry and scoring configuration used by the job.
2. **Get a compact catalogue.** Retrieve sport and activity IDs, aliases and basic recognition descriptions. Do not send the full 60-sport ontology to either model.
3. **Execute orchestration.** Use a reviewed reusable program for common paths or ask Gemini to generate a bounded tool program for an adaptive case. Log planner requests separately from inspection requests. Additional model turns for adapting the program are permitted only within the same host-enforced budget.
4. **Sign read access just before the provider request.** The GET URL refers to the pinned original or compatible analysis copy, not the upload PUT URL. Signing is a server-side operation using scoped credentials; there is no S3 network call required simply to compute the signature.
5. **Discover with Pegasus.** Send the actual video, compact vocabulary, optional user context and an understanding-only JSON schema. Request ranked activity candidates, evidence for and against each candidate, action intervals, number of attempts, visible subjects, equipment and recording limitations. Do not request grades, inferred athlete identity or invented joint angles.
6. **Preserve uncertainty.** Model-supplied confidence is an uncalibrated signal until evaluated. Validate IDs, timestamp bounds and schema, but do not confuse valid JSON with correct perception.
7. **Compare candidates.** Retrieve diagnostic sequences, common confusions and explicit distinguishing questions. Match structured observations to known criteria. Any unresolved semantic judgment becomes a visual inspection question in Phase 3, rather than being settled by arbitrary numeric thresholds.
8. **Use reference search conditionally.** A curated reference library is optional and distinct from Pegasus analysis. It uses a Marengo-enabled index and rights-cleared, labelled examples. Retrieve counterexamples and similar activities as well as positive examples. Similarity does not establish a sport label, a technique fault or a performance score.
9. **Keep the activity provisional.** If evidence is ambiguous, pass the candidate set and discriminating questions to visual inspection. Do not apply a netball coaching protocol merely because the venue resembles a netball court.

## Phase 3 — Inspect actual evidence

~~~mermaid
sequenceDiagram
    autonumber
    participant W as Worker and Code Mode
    participant F as FalkorDB
    participant S3 as Private S3
    participant G as Gemini

    W->>F: Get candidate protocols, visual questions and eligible drills
    F-->>W: Versioned criteria, requirements and reviewed content
    W->>W: Compile questions against implemented capabilities
    W->>S3: Read relevant source intervals
    S3-->>W: Verified media
    W->>W: Extract ordered frames or clips with CPU tools
    W->>S3: Save evidence packets and source-time mapping
    W->>G: Actual visual input with protocol and recognition questions
    G-->>W: Activity check, answers, evidence and observability
    W->>W: Validate question IDs, evidence links and contradictions
    loop Unresolved question and host budget remains
        W->>W: Select one focused follow-up evidence packet
        W->>G: Reinspect with a discriminating question
        G-->>W: Supported answer or explicit uncertainty
    end
    alt Activity remains unresolved
        W->>W: Set needs_context or limit to supported observations
    else Activity established
        W->>W: Finalise supported findings and assessment coverage
    end
~~~

### Activities and controls

1. **Retrieve the minimum protocol context.** Include the exact sport/skill/format release, phases, relevant visual questions, camera requirements, approved criteria, contraindicated cues and eligible content IDs. Resolve candidate ambiguity before issuing sport-specific coaching.
2. **Compile to available capabilities.** For each question or metric, check whether the current pipeline has the required detector and whether this clip supplies the right view and sufficient detail. Declared ontology support is not proof of an implemented measurement.
3. **Keep unavailable metrics unavailable.** Pose-dependent knee angles or 3D hip–shoulder separation cannot be filled from descriptive text. Excluding a metric does not necessarily exclude the entire report.
4. **Build evidence packets.** Use the approximate event windows to obtain short clips or ordered frame sequences; include wider context when relevant. Preserve source timestamps, frame presentation timestamps, crop coordinates and transformation metadata. Approximate model events are not exact contact frames.
5. **Provide actual vision input to Gemini.** Use supported media transport: uploaded video, inline frames or another provider-supported method. Do not assume every provider accepts a private S3 GET URL directly. Do not send only Pegasus JSON and call it independent visual verification.
6. **Inspect candidate distinctions and protocol questions.** Ask Gemini to inspect the visual packet before considering prior interpretations. Avoid treating the leading Pegasus label or score as an instruction. Include competing explanations where needed.
7. **Require explicit observability.** An answer is supported, contradicted or not assessable, with a separate visibility state. Not visible is different from the athlete failing the skill.
8. **Sample appropriately.** Verify the actual Gemini model and request configuration. Default static video sampling can miss rapid action. Use focused sequences, suitable supported sampling or explicit frames; source video FPS alone does not guarantee the model inspected every frame.
9. **Reinspect selectively.** A first-release policy can permit one additional visual inspection, with a configurable hard cap on calls, duration, tokens, cost allowance and wall-clock time. A wrapper may alternatively use a targeted Pegasus start/end-window call; this must consume the same shared follow-up allowance, not create an extra unlimited loop.
10. **Stop honestly.** If the sport, target person or relevant action remains unresolved, request the smallest useful clarification or return only supported observations. Never turn a budget exhaustion or missing capability into an athlete fault.

## Phase 4 — Assess, publish and correct

~~~mermaid
sequenceDiagram
    autonumber
    participant W as Existing worker
    participant DB as Existing app storage
    participant API as Striide API
    participant App as Striide app
    participant S3 as Private S3

    W->>W: Validate evidence, rubric eligibility and coverage
    alt Approved rubric and sufficient valid inputs
        W->>W: Calculate eligible criterion scores
    else Inputs or rubric are insufficient
        W->>W: Produce supported review without unsupported grade
    end
    W->>W: Select approved cues and drills
    W->>W: Assemble report with templates and claim checks
    W->>DB: Commit report, evidence refs, versions, usage and terminal state
    DB-->>W: Durable commit acknowledged
    W->>W: Acknowledge job only after successful commit
    App->>API: Poll job status and retrieve authorised report
    API->>DB: Read job and report
    DB-->>API: Status and report data
    API-->>App: Report with fresh authorised playback URLs
    App->>S3: GET video or evidence for a selected finding
    S3-->>App: Media for replay
    opt Coach corrects an individual finding
        App->>API: Submit finding correction
        API->>DB: Save version-linked feedback for expert review
    end
~~~

### Activities and controls

1. **Separate recognition, evidence and performance.** Sport identification confidence, visibility and rubric coverage are not performance scores. A low-resolution video does not imply low sporting ability.
2. **Score only eligible inputs.** An approved qualitative rubric may be used once evaluated with coaches. Do not manufacture numeric biomechanics. Exclude invalid evidence and withhold an overall grade when required coverage is missing; do not renormalise one favourable criterion into an excellent global score.
3. **Choose approved coaching actions.** Validate drill and content IDs against the retrieved protocol and known athlete context. Preserve age, workload and format restrictions. If age is unknown, do not select a drill that requires a verified minimum age.
4. **Build the initial report with reviewed templates.** Populate supported findings and approved coaching wording. This avoids requiring a separate narration call after code calculates scores. A future optional narrative model must receive the final validated assessment and consume its own budget.
5. **Check claims before publication.** Validate IDs, timestamps, evidence presence, permitted numeric fields, prohibited cues, unsupported causal claims and inappropriate injury or selection statements. String filters alone are insufficient; constrain content selection and allow reviewed template fallback.
6. **Persist provenance.** Retain the original discovery JSON at the existing TwelveLabs-understanding field where compatible; store the inspection result, evidence references, input digest, actual provider/model identities, versions, degradation flags, retries, token usage, costs and wall-clock timings.
7. **Commit atomically and acknowledge after commit.** Make finalisation idempotent using the job ID and report version. Recover after worker crashes without creating duplicate reports or duplicate internal charges. Provider requests repeated after an uncertain timeout can still incur provider costs; exactly-once provider billing is not guaranteed.
8. **Deliver through the API.** Authenticate report and evidence access per tenant and athlete. Sign playback URLs when requested rather than persisting long-lived bearer URLs in reports.
9. **Keep feedback separate from production truth.** Save corrections against finding and report versions. Experts review a batch, propose new protocol or prompt versions, and replay the evaluation set before promotion. A user correction does not automatically modify the production graph or train a model.

## Suggested application API

These names are illustrative; preserve existing routes where they already serve the same purpose.

| Route | Purpose |
|---|---|
| POST /analysis/uploads | Authorise request, create upload session and job, return presigned PUT URL. |
| POST /analysis/{jobId}/complete-upload | Verify the assigned S3 upload, pin the source, enqueue idempotently. |
| GET /analysis/{jobId} | Return authorised stage, progress information and terminal outcome. |
| GET /analysis/{jobId}/report | Return the versioned report when available. |
| GET /analysis/{jobId}/evidence/{evidenceId} | Authorise access and issue fresh media playback URLs. |
| POST /analysis/{jobId}/context | Add requested context and resume or create an explicit assessment revision. |
| POST /analysis/{jobId}/feedback | Record a correction to an individual finding. |

## Suggested job states

Normal path:
awaiting_upload → queued → preparing → discovering → comparing → inspecting → assessing → completed

Alternative terminal outcomes:
- completed_partial: useful findings exist but some aspects cannot be assessed.
- needs_context: activity, target athlete or essential context remains unresolved.
- rejected: invalid or unsupported input with an actionable reason.
- failed: processing did not complete because of a technical failure.

Retries remain attached to their original stage and job. A later user context response can resume from a safe checkpoint; it must not silently rewrite an already published report.

The UI can map real worker stages to “Preparing your video”, “Identifying the activity”, “Checking the context”, “Inspecting key moments” and “Building your review”. Any sonar animation should accompany actual stage events; it should not claim pose measurements that did not run. Avoid invented progress percentages.

## Minimum saved contracts

| Record | Required information |
|---|---|
| Job | Job ID, tenant/user, authorised athlete reference if known, upload session, pinned source, optional user context, stage, timestamps, lease, retry history and budget. |
| Media manifest | Original and derivative references, content digest, codec, size, dimensions, duration, source time base, rotation and transformation mapping. |
| Discovery | Candidate activity IDs, supporting and conflicting evidence, attempt intervals, target ambiguity, limitations, provider/model identity and raw response. |
| Inspection plan | Protocol release, question IDs, evidence windows, available capabilities, exclusions, approved content subset and planned follow-ups. |
| Evidence | Evidence ID, source interval/frame timestamps, crop/source mapping, visibility, question ID, observed answer and uncertainty. |
| Assessment | Supported findings, excluded criteria, coverage, rubric eligibility, optional scores, approved cue/drill IDs and all generating versions. |
| Usage trace | Planner and analysis requests, provider request IDs, latency, retries, reported tokens, estimated/actual cost fields and cached outputs. |
| Feedback | Finding ID, report version, correction, reviewer identity, review state and resulting proposed configuration version. |

Use structured evidence summaries rather than requesting or storing hidden model chain-of-thought.

## Code Mode tool boundary

The typed tool catalogue should be small and scoped. Suggested logical interfaces:

| Tool | Host responsibility |
|---|---|
| media.describe | Read the job-owned media manifest. |
| ontology.getCatalogue | Return compact recognition vocabulary. |
| ontology.getRecognitionProfiles | Return candidate criteria and distinguishing questions. |
| ontology.getProtocol | Return the approved versioned protocol subset. |
| video.discover | Call Pegasus with job-scoped media access and validated schema. |
| video.searchReferences | Search the optional authorised reference index. |
| media.extractEvidence | Generate bounded CPU clips/frames and preserve source mapping. |
| vision.inspect | Call Gemini with the actual visual packet and fixed questions. |
| assessment.validate | Apply host-defined evidence and eligibility rules. |
| assessment.calculate | Apply a reviewed rubric to eligible inputs. |
| report.assemble | Produce a report from validated findings and approved content. |

The generated program cannot replace host assessment rules, invent rubric versions, access arbitrary S3 objects, expose credentials, write production ontology data or exceed budgets. Tool arguments are validated server-side even if the generated program appears correct.

## Failure and retry behaviour

| Condition | Behaviour |
|---|---|
| Upload URL expired | Reauthorise and issue a new PUT URL for the unfinished upload session. Never enqueue absent bytes. |
| Provider GET URL expired | Regenerate access to the same pinned input and retry only within the job budget. |
| Provider 429, 5xx or transient network failure | Retry with bounded backoff/jitter; checkpoint and expose the real stage. Avoid holding the browser connection open. |
| Missing required provider credentials | Record configuration failure. Any allowed Gemini-only degradation must be explicit and separately evaluated, not silent. |
| Invalid/truncated model JSON | Record the response and error; apply a bounded retry/repair policy. Do not silently interpret malformed data as valid evidence. |
| Unsupported sport or no validated protocol | Provide supported observations when possible, clearly separated from an assessed skill grade. |
| Pegasus and Gemini disagree | Reinspect the distinguishing interval if budget remains; otherwise preserve uncertainty. |
| Missing view or insufficient detail | Mark that question not assessable; retain other supported findings. |
| Worker crashes | Resume from a verified checkpoint under an idempotent lease. |
| Report commit fails | Retry persistence; do not acknowledge successful completion or publish an incomplete result. |

## Cost and rollout

The minimum straightforward execution can use a reusable orchestration program, one Pegasus discovery request, one Gemini visual-inspection request and template-based report assembly. This is a target execution path to evaluate, not a universal call-count guarantee.

Uncached Code Mode planning, reference indexing/search, repeated inspections and retries add cost. Capture each separately. Enforce hard input, call, token and duration limits; use a host-side spending allowance based on conservative estimates, since exact provider billing can arrive later.

Roll out behind a feature flag using the existing job flow. Evaluate against coach-labelled footage before promotion, including the previously reviewed cycling, junior softball bowling, low-resolution batting and cricket/netball-confusion cases. Include unfamiliar activities, multiple athletes, multiple attempts and insufficient-evidence cases. Gate on accepted-case accuracy and coverage together, evidence support, coaching appropriateness, latency and cost.

## Reference documentation

- Existing Striide attachment: How we use Twelve Labs.pdf — current hybrid flow and configuration.
- Existing Striide attachment: Striide AI Engine — Executive Summary (1).pdf — alternative architecture reviewed.
- Existing Striide attachment: striide-ontology-all.json — sampled ontology structure and protocols.
- [AWS: uploading objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)
- [AWS: download and upload objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [TwelveLabs: synchronous analysis](https://docs.twelvelabs.io/api-reference/analyze-videos/analyze)
- [TwelveLabs: reference search with text and images](https://docs.twelvelabs.io/docs/guides/search/search-with-text-and-image-queries)
- [Gemini: video understanding](https://ai.google.dev/gemini-api/docs/video-understanding)
- [Cloudflare: Code Mode](https://developers.cloudflare.com/agents/tools/codemode/)

Provider details should be verified against the exact SDK and deployed model at implementation time.

