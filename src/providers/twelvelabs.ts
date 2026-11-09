import { createReadStream, statSync } from 'node:fs';
import { TwelvelabsApiClient } from 'twelvelabs-js';
import { LabError } from '../util/errors.js';
import { sleep } from '../util/time.js';
import { providerCall, requestIdFrom } from './call.js';
import type { RunContext } from '../jobs/context.js';
import type { SpanContext } from '../telemetry/trace.js';
import type { LabConfig } from '../config/load.js';
import { toPegasusSchema } from './schema-translate.js';
import { sha256Hex } from '../util/hash.js';

/** Minimal surface of the official SDK used here, so tests can substitute a mock. */
export interface TwelveLabsClientLike {
  assets: {
    create(req: { method: 'direct'; file: any; filename?: string; enableHls?: boolean; enableThumbnail?: boolean }, opts?: any): { withRawResponse(): Promise<{ data: any; rawResponse: any }> };
    retrieve(id: string, opts?: any): { withRawResponse(): Promise<{ data: any; rawResponse: any }> };
    delete(id: string, req?: any, opts?: any): { withRawResponse(): Promise<{ data: any; rawResponse: any }> };
  };
  analyze(req: any, opts?: any): { withRawResponse(): Promise<{ data: any; rawResponse: any }> };
}

export function realTwelveLabsClient(apiKey: string, baseUrl: string): TwelveLabsClientLike {
  return new TwelvelabsApiClient({ apiKey, baseUrl }) as unknown as TwelveLabsClientLike;
}

export type AssetStatus = 'processing' | 'ready' | 'failed' | string;

export interface DiscoveryResult { raw_text: string; parsed: unknown | null; finish_reason: string | null; response_id: string | null; usage: { input_tokens: number | null; output_tokens: number | null } }

/** Account fingerprint for cache scoping (one-way hash; never the key). */
export function accountFingerprint(apiKey: string): string { return sha256Hex('twelvelabs:' + apiKey).slice(0, 16); }

export class TwelveLabsProvider {
  constructor(private client: TwelveLabsClientLike, private cfg: LabConfig['providers']['twelvelabs']) {}

  /** Direct asset upload: multipart bytes streamed from the prepared file (no base64, no public URL). */
  async upload(ctx: RunContext, parent: SpanContext, file: string, neutralName: string): Promise<{ asset_id: string; status: AssetStatus }> {
    const bytes = statSync(file).size;
    if (bytes > this.cfg.direct_upload_limit_mb * 1024 * 1024) throw new LabError('input_rejected', `Prepared media is ${(bytes / 1048576).toFixed(1)} MB, above the ${this.cfg.direct_upload_limit_mb} MB direct-upload lab cap.`);
    const r = await providerCall(ctx, parent, {
      provider: 'twelvelabs', role: 'upload', model: null, spanName: 'twelvelabs.upload', generation: false, timeoutMs: this.cfg.request_timeout_ms,
      attributes: { bytes, upload_name: neutralName, method: 'direct' },
      // Upload bodies are streams; retrying re-opens the file. Rate limits/5xx are retried within budget.
      fn: async (signal) => {
        const req: any = { method: 'direct', file: createReadStream(file), filename: neutralName };
        if (this.cfg.disable_optional_hls_and_thumbnails) { req.enableHls = false; req.enableThumbnail = false; }
        const { data, rawResponse } = await this.client.assets.create(req, { abortSignal: signal, maxRetries: 0, timeoutInSeconds: Math.ceil(this.cfg.request_timeout_ms / 1000) }).withRawResponse();
        if (!data?.id) throw new LabError('provider_client', 'Upload response did not include an asset ID');
        return { value: { asset_id: String(data.id), status: String(data.status ?? 'processing') }, meta: { request_id: requestIdFrom(rawResponse?.headers), http_status: rawResponse?.status ?? null } };
      },
    });
    return r.value;
  }

