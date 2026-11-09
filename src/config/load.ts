import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import YAML from 'yaml';
import { CONFIG_SCHEMA, validateAgainst } from './schema.js';
import { LabError } from '../util/errors.js';
import { hashObject } from '../util/hash.js';
import { PROJECT_ROOT } from '../util/paths.js';

export type Mode = 'ontology_fixed' | 'ontology_code';

export interface LabConfig {
  version: 1;
  experiment: { mode: Mode; label: string };
  server: { host: string; port: number };
  paths: { input_root: string; output_root: string; ontology_file: string; context_file: string | null; approved_content_file: string; pricing_file: string };
  providers: {
    twelvelabs: { base_url: string; api_key_env: string; model: 'pegasus1.6'; upload_method: 'direct_asset'; direct_upload_limit_mb: number; poll_interval_ms: number; readiness_timeout_ms: number; request_timeout_ms: number; max_output_tokens: number; disable_optional_hls_and_thumbnails: boolean };
    gemini: { api_key_env: string; planner_model_env: string; inspector_model_env: string; evidence_transport: 'inline_ordered_frames' | 'files_api_video'; request_timeout_ms: number; planner_max_output_tokens: number; inspector_max_output_tokens: number; temperature: number };
  };
  ontology: { backend: 'falkordb' | 'json_snapshot'; host_env: string; port_env: string; username_env: string; password_env: string; tls_env: string; graph_prefix: 'striide_lab'; import_manifest: string; require_import_verified: boolean; import_strategy: 'content_addressed'; recognition_overlay: string; maximum_protocols_per_run: number; maximum_questions_per_run: number; query_timeout_ms: number };
  media: { ffmpeg_env: string; ffprobe_env: string; max_duration_seconds: number; max_file_size_mb: number; max_evidence_frames_total: number; max_frames_per_packet: number; max_total_inline_evidence_mb: number; resize_for_provider_compatibility: boolean; preserve_aspect_ratio: boolean; generate_h264_playback_copy_if_needed: boolean };
  code_mode: { enabled: boolean; executor: 'deno_restricted'; deno_bin_env: string; reuse_reviewed_programs: boolean; max_planner_turns: number; max_execution_segments: number; max_tool_calls: number; execution_segment_timeout_ms: number; max_stdout_bytes: number; expose_filesystem: false; expose_environment: false };
  reference_search: { enabled: false; index_id: string | null };
  budgets: { max_generated_model_requests: number; max_followup_model_requests: number; max_generation_attempts_including_retries: number; max_job_wall_time_ms: number; max_concurrent_jobs: number; max_retries_per_request: number; max_http_attempts_per_job: number; require_known_prices: boolean; max_estimated_run_cost_usd: number | null };
  assessment: { experimental_scoring: boolean; require_reviewed_rubric: true; allow_pose_metrics: false; narration: 'reviewed_templates'; preserve_unassessable_sections: true };
  reports: { brand_directory: string; include_internal_dashboard: boolean; athlete_exports_exclude_internal_data: true; save_redacted_raw_artifacts: boolean; trace_format: 'jsonl'; write_metrics_csv: boolean; print_to_pdf: boolean };
  cache: { reuse_provider_uploads: boolean; result_cache: boolean; cache_scope: 'content_plus_all_versions' };
}

/** Values resolved from the environment. Secrets are never logged or serialised. */
export interface ResolvedEnv {
  twelvelabsKey: string | null;
  geminiKey: string | null;
  plannerModel: string | null;
  inspectorModel: string | null;
  falkor: { host: string | null; port: number | null; username: string | null; password: string | null; tls: boolean };
  ffmpeg: string;
  ffprobe: string;
  deno: string;
}

export interface LoadedConfig {
  config: LabConfig;
  configPath: string;
  baseDir: string;
  env: ResolvedEnv;
  /** Absolute paths resolved relative to the project root. */
  abs: { inputRoot: string; outputRoot: string; ontologyFile: string; contextFile: string | null; approvedContent: string; pricing: string; importManifest: string; overlay: string; brand: string };
  /** Hash of the resolved, secret-free configuration (provenance/caching). */
  resolvedConfigHash: string;
  /** Secret values for redaction in traces and artifacts. */
  secretValues: string[];
}

const GEMINI_MODEL_FORMAT = /^(models\/)?gemini-[a-z0-9.\-]+$/;

export function loadEnvFile(baseDir = PROJECT_ROOT): void {
  const envPath = resolve(baseDir, '.env');
  if (existsSync(envPath) && typeof (process as any).loadEnvFile === 'function') (process as any).loadEnvFile(envPath);
}

