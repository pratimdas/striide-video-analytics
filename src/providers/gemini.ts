import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { LabError } from '../util/errors.js';
import { providerCall, requestIdFrom } from './call.js';
import { toGeminiSchema } from './schema-translate.js';
import { sha256Hex } from '../util/hash.js';
import { sleep } from '../util/time.js';
import type { RunContext } from '../jobs/context.js';
import type { SpanContext } from '../telemetry/trace.js';
import type { LabConfig } from '../config/load.js';
import type { EvidencePacket } from '../media/evidence.js';

/** Minimal surface of the official SDK used here (mockable in tests). */
export interface GeminiClientLike {
  models: { generateContent(params: any): Promise<any> };
  files: { upload(params: any): Promise<any>; get(params: any): Promise<any>; delete(params: any): Promise<any> };
}

export function realGeminiClient(apiKey: string): GeminiClientLike {
  // attempts: 1 disables hidden SDK retries; the host performs and records every retry.
  return new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } }) as unknown as GeminiClientLike;
}

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } } | { fileData: { mimeType: string; fileUri: string } };

export interface GenerateResult { text: string; parsed: unknown | null; finish_reason: string | null; response_id: string | null; model_version: string | null; usage: NonNullable<import('../telemetry/ledger.js').CallRecord['usage']> | null }

export class GeminiProvider {
  constructor(private client: GeminiClientLike, private cfg: LabConfig['providers']['gemini'], readonly models: { planner: string | null; inspector: string | null }) {}

