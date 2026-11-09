import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../src/media/proc.js';
import { TraceStore } from '../src/telemetry/trace.js';
import YAML from 'yaml';
import { fromRoot } from '../src/util/paths.js';

export const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

export function tmp(prefix = 'striide-test-'): string { return mkdtempSync(join(tmpdir(), prefix)); }

/**
 * Synthetic OFFLINE FIXTURE clip: frame N has luma ~= N*8, so any extracted frame can be identified.
 * Frame times are variable (interval grows), optionally offset, rotated, HEVC-encoded or low resolution.
 */
export async function makeFixtureClip(dir: string, o: { name?: string; frames?: number; width?: number; height?: number; offset?: number; rotation?: number; codec?: 'h264' | 'hevc'; vfr?: boolean; audio?: boolean; lumaStep?: number } = {}): Promise<string> {
  const frames = o.frames ?? 30, w = o.width ?? 320, h = o.height ?? 240;
  const out = join(dir, o.name ?? 'fixture.mp4');
  const setpts = o.vfr === false ? 'N/(30*TB)' : 'N*N/(1500*TB)+N/(30*TB)';
  const args = ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=30:d=${(frames / 30).toFixed(4)},format=gray,geq=lum='N*${o.lumaStep ?? 8}':cb=128:cr=128,settb=expr=1/1000,setpts=${setpts}`];
  if (o.audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2');
  args.push('-fps_mode', 'passthrough', '-enc_time_base', '1/1000', '-bf', '0', '-pix_fmt', 'yuv420p');
  args.push('-c:v', o.codec === 'hevc' ? 'libx265' : 'libx264');
  if (o.codec === 'hevc') args.push('-tag:v', 'hvc1', '-x265-params', 'log-level=error');
  if (o.audio) args.push('-c:a', 'aac', '-shortest');
  args.push('-video_track_timescale', '1000');
  if (o.offset) args.push('-output_ts_offset', String(o.offset));
  args.push(out);
  const r = await runProcess(FFMPEG, args, { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error('fixture generation failed: ' + r.stderrTail);
  if (o.rotation) {
    const rot = join(dir, 'rot-' + (o.name ?? 'fixture.mp4'));
    const r2 = await runProcess(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-display_rotation', String(o.rotation), '-i', out, '-c', 'copy', rot], { timeoutMs: 60000 });
    if (r2.code !== 0) throw new Error('rotation failed: ' + r2.stderrTail);
    return rot;
  }
  return out;
}

/** Mean luma of an image/video frame file, used to identify which fixture frame was extracted. */
export async function meanLuma(file: string, ss?: number): Promise<number> {
  const args = ['-hide_banner', '-v', 'error'];
  if (ss !== undefined) args.push('-ss', String(ss));
  args.push('-i', file, '-frames:v', '1', '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-');
  const r = await runProcess(FFMPEG, args, { timeoutMs: 30000 });
  const b = r.stdout; let s = 0; for (const x of b) s += x; return s / b.length;
}

export function frameFromLuma(l: number): number { return Math.round(l / 8); }

export function testTrace(runId = 'test-run'): TraceStore { return new TraceStore({ runId }); }

/** A test configuration derived from config.example.yaml with local overrides. */
export function writeTestConfig(dir: string, patch: (c: any) => void = () => {}): string {
  const c = YAML.parse(readFileSync(fromRoot('config.example.yaml'), 'utf8'));
  c.paths.input_root = join(dir, 'inputs');
  c.paths.output_root = join(dir, 'runs');
  c.ontology.import_manifest = join(dir, 'ontology-import.test.json');
  mkdirSync(c.paths.input_root, { recursive: true });
  patch(c);
  const f = join(dir, 'config.test.yaml');
  writeFileSync(f, YAML.stringify(c));
  return f;
}
