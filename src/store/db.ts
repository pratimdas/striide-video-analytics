import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SpanRecord } from '../telemetry/trace.js';
import type { CallRecord } from '../telemetry/ledger.js';

export type RunState = 'queued' | 'preparing' | 'uploading' | 'waiting_for_asset' | 'discovering' | 'comparing' | 'inspecting' | 'assessing' | 'reporting' | 'finished';
export type RunOutcome = 'completed' | 'completed_partial' | 'needs_context' | 'rejected' | 'failed' | 'cancelled';
export type CacheKind = 'cold' | 'warm_asset' | 'result_cache_hit' | 'resumed';

export interface RunRow {
  run_id: string; created_at: string; case_id: string | null; mode: string; label: string; state: RunState; outcome: RunOutcome | null;
  source_name: string; source_sha256: string | null; prepared_sha256: string | null; clip_key: string | null; config_hash: string; ontology_hash: string | null;
  graph_name: string | null; run_dir: string; wall_ms: number | null; cache_kind: CacheKind; reused_from_run: string | null; error_kind: string | null; error_message: string | null;
  report_version: number; context_declared: number; finished_at: string | null;
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, case_id TEXT, mode TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT,
  source_name TEXT NOT NULL, source_sha256 TEXT, prepared_sha256 TEXT, clip_key TEXT, config_hash TEXT NOT NULL, ontology_hash TEXT, graph_name TEXT,
  run_dir TEXT NOT NULL, wall_ms REAL, cache_kind TEXT NOT NULL DEFAULT 'cold', reused_from_run TEXT, error_kind TEXT, error_message TEXT,
  report_version INTEGER NOT NULL DEFAULT 0, context_declared INTEGER NOT NULL DEFAULT 0, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS run_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, ts TEXT NOT NULL, elapsed_ms REAL NOT NULL, state TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, trace_id TEXT NOT NULL, parent_span_id TEXT, name TEXT NOT NULL, start_utc TEXT, end_utc TEXT,
  start_offset_ms REAL, end_offset_ms REAL, duration_ms REAL, status TEXT NOT NULL, attributes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spans_run ON spans(run_id);
CREATE TABLE IF NOT EXISTS calls (call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asset_cache (
  provider TEXT NOT NULL, account_fingerprint TEXT NOT NULL, prepared_sha256 TEXT NOT NULL, options_hash TEXT NOT NULL, asset_id TEXT NOT NULL,
  created_at TEXT NOT NULL, last_verified_at TEXT, owner_run TEXT NOT NULL, deleted_at TEXT, delete_status TEXT,
  PRIMARY KEY (provider, account_fingerprint, prepared_sha256, options_hash)
);
CREATE TABLE IF NOT EXISTS result_cache (cache_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, report_version INTEGER NOT NULL, report_sha256 TEXT NOT NULL, target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL, correction TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS programs (program_sha256 TEXT PRIMARY KEY, source TEXT NOT NULL, origin TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
`;

export class LabDb {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }
  static open(outputRoot: string): LabDb { return new LabDb(join(outputRoot, 'lab.sqlite')); }
  close(): void { this.db.close(); }

  insertRun(r: Omit<RunRow, 'wall_ms' | 'error_kind' | 'error_message' | 'finished_at' | 'report_version'> & Partial<RunRow>): void {
    this.db.prepare(`INSERT INTO runs (run_id, created_at, case_id, mode, label, state, outcome, source_name, source_sha256, prepared_sha256, clip_key, config_hash, ontology_hash, graph_name, run_dir, cache_kind, reused_from_run, context_declared)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.run_id, r.created_at, r.case_id ?? null, r.mode, r.label, r.state, r.outcome ?? null, r.source_name, r.source_sha256 ?? null, r.prepared_sha256 ?? null, r.clip_key ?? null, r.config_hash, r.ontology_hash ?? null, r.graph_name ?? null, r.run_dir, r.cache_kind, r.reused_from_run ?? null, r.context_declared);
  }
  updateRun(runId: string, patch: Partial<RunRow>): void {
    const keys = Object.keys(patch).filter((k) => /^[a-z_0-9]+$/.test(k));
    if (!keys.length) return;
    this.db.prepare(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE run_id = ?`).run(...keys.map((k) => (patch as any)[k] ?? null), runId);
  }
  getRun(runId: string): RunRow | undefined { return this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as unknown as RunRow | undefined; }
  listRuns(limit = 200): RunRow[] { return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as RunRow[]; }
  runsForClip(clipKey: string): RunRow[] { return this.db.prepare('SELECT * FROM runs WHERE clip_key = ? ORDER BY created_at').all(clipKey) as unknown as RunRow[]; }
  runsForSource(sha: string): RunRow[] { return this.db.prepare('SELECT * FROM runs WHERE source_sha256 = ? ORDER BY created_at').all(sha) as unknown as RunRow[]; }
  unfinishedRuns(): RunRow[] { return this.db.prepare("SELECT * FROM runs WHERE outcome IS NULL").all() as unknown as RunRow[]; }

  addEvent(runId: string, elapsedMs: number, state: string, detail: string | null): void {
    this.db.prepare('INSERT INTO run_events (run_id, ts, elapsed_ms, state, detail) VALUES (?,?,?,?,?)').run(runId, new Date().toISOString(), elapsedMs, state, detail);
  }
  events(runId: string): Array<{ ts: string; elapsed_ms: number; state: string; detail: string | null }> {
    return this.db.prepare('SELECT ts, elapsed_ms, state, detail FROM run_events WHERE run_id = ? ORDER BY id').all(runId) as any;
  }
  upsertSpan(s: SpanRecord): void {
    this.db.prepare(`INSERT OR REPLACE INTO spans (span_id, run_id, trace_id, parent_span_id, name, start_utc, end_utc, start_offset_ms, end_offset_ms, duration_ms, status, attributes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(s.span_id, s.run_id, s.trace_id, s.parent_span_id, s.name, s.start_utc, s.end_utc, s.start_offset_ms, s.end_offset_ms, s.duration_ms, s.status, JSON.stringify(s.attributes));
  }
  insertSpanStart(e: { span_id: string; run_id: string; trace_id: string; parent_span_id: string | null; name: string; start_utc: string; start_offset_ms: number; attributes: Record<string, unknown> }): void {
    this.db.prepare(`INSERT OR IGNORE INTO spans (span_id, run_id, trace_id, parent_span_id, name, start_utc, start_offset_ms, status, attributes) VALUES (?,?,?,?,?,?,?,'open',?)`)
      .run(e.span_id, e.run_id, e.trace_id, e.parent_span_id, e.name, e.start_utc, e.start_offset_ms, JSON.stringify(e.attributes));
  }
  spans(runId: string): SpanRecord[] {
    return (this.db.prepare("SELECT * FROM spans WHERE run_id = ? AND status != 'open' ORDER BY start_offset_ms").all(runId) as any[]).map((r) => ({ event: 'span_end', ...r, attributes: JSON.parse(r.attributes) }));
  }
  insertCall(runId: string, c: CallRecord): void { this.db.prepare('INSERT OR REPLACE INTO calls (call_id, run_id, record) VALUES (?,?,?)').run(c.call_id, runId, JSON.stringify(c)); }
  calls(runId: string): CallRecord[] { return (this.db.prepare('SELECT record FROM calls WHERE run_id = ?').all(runId) as any[]).map((r) => JSON.parse(r.record)); }

  findAsset(provider: string, account: string, prepared: string, optionsHash: string): { asset_id: string; owner_run: string; created_at: string } | undefined {
    return this.db.prepare('SELECT asset_id, owner_run, created_at FROM asset_cache WHERE provider=? AND account_fingerprint=? AND prepared_sha256=? AND options_hash=? AND deleted_at IS NULL').get(provider, account, prepared, optionsHash) as any;
  }
  saveAsset(provider: string, account: string, prepared: string, optionsHash: string, assetId: string, ownerRun: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO asset_cache (provider, account_fingerprint, prepared_sha256, options_hash, asset_id, created_at, last_verified_at, owner_run) VALUES (?,?,?,?,?,?,?,?)`)
      .run(provider, account, prepared, optionsHash, assetId, new Date().toISOString(), new Date().toISOString(), ownerRun);
  }
  markAssetVerified(assetId: string): void { this.db.prepare('UPDATE asset_cache SET last_verified_at=? WHERE asset_id=?').run(new Date().toISOString(), assetId); }
  markAssetDeleted(assetId: string, status: string): void { this.db.prepare('UPDATE asset_cache SET deleted_at=?, delete_status=? WHERE asset_id=?').run(new Date().toISOString(), status, assetId); }
  ownedAssets(provider: string, account: string): Array<{ asset_id: string; owner_run: string; prepared_sha256: string }> {
    return this.db.prepare('SELECT asset_id, owner_run, prepared_sha256 FROM asset_cache WHERE provider=? AND account_fingerprint=? AND deleted_at IS NULL').all(provider, account) as any;
  }

  getResultCache(key: string): string | undefined { return (this.db.prepare('SELECT run_id FROM result_cache WHERE cache_key=?').get(key) as any)?.run_id; }
  putResultCache(key: string, runId: string): void { this.db.prepare('INSERT OR REPLACE INTO result_cache (cache_key, run_id, created_at) VALUES (?,?,?)').run(key, runId, new Date().toISOString()); }
  clearResultCache(): number { return Number(this.db.prepare('DELETE FROM result_cache').run().changes); }

  addFeedback(f: { run_id: string; report_version: number; report_sha256: string; target_kind: string; target_id: string; correction: unknown; note: string | null }): number {
    const r = this.db.prepare('INSERT INTO feedback (run_id, report_version, report_sha256, target_kind, target_id, correction, note, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(f.run_id, f.report_version, f.report_sha256, f.target_kind, f.target_id, JSON.stringify(f.correction), f.note, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }
  feedback(runId: string): any[] { return (this.db.prepare('SELECT * FROM feedback WHERE run_id = ? ORDER BY id').all(runId) as any[]).map((r) => ({ ...r, correction: JSON.parse(r.correction) })); }

  saveProgram(sha: string, source: string, origin: string): void {
    this.db.prepare('INSERT OR IGNORE INTO programs (program_sha256, source, origin, created_at) VALUES (?,?,?,?)').run(sha, source, origin, new Date().toISOString());
  }
}