  async retrieve(ctx: RunContext, parent: SpanContext, assetId: string, attemptLabel: number): Promise<{ status: AssetStatus; error: string | null; duration: number | null }> {
    const r = await providerCall(ctx, parent, {
      provider: 'twelvelabs', role: 'readiness_poll', model: null, spanName: 'twelvelabs.readiness_attempt', generation: false, timeoutMs: Math.min(this.cfg.request_timeout_ms, 30000),
      attributes: { asset_id: assetId, poll: attemptLabel },
      fn: async (signal) => {
        const { data, rawResponse } = await this.client.assets.retrieve(assetId, { abortSignal: signal, maxRetries: 0, timeoutInSeconds: 30 }).withRawResponse();
        const err = data?.error ? JSON.stringify(data.error).slice(0, 300) : null;
        return { value: { status: String(data?.status ?? 'unknown'), error: err, duration: typeof data?.duration === 'number' ? data.duration : null }, meta: { request_id: requestIdFrom(rawResponse?.headers), http_status: rawResponse?.status ?? null } };
      },
    });
    return r.value;
  }

  /**
   * Poll until ready, failed or the readiness deadline. Polls, local waits and retries are separate spans.
   * Client-observed readiness time is not the provider's processing time.
   */
  async waitReady(ctx: RunContext, parent: SpanContext, assetId: string): Promise<{ polls: number; observed_wait_ms: number; duration: number | null }> {
    return parent.child('twelvelabs.asset_ready_wait', { asset_id: assetId, deadline_ms: this.cfg.readiness_timeout_ms, poll_interval_ms: this.cfg.poll_interval_ms, note: 'client-observed readiness; provider processing time is not reported' }, async (span) => {
      const start = performance.now();
      for (let poll = 1; ; poll++) {
        const st = await this.retrieve(ctx, span, assetId, poll);
        span.set({ polls: poll, last_status: st.status });
        if (st.status === 'ready') return { polls: poll, observed_wait_ms: performance.now() - start, duration: st.duration };
        if (st.status === 'failed') throw new LabError('provider_asset_failed', `TwelveLabs could not process the uploaded asset${st.error ? `: ${st.error}` : ''}`, { details: { asset_id: assetId } });
        const elapsed = performance.now() - start;
        if (elapsed + this.cfg.poll_interval_ms > this.cfg.readiness_timeout_ms) throw new LabError('provider_readiness_timeout', `Asset was not ready within ${this.cfg.readiness_timeout_ms} ms (last status ${st.status})`, { details: { asset_id: assetId, polls: poll } });
        await span.child('twelvelabs.poll_wait', { wait_ms: this.cfg.poll_interval_ms }, () => sleep(this.cfg.poll_interval_ms, ctx.signal));
      }
    });
  }

  /** Verify a cached asset still exists and is ready before reuse. */
  async verifyReusable(ctx: RunContext, parent: SpanContext, assetId: string): Promise<boolean> {
    try { return (await this.retrieve(ctx, parent, assetId, 0)).status === 'ready'; }
    catch (e) { if (e instanceof LabError && (e.kind === 'provider_client' || e.kind === 'provider_auth')) return false; throw e; }
  }