function envVal(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

export function resolveEnv(config: LabConfig): ResolvedEnv {
  const portRaw = envVal(config.ontology.port_env);
  const localDeno = resolve(PROJECT_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'deno.cmd' : 'deno');
  const denoEnv = envVal(config.code_mode.deno_bin_env);
  return {
    twelvelabsKey: envVal(config.providers.twelvelabs.api_key_env),
    geminiKey: envVal(config.providers.gemini.api_key_env),
    plannerModel: envVal(config.providers.gemini.planner_model_env),
    inspectorModel: envVal(config.providers.gemini.inspector_model_env),
    falkor: {
      host: envVal(config.ontology.host_env),
      port: portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : null,
      username: envVal(config.ontology.username_env),
      password: envVal(config.ontology.password_env),
      tls: (envVal(config.ontology.tls_env) ?? 'false').toLowerCase() === 'true',
    },
    ffmpeg: envVal(config.media.ffmpeg_env) ?? 'ffmpeg',
    ffprobe: envVal(config.media.ffprobe_env) ?? 'ffprobe',
    // A pinned Deno is installed as a dev dependency; an explicit DENO_BIN that is just "deno" falls back to it when not on PATH.
    deno: denoEnv && denoEnv !== 'deno' ? denoEnv : existsSync(localDeno) ? localDeno : 'deno',
  };
}

export function loadConfig(configPath: string, opts: { loadDotEnv?: boolean } = {}): LoadedConfig {
  const abs = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  if (!existsSync(abs)) throw new LabError('config', `Configuration file not found: ${configPath}. Copy config.example.yaml to config.local.yaml.`);
  let parsed: unknown;
  try { parsed = YAML.parse(readFileSync(abs, 'utf8'), { uniqueKeys: true }); }
  catch (e) { throw new LabError('config', `Configuration is not valid YAML: ${(e as Error).message}`); }
  const errors: string[] = [];
  validateAgainst(CONFIG_SCHEMA, parsed, '', errors);
  if (errors.length) throw new LabError('config', `Configuration is invalid:\n  - ${errors.join('\n  - ')}`, { details: { errors } });
  const config = parsed as LabConfig;
  if (config.media.max_frames_per_packet > config.media.max_evidence_frames_total) throw new LabError('config', 'media.max_frames_per_packet cannot exceed media.max_evidence_frames_total');
  if (config.budgets.max_followup_model_requests > config.budgets.max_generated_model_requests) throw new LabError('config', 'budgets.max_followup_model_requests cannot exceed max_generated_model_requests');
  if (config.budgets.max_generation_attempts_including_retries < config.budgets.max_generated_model_requests) throw new LabError('config', 'budgets.max_generation_attempts_including_retries must be at least max_generated_model_requests');
  const baseDir = PROJECT_ROOT;
  if (opts.loadDotEnv !== false) loadEnvFile(baseDir);
  const env = resolveEnv(config);
  const r = (p: string) => resolve(baseDir, p);
  const absPaths = {
    inputRoot: r(config.paths.input_root), outputRoot: r(config.paths.output_root), ontologyFile: r(config.paths.ontology_file),
    contextFile: config.paths.context_file ? r(config.paths.context_file) : null, approvedContent: r(config.paths.approved_content_file),
    pricing: r(config.paths.pricing_file), importManifest: r(config.ontology.import_manifest), overlay: r(config.ontology.recognition_overlay),
    brand: r(config.reports.brand_directory),
  };
  const secretValues = [env.twelvelabsKey, env.geminiKey, env.falkor.password].filter((x): x is string => !!x);
  const resolvedConfigHash = hashObject({ config, models: { planner: env.plannerModel, inspector: env.inspectorModel } });
  return { config, configPath: abs, baseDir, env, abs: absPaths, resolvedConfigHash, secretValues };
}

/** All missing inputs for the requested operation, reported together. */
export function missingInputs(lc: LoadedConfig, purpose: 'analyse' | 'smoke' | 'import' | 'doctor'): string[] {
  const { config, env } = lc;
  const missing: string[] = [];
  const needProviders = purpose === 'analyse' || purpose === 'smoke' || purpose === 'doctor';
  if (needProviders) {
    if (!env.twelvelabsKey) missing.push(`${config.providers.twelvelabs.api_key_env} (TwelveLabs API key) is not set`);
    if (!env.geminiKey) missing.push(`${config.providers.gemini.api_key_env} (Gemini API key) is not set`);
    if (!env.inspectorModel) missing.push(`${config.providers.gemini.inspector_model_env} (Gemini inspector model ID) is not set`);
    else if (!GEMINI_MODEL_FORMAT.test(env.inspectorModel)) missing.push(`${config.providers.gemini.inspector_model_env} does not look like a Gemini model ID`);
    const needPlanner = config.experiment.mode === 'ontology_code' && config.code_mode.enabled;
    if (needPlanner && !env.plannerModel) missing.push(`${config.providers.gemini.planner_model_env} (Gemini planner model ID, required for ontology_code) is not set`);
    else if (env.plannerModel && !GEMINI_MODEL_FORMAT.test(env.plannerModel)) missing.push(`${config.providers.gemini.planner_model_env} does not look like a Gemini model ID`);
  }
  if (config.ontology.backend === 'falkordb') {
    if (!env.falkor.host) missing.push(`${config.ontology.host_env} is not set`);
    if (!env.falkor.port) missing.push(`${config.ontology.port_env} is not set to a port number`);
    if (!env.falkor.password) missing.push(`${config.ontology.password_env} is not set`);
  }
  if (purpose === 'analyse' && config.ontology.backend === 'json_snapshot') missing.push('ontology.backend is json_snapshot: analysis requires the verified FalkorDB import (json_snapshot is diagnostics only)');
  return missing;
}