  /** Build ordered frame parts: each frame is preceded by its evidence ID and exact source timestamp. */
  static framePackets(packets: EvidencePacket[], maxBytes: number): { parts: Part[]; bytes: number; frames: number; manifest: unknown[] } {
    const parts: Part[] = []; let bytes = 0; let frames = 0; const manifest: unknown[] = [];
    for (const p of packets) {
      parts.push({ text: `Packet ${p.packet_id}${p.window_id ? ` (window ${p.window_id}: ${p.label})` : ''}. Ordered frames from ${p.context_start_seconds.toFixed(3)} s to ${p.context_end_seconds.toFixed(3)} s; window of interest ${p.start_seconds.toFixed(3)}–${p.end_seconds.toFixed(3)} s. Purpose: ${p.purpose}.` });
      for (const f of p.frames) {
        const data = readFileSync(f.file);
        bytes += data.length;
        if (bytes > maxBytes) throw new LabError('budget_exceeded', `Inline evidence exceeds the ${(maxBytes / 1048576).toFixed(1)} MB cap`, { details: { limit: 'max_total_inline_evidence_mb' } });
        parts.push({ text: `evidence_id ${f.evidence_id} — source time ${f.t.toFixed(3)} s (frame ${f.frame_index})` });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: data.toString('base64') } });
        frames++; manifest.push({ evidence_id: f.evidence_id, t: f.t, frame_index: f.frame_index, bytes: data.length, sha256: f.sha256 });
      }
    }
    return { parts, bytes, frames, manifest };
  }

  async generate(ctx: RunContext, parent: SpanContext, o: { role: 'planner' | 'inspector' | 'followup'; system: string; parts: Part[]; schema: Record<string, unknown>; spanName: string; maxOutputTokens: number; attributes?: Record<string, unknown>; artifactSummary: unknown }): Promise<GenerateResult> {
    const model = o.role === 'planner' ? this.models.planner : this.models.inspector;
    if (!model) throw new LabError('config', `Gemini ${o.role === 'planner' ? 'planner' : 'inspector'} model ID is not configured`);
    const jsonSchema = toGeminiSchema(o.schema);
    const promptText = o.parts.filter((p): p is { text: string } => 'text' in p).map((p) => p.text).join('\n');
    const reqArtifact = ctx.artifact(`${o.spanName}.request.json`, { model, role: o.role, system_instruction: o.system, text_parts: promptText, media_parts: o.artifactSummary, response_json_schema: jsonSchema, temperature: this.cfg.temperature, max_output_tokens: o.maxOutputTokens });
    const r = await providerCall(ctx, parent, {
      provider: 'gemini', role: o.role, model, spanName: o.spanName, generation: true, timeoutMs: this.cfg.request_timeout_ms,
      attributes: { ...o.attributes, prompt_sha256: sha256Hex(o.system + promptText), schema_sha256: sha256Hex(JSON.stringify(jsonSchema)), request_artifact: reqArtifact },
      fn: async (signal) => {
        const t0 = performance.now();
        const resp = await this.client.models.generateContent({
          model, contents: [{ role: 'user', parts: o.parts }],
          config: { systemInstruction: o.system, temperature: this.cfg.temperature, maxOutputTokens: o.maxOutputTokens, responseMimeType: 'application/json', responseJsonSchema: jsonSchema, abortSignal: signal, httpOptions: { timeout: this.cfg.request_timeout_ms, retryOptions: { attempts: 1 } } },
        });
        const u = resp?.usageMetadata;
        const usage = u ? { input_tokens: u.promptTokenCount ?? null, output_tokens: u.candidatesTokenCount ?? null, cached_input_tokens: u.cachedContentTokenCount ?? null, thinking_tokens: u.thoughtsTokenCount ?? null, total_tokens: u.totalTokenCount ?? null, video_seconds: null } : null;
        const finish = resp?.candidates?.[0]?.finishReason ?? null;
        return { value: { resp, ms: performance.now() - t0 }, meta: { request_id: resp?.responseId ?? requestIdFrom(resp?.sdkHttpResponse?.headers), http_status: null, finish_reason: finish, usage, usage_source: usage ? 'provider_reported' : 'not_reported' } };
      },
    });
    const resp = r.value.resp;
    let text = '';
    try { text = typeof resp?.text === 'string' ? resp.text : (resp?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join(''); } catch { text = ''; }
    const finish = resp?.candidates?.[0]?.finishReason ?? null;
    const u = resp?.usageMetadata;
    ctx.artifact(`${o.spanName}.response.json`, { response_id: resp?.responseId ?? null, model_version: resp?.modelVersion ?? null, finish_reason: finish, prompt_feedback: resp?.promptFeedback ?? null, usage_metadata: u ?? null, text });
    await parent.child('response_receive', { bytes: text.length, round_trip_ms: r.value.ms, time_to_first_byte_ms: null, note: 'non-streaming request' }, () => undefined);
    if (finish === 'MAX_TOKENS') throw new LabError('model_truncated', `Gemini ${o.role} output hit the token limit; not used.`, { details: { finish_reason: finish } });
    if (resp?.promptFeedback?.blockReason || (finish && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(finish))) throw new LabError('model_content', `Gemini ${o.role} did not complete normally (${resp?.promptFeedback?.blockReason ?? finish}).`, { details: { finish_reason: finish } });
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { throw new LabError('model_content', `Gemini ${o.role} returned text that is not valid JSON.`); }
    return { text, parsed, finish_reason: finish, response_id: resp?.responseId ?? null, model_version: resp?.modelVersion ?? null, usage: u ? { input_tokens: u.promptTokenCount ?? null, output_tokens: u.candidatesTokenCount ?? null, cached_input_tokens: u.cachedContentTokenCount ?? null, thinking_tokens: u.thoughtsTokenCount ?? null, total_tokens: u.totalTokenCount ?? null, video_seconds: null } : null };
  }

  /** Files API (short original video clip) for sequence questions frames cannot support. Polls until ACTIVE. */
  async uploadVideoFile(ctx: RunContext, parent: SpanContext, file: string, deadlineMs: number): Promise<{ uri: string; name: string; mimeType: string }> {
    const up = await providerCall(ctx, parent, { provider: 'gemini', role: 'file_upload', model: null, spanName: 'gemini.file_upload', generation: false, timeoutMs: this.cfg.request_timeout_ms, attributes: { note: 'provider-owned temporary file URI; local evidence remains authoritative' },
      fn: async (signal) => { const f = await this.client.files.upload({ file, config: { mimeType: 'video/mp4', abortSignal: signal } }); return { value: f, meta: {} }; } });
    const name = up.value?.name;
    if (!name) throw new LabError('provider_client', 'Gemini file upload returned no file name');
    return parent.child('gemini.file_ready_wait', { file_name: name, deadline_ms: deadlineMs }, async (span) => {
      const t0 = performance.now();
      for (let poll = 1; ; poll++) {
        const g = await providerCall(ctx, span, { provider: 'gemini', role: 'file_poll', model: null, spanName: 'gemini.file_poll_attempt', generation: false, timeoutMs: 30000, attributes: { poll }, fn: async () => ({ value: await this.client.files.get({ name }), meta: {} }) });
        const state = String(g.value?.state ?? 'STATE_UNSPECIFIED');
        span.set({ polls: poll, last_state: state });
        if (state === 'ACTIVE') return { uri: String(g.value.uri), name, mimeType: String(g.value.mimeType ?? 'video/mp4') };
        if (state === 'FAILED') throw new LabError('provider_asset_failed', 'Gemini Files API reported FAILED for the uploaded clip');
        if (performance.now() - t0 > deadlineMs) throw new LabError('provider_readiness_timeout', `Gemini file not ACTIVE within ${deadlineMs} ms`);
        await span.child('gemini.file_poll_wait', { wait_ms: 2000 }, () => sleep(2000, ctx.signal));
      }
    });
  }
}