  /** Pegasus understanding-only structured JSON analysis using the ready asset ID. */
  async analyze(ctx: RunContext, parent: SpanContext, o: { assetId: string; prompt: string; schema: Record<string, unknown>; role: 'discovery' | 'followup'; startTime?: number; endTime?: number; spanName: string }): Promise<DiscoveryResult> {
    const responseSchema = toPegasusSchema(o.schema);
    const req: any = { modelName: this.cfg.model, video: { type: 'asset_id', assetId: o.assetId }, prompt: o.prompt, temperature: 0, maxTokens: this.cfg.max_output_tokens, responseFormat: { type: 'json_schema', jsonSchema: responseSchema } };
    if (o.startTime !== undefined && o.endTime !== undefined) { req.startTime = o.startTime; req.endTime = o.endTime; }
    const reqArtifact = ctx.artifact(`${o.spanName}.request.json`, { endpoint: 'POST /analyze', body: { ...req, video: { type: 'asset_id', asset_id: o.assetId } }, prompt_sha256: sha256Hex(o.prompt), schema_sha256: sha256Hex(JSON.stringify(responseSchema)) });
    const r = await providerCall(ctx, parent, {
      provider: 'twelvelabs', role: o.role === 'followup' ? 'followup' : 'discovery', model: this.cfg.model, spanName: o.spanName, generation: true, timeoutMs: this.cfg.request_timeout_ms,
      attributes: { asset_id: o.assetId, prompt_sha256: sha256Hex(o.prompt), schema_sha256: sha256Hex(JSON.stringify(responseSchema)), window: o.startTime !== undefined ? [o.startTime, o.endTime] : null, request_artifact: reqArtifact },
      fn: async (signal) => {
        const t0 = performance.now();
        const { data, rawResponse } = await this.client.analyze(req, { abortSignal: signal, maxRetries: 0, timeoutInSeconds: Math.ceil(this.cfg.request_timeout_ms / 1000) }).withRawResponse();
        const receiveMs = performance.now() - t0;
        const usage = data?.usage ? { input_tokens: data.usage.inputTokens ?? null, output_tokens: data.usage.outputTokens ?? null, cached_input_tokens: null, thinking_tokens: null, total_tokens: null, video_seconds: null } : null;
        return { value: { data, receiveMs, headers: rawResponse?.headers }, meta: { request_id: data?.id ?? requestIdFrom(rawResponse?.headers), http_status: rawResponse?.status ?? null, finish_reason: data?.finishReason ?? null, usage, usage_source: usage ? 'provider_reported' : 'not_reported' } };
      },
    });
    const data = r.value.data;
    const raw = typeof data?.data === 'string' ? data.data : JSON.stringify(data?.data ?? '');
    ctx.artifact(`${o.spanName}.response.json`, { id: data?.id ?? null, finish_reason: data?.finishReason ?? null, usage: data?.usage ?? null, warning: data?.error ?? null, data: raw });
    let parsed: unknown = null;
    await parent.child('response_receive', { bytes: raw.length, round_trip_ms: r.value.receiveMs, time_to_first_byte_ms: null, note: 'non-streaming request; time to first byte not observable' }, () => undefined);
    if (data?.finishReason === 'length') throw new LabError('model_truncated', 'Pegasus output reached the token limit; the JSON may be truncated and is not used.', { details: { finish_reason: 'length' } });
    try { parsed = JSON.parse(raw); } catch { throw new LabError('model_content', 'Pegasus did not return parseable JSON.', { details: { finish_reason: data?.finishReason ?? null } }); }
    return { raw_text: raw, parsed, finish_reason: data?.finishReason ?? null, response_id: data?.id ?? null, usage: { input_tokens: data?.usage?.inputTokens ?? null, output_tokens: data?.usage?.outputTokens ?? null } };
  }

  async deleteAsset(ctx: RunContext, parent: SpanContext, assetId: string): Promise<{ deleted: boolean; status: string }> {
    try {
      await providerCall(ctx, parent, { provider: 'twelvelabs', role: 'delete', model: null, spanName: 'twelvelabs.delete_asset', generation: false, timeoutMs: 30000, attributes: { asset_id: assetId }, maxRetries: 0,
        fn: async (signal) => { const { rawResponse } = await this.client.assets.delete(assetId, undefined, { abortSignal: signal, maxRetries: 0 }).withRawResponse(); return { value: null, meta: { http_status: rawResponse?.status ?? null } }; } });
    } catch (e) { return { deleted: false, status: e instanceof LabError ? `${e.kind}: ${e.message}` : String(e) }; }
    // Do not assume deletion succeeded: check the asset is gone.
    try { await this.retrieve(ctx, parent, assetId, -1); return { deleted: false, status: 'asset still retrievable after delete' }; }
    catch (e) { if (e instanceof LabError && e.kind === 'provider_client') return { deleted: true, status: 'verified: asset no longer retrievable' }; return { deleted: false, status: `verification failed: ${(e as Error).message}` }; }
  }
}
