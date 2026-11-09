/**
 * Strict configuration schema. Every key in config.local.yaml must be known here;
 * unknown keys are rejected so a typo can never silently disable a guardrail.
 */
export type Rule =
  | { t: 'str'; enum?: readonly string[]; pattern?: RegExp; nullable?: boolean }
  | { t: 'int'; min: number; max: number; nullable?: boolean }
  | { t: 'num'; min: number; max: number; nullable?: boolean }
  | { t: 'bool' }
  | { t: 'const'; value: unknown }
  | { t: 'obj'; fields: Record<string, Rule> };

const s = (o: Omit<Extract<Rule, { t: 'str' }>, 't'> = {}): Rule => ({ t: 'str', ...o });
const i = (min: number, max: number, nullable = false): Rule => ({ t: 'int', min, max, nullable });
const n = (min: number, max: number, nullable = false): Rule => ({ t: 'num', min, max, nullable });
const b: Rule = { t: 'bool' };
const obj = (fields: Record<string, Rule>): Rule => ({ t: 'obj', fields });
const ENV = /^[A-Z][A-Z0-9_]{1,63}$/;

export const CONFIG_SCHEMA: Rule = obj({
  version: { t: 'const', value: 1 },
  experiment: obj({ mode: s({ enum: ['ontology_fixed', 'ontology_code'] }), label: s({ pattern: /^[A-Za-z0-9_.-]{1,64}$/ }) }),
  server: obj({ host: s({ enum: ['127.0.0.1', 'localhost', '::1'] }), port: i(1024, 65535) }),
  paths: obj({
    input_root: s(), output_root: s(), ontology_file: s(),
    context_file: s({ nullable: true }), approved_content_file: s(), pricing_file: s(),
  }),
  providers: obj({
    twelvelabs: obj({
      base_url: s({ pattern: /^https:\/\/[^\s?#]+$/ }), api_key_env: s({ pattern: ENV }), model: s({ enum: ['pegasus1.6'] }),
      upload_method: s({ enum: ['direct_asset'] }), direct_upload_limit_mb: n(1, 2000), poll_interval_ms: i(250, 60000),
      readiness_timeout_ms: i(1000, 3600000), request_timeout_ms: i(1000, 900000), max_output_tokens: i(64, 32768),
      disable_optional_hls_and_thumbnails: b,
    }),
    gemini: obj({
      api_key_env: s({ pattern: ENV }), planner_model_env: s({ pattern: ENV }), inspector_model_env: s({ pattern: ENV }),
      evidence_transport: s({ enum: ['inline_ordered_frames', 'files_api_video'] }), request_timeout_ms: i(1000, 900000),
      planner_max_output_tokens: i(64, 65536), inspector_max_output_tokens: i(64, 65536), temperature: n(0, 2),
    }),
  }),
  ontology: obj({
    backend: s({ enum: ['falkordb', 'json_snapshot'] }), host_env: s({ pattern: ENV }), port_env: s({ pattern: ENV }),
    username_env: s({ pattern: ENV }), password_env: s({ pattern: ENV }), tls_env: s({ pattern: ENV }),
    graph_prefix: s({ enum: ['striide_lab'] }), import_manifest: s(), require_import_verified: b,
    import_strategy: s({ enum: ['content_addressed'] }), recognition_overlay: s(),
    maximum_protocols_per_run: i(1, 10), maximum_questions_per_run: i(1, 60), query_timeout_ms: i(100, 60000),
  }),
  media: obj({
    ffmpeg_env: s({ pattern: ENV }), ffprobe_env: s({ pattern: ENV }), max_duration_seconds: n(1, 3600), max_file_size_mb: n(1, 4000),
    max_evidence_frames_total: i(1, 256), max_frames_per_packet: i(1, 64), max_total_inline_evidence_mb: n(0.5, 19),
    resize_for_provider_compatibility: b, preserve_aspect_ratio: b, generate_h264_playback_copy_if_needed: b,
  }),
  code_mode: obj({
    enabled: b, executor: s({ enum: ['deno_restricted'] }), deno_bin_env: s({ pattern: ENV }), reuse_reviewed_programs: b,
    max_planner_turns: i(0, 5), max_execution_segments: i(1, 32), max_tool_calls: i(1, 200),
    execution_segment_timeout_ms: i(500, 120000), max_stdout_bytes: i(1024, 4 * 1024 * 1024),
    expose_filesystem: { t: 'const', value: false }, expose_environment: { t: 'const', value: false },
  }),
  reference_search: obj({ enabled: { t: 'const', value: false }, index_id: s({ nullable: true }) }),
  budgets: obj({
    max_generated_model_requests: i(1, 50), max_followup_model_requests: i(0, 10), max_generation_attempts_including_retries: i(1, 100),
    max_job_wall_time_ms: i(10000, 7200000), max_concurrent_jobs: i(1, 1), max_retries_per_request: i(0, 5),
    max_http_attempts_per_job: i(1, 2000), require_known_prices: b, max_estimated_run_cost_usd: n(0, 1000, true),
  }),
  assessment: obj({
    experimental_scoring: b, require_reviewed_rubric: { t: 'const', value: true }, allow_pose_metrics: { t: 'const', value: false },
    narration: s({ enum: ['reviewed_templates'] }), preserve_unassessable_sections: { t: 'const', value: true },
  }),
  reports: obj({
    brand_directory: s(), include_internal_dashboard: b, athlete_exports_exclude_internal_data: { t: 'const', value: true },
    save_redacted_raw_artifacts: b, trace_format: s({ enum: ['jsonl'] }), write_metrics_csv: b, print_to_pdf: b,
  }),
  cache: obj({ reuse_provider_uploads: b, result_cache: b, cache_scope: s({ enum: ['content_plus_all_versions'] }) }),
});

export function validateAgainst(rule: Rule, value: unknown, path: string, errors: string[]): void {
  const nullable = 'nullable' in rule && rule.nullable;
  if (value === null && nullable) return;
  switch (rule.t) {
    case 'const': if (value !== rule.value) errors.push(`${path}: must be ${JSON.stringify(rule.value)}`); return;
    case 'bool': if (typeof value !== 'boolean') errors.push(`${path}: must be true or false`); return;
    case 'str':
      if (typeof value !== 'string' || value.length === 0) { errors.push(`${path}: must be a non-empty string${nullable ? ' or null' : ''}`); return; }
      if (rule.enum && !rule.enum.includes(value)) errors.push(`${path}: must be one of ${rule.enum.join(', ')}`);
      if (rule.pattern && !rule.pattern.test(value)) errors.push(`${path}: has an invalid format`);
      return;
    case 'int': case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value) || (rule.t === 'int' && !Number.isInteger(value))) { errors.push(`${path}: must be ${rule.t === 'int' ? 'an integer' : 'a number'}${nullable ? ' or null' : ''}`); return; }
      if (value < rule.min || value > rule.max) errors.push(`${path}: must be between ${rule.min} and ${rule.max}`);
      return;
    case 'obj': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path || '(root)'}: must be a mapping`); return; }
      for (const k of Object.keys(value)) if (!(k in rule.fields)) errors.push(`${path ? path + '.' : ''}${k}: unknown key`);
      for (const [k, r] of Object.entries(rule.fields)) {
        const child = (value as Record<string, unknown>)[k];
        if (child === undefined) { errors.push(`${path ? path + '.' : ''}${k}: missing`); continue; }
        validateAgainst(r, child, `${path ? path + '.' : ''}${k}`, errors);
      }
    }
  }
}
