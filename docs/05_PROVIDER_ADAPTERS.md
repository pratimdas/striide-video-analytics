# Managed provider adapters

Use current official SDKs/docs and pin the resolved versions. Verify actual model access with the explicitly invoked live smoke test. This pack contains no keys and no successful live analysis results.

## TwelveLabs local transport

Create a direct asset by sending multipart file bytes to POST /v1.3/assets with method=direct. Poll GET /v1.3/assets/{id} until ready; failed or deadline stops the job with a typed error. Pass a ready asset reference to analysis as video={type: asset_id, asset_id: returned_id}; set model_name explicitly to pegasus1.6. Request understanding-only structured JSON through the documented response_format schema.

A path such as C:/videos/clip.mp4 or localhost URL is not a video source the hosted model can fetch. Do not open a public tunnel. SDK file-upload helpers should stream bytes. Avoid manually setting a multipart boundary inconsistent with the SDK's FormData.

Provider upload-size documentation and plans can differ; validate the current endpoint and account constraints. The pack uses a conservative 180 MB lab cap. Larger-file multipart support can be added behind the adapter after the short-clip path works. Polling is asynchronous even for small uploads. Optional HLS/thumbnail creation may be disabled if supported; do not claim a measured speed saving until observed.

Cache ready asset IDs against provider/account, prepared-media digest and upload options. Validate existence/readiness before reuse, and re-upload if expired/deleted. Never silently reuse an asset from another account. Keep neutral names in no-context tests.

Targeted follow-ups can reuse the ready asset and supported start_time/end_time windows. Preserve original/internal timestamp mapping and required minimum window length. Do not claim exact contact timing from approximate model output.

## Gemini visual transport

Use the official Gemini SDK. Initially send bounded inline JPEG/PNG ordered-frame packets with explicit source timestamps and wider context. Respect current request/image limits and the configured 12 MB total evidence cap. Movement findings require a sequence; use original short video clips via Files API when the question cannot be supported by selected frames.

For Files API video, upload bytes and poll until ACTIVE; stop on FAILED or deadline. The file URI is provider-owned and temporary, not a permanent evidence link. Local frames/source remain the report evidence. Inline frames do not require a separately polled video asset, but still upload image data in the model request.

When using video inputs verify effective sampling and model support. The original FPS alone does not tell you how many frames the model inspected. Do not assume the Files API and analysis API use identical provider state names.

Keep planner and inspector roles separately configurable even when using one Gemini model. Never hardcode a speculative model name; doctor requires nonblank configuration and provider:smoke proves access. SDK attempts may retry internally: disable hidden retries where possible or surface them in attempt accounting.

## Structured output and failures

Translate canonical contracts into each provider's supported JSON-schema subset rather than sending unsupported draft features. Validate locally against the canonical contract too. A schema-valid response is not evidence-valid. Save redacted raw output and finish reason; invalid/truncated output is not a successful report.

Timeout, 429, 5xx, transport errors and model-content failures are different outcomes. Bound all retries and polling by both stage deadlines and the run-wide budgets. Record unknown-outcome timeouts; a repeated provider request may incur another charge.

## References checked for this pack

- https://docs.twelvelabs.io/v1.3/api-reference/upload-files/direct-uploads/create
- https://docs.twelvelabs.io/api-reference/analyze-videos/analyze
- https://ai.google.dev/api/files
- https://ai.google.dev/gemini-api/docs/video-understanding
- https://docs.falkordb.com/
- https://developers.cloudflare.com/agents/tools/codemode/
- https://docs.deno.com/runtime/fundamentals/security/
- https://striideai.com/brand-kit/AGENT.MD
