import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from './proc.js';
import { frameIndexAt, sampleFrames, type SeekMap } from './probe.js';
import { LabError } from '../util/errors.js';
import { sha256Hex } from '../util/hash.js';

export interface EvidenceFrame {
  evidence_id: string;
  packet_id: string;
  frame_index: number;
  /** Seconds from the first presented source frame. */
  t: number;
  file: string; // absolute, internal only
  rel_path: string; // relative to the run directory
  bytes: number;
  width: number;
  sha256: string;
}

export interface EvidencePacket {
  packet_id: string;
  window_id: string | null;
  label: string;
  start_seconds: number;
  end_seconds: number;
  context_start_seconds: number;
  context_end_seconds: number;
  frames: EvidenceFrame[];
  purpose: string;
}

/** Seek target slightly before the frame's own time so accurate seeking returns exactly that frame. */
export function seekTargetFor(map: SeekMap, index: number): number {
  const t = map.frame_times[index]!;
  if (index === 0) return 0;
  const prev = map.frame_times[index - 1]!;
  return t - (t - prev) * 0.25;
}

export async function extractFrame(ffmpeg: string, media: string, map: SeekMap, index: number, out: string, width: number, signal?: AbortSignal): Promise<{ bytes: number }> {
  // ffmpeg input seeking is relative to the container start time (timestamps are shifted unless -copyts).
  const ss = Math.max(0, seekTargetFor(map, index) + map.first_video_pts - map.container_start_time);
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-ss', ss.toFixed(6), '-i', media, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '4', out];
  const r = await runProcess(ffmpeg, args, { timeoutMs: 60000, signal, maxStdoutBytes: 1024 * 1024 });
  if (r.code !== 0) throw new LabError('media', 'Evidence frame extraction failed.', { details: { stderr: r.stderrTail.slice(-400) } });
  return { bytes: statSync(out).size };
}

/**
 * Extract an ordered packet of actual frames for a window with surrounding context.
 * Frames are chosen from real frame timestamps (VFR-safe), never index / average fps.
 */
export async function extractPacket(opts: {
  ffmpeg: string; mediaFile: string; map: SeekMap; runDir: string; packetId: string; windowId: string | null; label: string; purpose: string;
  start: number; end: number; contextSeconds: number; frames: number; width: number; signal?: AbortSignal;
}): Promise<EvidencePacket> {
  const dur = opts.map.frame_times[opts.map.frame_times.length - 1]!;
  const s = Math.max(0, Math.min(opts.start, dur)), e = Math.max(s, Math.min(opts.end, dur));
  const cs = Math.max(0, s - opts.contextSeconds), ce = Math.min(dur, e + opts.contextSeconds);
  const idx = sampleFrames(opts.map, cs, ce, opts.frames);
  const dir = join(opts.runDir, 'evidence'); mkdirSync(dir, { recursive: true });
  const frames: EvidenceFrame[] = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]!;
    const name = `${opts.packetId}_f${String(k + 1).padStart(2, '0')}.jpg`;
    const file = join(dir, name);
    const { bytes } = await extractFrame(opts.ffmpeg, opts.mediaFile, opts.map, i, file, opts.width, opts.signal);
    frames.push({ evidence_id: `${opts.packetId}_f${String(k + 1).padStart(2, '0')}`, packet_id: opts.packetId, frame_index: i, t: opts.map.frame_times[i]!, file, rel_path: `evidence/${name}`, bytes, width: opts.width, sha256: sha256Hex(readFileSync(file)) });
  }
  return { packet_id: opts.packetId, window_id: opts.windowId, label: opts.label, start_seconds: s, end_seconds: e, context_start_seconds: cs, context_end_seconds: ce, frames, purpose: opts.purpose };
}

export { frameIndexAt };
