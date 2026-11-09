import { copyFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { runProcess } from './proc.js';
import { ffprobe, buildSeekMap, type ProbeInfo, type SeekMap } from './probe.js';
import { sha256File } from '../util/hash.js';
import { newId } from '../util/ids.js';
import { LabError } from '../util/errors.js';
import type { SpanContext } from '../telemetry/trace.js';
import type { LabConfig } from '../config/load.js';

/**
 * Provider-compatibility assumptions for this lab. These are conservative local guardrails,
 * not claims about every account's limits; provider:smoke verifies real acceptance.
 */
export const PROVIDER_MEDIA_RULES = {
  min_side_px: 360,
  max_long_side_px: 3840,
  max_short_side_px: 2160,
  provider_codecs: ['h264', 'hevc'],
  provider_containers: ['mov,mp4,m4a,3gp,3g2,mj2'],
  browser_codecs: ['h264'],
};

export interface MediaRecord {
  media_id: string;
  role: 'source_snapshot' | 'prepared' | 'playback';
  file: string; // absolute; never exposed to tools, exports or the browser
  file_name: string; // neutral name inside the run directory
  sha256: string;
  bytes: number;
  mime: string;
  probe: ProbeInfo;
  seek_map_file: string;
  transforms: string[];
}

export interface MediaManifest {
  source: { original_name: string; sha256_before: string; sha256_after: string; bytes: number; mtime_utc: string; snapshot_sha256: string };
  snapshot: MediaRecord;
  prepared: MediaRecord;
  playback: MediaRecord;
  /** Prepared/playback times equal source times measured from the first presented source frame. */
  timeline: { unit: 'seconds_from_first_source_frame'; source_first_video_pts: number; source_container_start: number; prepared_offset_s: number; playback_offset_s: number; max_frame_time_deviation_s: number | null; variable_frame_rate: boolean; rotation_applied_deg: number };
  provider_upload_name: string;
  notes: string[];
}

const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

function targetDimensions(w: number, h: number, cfg: LabConfig['media']): { w: number; h: number; reason: string | null } {
  if (!cfg.resize_for_provider_compatibility) return { w, h, reason: null };
  const short = Math.min(w, h), long = Math.max(w, h);
  let scale = 1, reason: string | null = null;
  if (short < PROVIDER_MEDIA_RULES.min_side_px) { scale = PROVIDER_MEDIA_RULES.min_side_px / short; reason = `upscaled from ${w}x${h} to meet the ${PROVIDER_MEDIA_RULES.min_side_px}px provider minimum; this adds no visual detail`; }
  else if (long > PROVIDER_MEDIA_RULES.max_long_side_px || short > PROVIDER_MEDIA_RULES.max_short_side_px) { scale = Math.min(PROVIDER_MEDIA_RULES.max_long_side_px / long, PROVIDER_MEDIA_RULES.max_short_side_px / short); reason = `downscaled from ${w}x${h} to the provider maximum`; }
  const tw = even(w * scale), th = even(h * scale);
  if (tw === w && th === h) return { w, h, reason: null };
  return { w: tw, h: th, reason: reason ?? `adjusted to even dimensions ${tw}x${th}` };
}

async function transcodeH264(ffmpeg: string, input: string, output: string, probe: ProbeInfo, dims: { w: number; h: number }, signal?: AbortSignal): Promise<void> {
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', input, '-map', `0:${probe.video.index}`, '-map', '0:a:0?',
    // passthrough keeps each original frame's timing (variable frame rate is preserved, not resampled)
    '-fps_mode', 'passthrough', '-enc_time_base', 'demux', '-vf', `scale=${dims.w}:${dims.h}:flags=bicubic,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-c:a', probe.audio?.codec === 'aac' ? 'copy' : 'aac', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-map_metadata', '-1', output];
  const r = await runProcess(ffmpeg, args, { timeoutMs: 30 * 60 * 1000, signal, maxStdoutBytes: 1024 * 1024 });
  if (r.code !== 0) throw new LabError('media', 'Transcoding failed.', { details: { stderr: r.stderrTail.slice(-800) } });
}

function mimeFor(probe: ProbeInfo): string { return /mp4|mov/.test(probe.format_name) ? 'video/mp4' : /webm|matroska/.test(probe.format_name) ? 'video/webm' : 'application/octet-stream'; }

export async function prepareMedia(opts: { sourcePath: string; originalName: string; runDir: string; cfg: LabConfig['media']; ffmpeg: string; ffprobe: string; span: SpanContext; signal?: AbortSignal }): Promise<MediaManifest> {
  const { sourcePath, runDir, cfg, span, signal } = opts;
  const mediaDir = join(runDir, 'media'); mkdirSync(mediaDir, { recursive: true });
  const notes: string[] = [];
  const st = statSync(sourcePath);
  if (st.size > cfg.max_file_size_mb * 1024 * 1024) throw new LabError('input_rejected', `File is larger than the ${cfg.max_file_size_mb} MB lab limit.`);

  // Snapshot: hash the original, copy it into the immutable run folder, then re-hash both.
  const before = await span.child('hashing', { target: 'source_before' }, async (c) => { const h = await sha256File(sourcePath); c.set({ bytes: h.bytes }); return h; });
  const snapExt = extname(sourcePath).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6) || '.bin';
  const snapPath = join(mediaDir, `source${snapExt}`);
  await span.child('source_snapshot', { bytes: before.bytes }, () => copyFileSync(sourcePath, snapPath));
  const [snapHash, after] = await span.child('hashing', { target: 'snapshot_and_source_after' }, () => Promise.all([sha256File(snapPath), sha256File(sourcePath)]));
  if (snapHash.sha256 !== before.sha256 || after.sha256 !== before.sha256) throw new LabError('input_rejected', 'The source file changed while it was being read. Re-run once the file is stable.');

  const probe = await span.child('ffprobe', { media: 'source_snapshot' }, async (c) => { const p = await ffprobe(opts.ffprobe, snapPath, signal); c.set({ codec: p.video.codec, width: p.video.display_width, height: p.video.display_height, duration_s: p.duration, rotation: p.video.rotation_deg, start_time: p.container_start_time }); return p; });
  if (probe.duration > cfg.max_duration_seconds) throw new LabError('input_rejected', `Clip is ${probe.duration.toFixed(1)} s; the lab limit is ${cfg.max_duration_seconds} s.`);

  await span.child('decode_check', { media: 'source_snapshot' }, async (c) => {
    const r = await runProcess(opts.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', snapPath, '-map', `0:${probe.video.index}`, '-f', 'null', '-'], { timeoutMs: 10 * 60 * 1000, signal, maxStdoutBytes: 1024 * 1024 });
    c.set({ exit_code: r.code, decode_ms: r.durationMs });
    if (r.code !== 0) throw new LabError('input_rejected', 'The video stream could not be decoded cleanly; the file may be corrupt or truncated.', { details: { stderr: r.stderrTail.slice(-500) } });
  });

  const sourceMap = await span.child('ffprobe', { media: 'source_snapshot', purpose: 'seek_map' }, () => buildSeekMap(opts.ffprobe, snapPath, probe, 'source', signal));
  const writeMap = (name: string, map: SeekMap) => { const f = join(mediaDir, name); writeFileSync(f, JSON.stringify(map)); return f; };
  const snapshot: MediaRecord = { media_id: newId('med'), role: 'source_snapshot', file: snapPath, file_name: `source${snapExt}`, sha256: snapHash.sha256, bytes: snapHash.bytes, mime: mimeFor(probe), probe, seek_map_file: writeMap('source.seekmap.json', sourceMap), transforms: [] };

  // Provider-prepared media.
  const dims = targetDimensions(probe.video.display_width, probe.video.display_height, cfg);
  const zeroStart = Math.abs(sourceMap.first_video_pts) < 1e-3;
  const providerOk = PROVIDER_MEDIA_RULES.provider_codecs.includes(probe.video.codec) && PROVIDER_MEDIA_RULES.provider_containers.includes(probe.format_name) && !dims.reason && zeroStart && probe.video.rotation_deg === 0;
  let prepared: MediaRecord;
  if (providerOk) {
    prepared = { ...snapshot, media_id: newId('med'), role: 'prepared', transforms: ['none (source already provider-compatible)'] };
  } else {
    const out = join(mediaDir, 'prepared.mp4');
    const transforms = ['h264/yuv420p transcode (CRF 18, no enhancement or interpolation)', 'timestamps re-based to first presented frame', 'frame timing passthrough (no resampling)'];
    if (dims.reason) transforms.push(dims.reason);
    if (probe.video.rotation_deg) transforms.push(`display rotation ${probe.video.rotation_deg}° applied to pixels`);
    if (probe.audio) transforms.push(probe.audio.codec === 'aac' ? 'audio stream copied' : `audio ${probe.audio.codec} -> aac`);
    await span.child('resize_transcode', { from_codec: probe.video.codec, width: dims.w, height: dims.h, reason: dims.reason ?? 'codec/container/timestamp normalisation' }, () => transcodeH264(opts.ffmpeg, snapPath, out, probe, dims, signal));
    const p2 = await span.child('ffprobe', { media: 'prepared' }, () => ffprobe(opts.ffprobe, out, signal));
    const h = await span.child('hashing', { target: 'prepared' }, () => sha256File(out));
    const map = await buildSeekMap(opts.ffprobe, out, p2, 'prepared', signal);
    prepared = { media_id: newId('med'), role: 'prepared', file: out, file_name: 'prepared.mp4', sha256: h.sha256, bytes: h.bytes, mime: 'video/mp4', probe: p2, seek_map_file: writeMap('prepared.seekmap.json', map), transforms };
    if (dims.reason?.startsWith('upscaled')) notes.push('Low-resolution source was upscaled only for provider compatibility. No detail was added; observations remain limited by the original resolution.');
  }

  // Browser playback copy.
  let playback: MediaRecord;
  const browserOk = PROVIDER_MEDIA_RULES.browser_codecs.includes(prepared.probe.video.codec) && /mp4/.test(prepared.probe.format_name) && (prepared.probe.video.pix_fmt === 'yuv420p' || prepared.probe.video.pix_fmt === 'yuvj420p') && prepared.probe.video.rotation_deg === 0;
  if (browserOk || !cfg.generate_h264_playback_copy_if_needed) {
    playback = { ...prepared, media_id: newId('med'), role: 'playback' };
    if (!browserOk) notes.push('Playback copy generation is disabled; the browser may not play this codec.');
  } else {
    const out = join(mediaDir, 'playback.mp4');
    await span.child('playback_transcode', { from_codec: prepared.probe.video.codec }, () => transcodeH264(opts.ffmpeg, prepared.file, out, prepared.probe, { w: even(prepared.probe.video.display_width), h: even(prepared.probe.video.display_height) }, signal));
    const p3 = await ffprobe(opts.ffprobe, out, signal);
    const h = await sha256File(out);
    const map = await buildSeekMap(opts.ffprobe, out, p3, 'prepared', signal);
    playback = { media_id: newId('med'), role: 'playback', file: out, file_name: 'playback.mp4', sha256: h.sha256, bytes: h.bytes, mime: 'video/mp4', probe: p3, seek_map_file: writeMap('playback.seekmap.json', map), transforms: [`browser H.264 playback copy of ${prepared.probe.video.codec}`, 'frame timing passthrough'] };
  }

  // Verify that prepared and playback timelines match the source frame timeline.
  const { readFileSync } = await import('node:fs');
  const pm: SeekMap = JSON.parse(readFileSync(prepared.seek_map_file, 'utf8'));
  const bm: SeekMap = JSON.parse(readFileSync(playback.seek_map_file, 'utf8'));
  let maxDev: number | null = null;
  if (pm.frame_count === sourceMap.frame_count && bm.frame_count === sourceMap.frame_count) {
    maxDev = 0;
    for (let i = 0; i < sourceMap.frame_count; i++) maxDev = Math.max(maxDev, Math.abs(pm.frame_times[i]! - sourceMap.frame_times[i]!), Math.abs(bm.frame_times[i]! - sourceMap.frame_times[i]!));
  } else {
    notes.push(`Frame counts differ after normalisation (source ${sourceMap.frame_count}, prepared ${pm.frame_count}, playback ${bm.frame_count}); evidence times are mapped by timestamp, not index.`);
  }
  if (maxDev !== null && maxDev > 0.002) notes.push(`Timestamp deviation up to ${(maxDev * 1000).toFixed(1)} ms between source and prepared frames.`);
  if (sourceMap.variable_frame_rate) notes.push('Variable frame rate recording: evidence is mapped using every frame timestamp.');

  return {
    source: { original_name: opts.originalName, sha256_before: before.sha256, sha256_after: after.sha256, bytes: before.bytes, mtime_utc: st.mtime.toISOString(), snapshot_sha256: snapHash.sha256 },
    snapshot, prepared, playback,
    timeline: { unit: 'seconds_from_first_source_frame', source_first_video_pts: sourceMap.first_video_pts, source_container_start: sourceMap.container_start_time, prepared_offset_s: pm.first_video_pts, playback_offset_s: bm.first_video_pts, max_frame_time_deviation_s: maxDev, variable_frame_rate: sourceMap.variable_frame_rate, rotation_applied_deg: probe.video.rotation_deg },
    provider_upload_name: `clip-${prepared.sha256.slice(0, 12)}.mp4`,
    notes,
  };
}
