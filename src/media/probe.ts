import { runProcess } from './proc.js';
import { LabError } from '../util/errors.js';

export interface ProbeInfo {
  format_name: string;
  container_start_time: number;
  duration: number;
  size_bytes: number;
  bit_rate: number | null;
  video: {
    index: number; codec: string; profile: string | null; pix_fmt: string | null; coded_width: number; coded_height: number;
    display_width: number; display_height: number; rotation_deg: number; avg_fps: number | null; r_fps: number | null;
    stream_start_time: number; nb_frames: number | null;
  };
  audio: { codec: string; channels: number | null; sample_rate: number | null } | null;
}

export interface SeekMap {
  media_role: 'source' | 'prepared';
  /** First presented video frame PTS in the file's own timebase (seconds). */
  first_video_pts: number;
  container_start_time: number;
  /** Frame presentation times relative to first_video_pts, ascending (seconds). */
  frame_times: number[];
  frame_count: number;
  duration: number;
  avg_fps: number | null;
  variable_frame_rate: boolean;
  interval_min: number | null;
  interval_max: number | null;
  rotation_deg: number;
  display_width: number;
  display_height: number;
}

const ratio = (s: string | undefined): number | null => {
  if (!s) return null; const [a, b] = s.split('/').map(Number);
  return a && b ? a / b : null;
};

export async function ffprobe(bin: string, file: string, signal?: AbortSignal): Promise<ProbeInfo> {
  const r = await runProcess(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000, signal, maxStdoutBytes: 8 * 1024 * 1024 });
  if (r.code !== 0) throw new LabError('input_rejected', 'The file could not be read as media (ffprobe failed). It may be corrupt or unsupported.', { details: { stderr: r.stderrTail.slice(-500) } });
  let j: any; try { j = JSON.parse(r.stdout.toString('utf8')); } catch { throw new LabError('input_rejected', 'ffprobe returned unreadable output.'); }
  const vs = (j.streams ?? []).find((s: any) => s.codec_type === 'video' && !(s.disposition?.attached_pic));
  if (!vs) throw new LabError('input_rejected', 'No video stream found in the file.');
  const as = (j.streams ?? []).find((s: any) => s.codec_type === 'audio');
  let rotation = 0;
  for (const sd of vs.side_data_list ?? []) if (typeof sd.rotation === 'number') rotation = sd.rotation;
  if (!rotation && vs.tags?.rotate) rotation = Number(vs.tags.rotate) || 0;
  rotation = ((Math.round(rotation) % 360) + 360) % 360;
  const cw = Number(vs.width), ch = Number(vs.height);
  const swap = rotation === 90 || rotation === 270;
  const duration = Number(j.format?.duration ?? vs.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new LabError('input_rejected', 'Media duration could not be determined.');
  return {
    format_name: String(j.format?.format_name ?? ''),
    container_start_time: Number(j.format?.start_time ?? 0) || 0,
    duration,
    size_bytes: Number(j.format?.size ?? 0),
    bit_rate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
    video: {
      index: vs.index, codec: vs.codec_name, profile: vs.profile ?? null, pix_fmt: vs.pix_fmt ?? null, coded_width: cw, coded_height: ch,
      display_width: swap ? ch : cw, display_height: swap ? cw : ch, rotation_deg: rotation, avg_fps: ratio(vs.avg_frame_rate), r_fps: ratio(vs.r_frame_rate),
      stream_start_time: Number(vs.start_time ?? 0) || 0, nb_frames: vs.nb_frames ? Number(vs.nb_frames) : null,
    },
    audio: as ? { codec: as.codec_name, channels: as.channels ?? null, sample_rate: as.sample_rate ? Number(as.sample_rate) : null } : null,
  };
}

/**
 * Build a seek map from packet presentation timestamps (no full decode). Frame index / average fps
 * is insufficient for variable-rate recordings, so every frame time is kept.
 */
export async function buildSeekMap(bin: string, file: string, info: ProbeInfo, role: SeekMap['media_role'], signal?: AbortSignal): Promise<SeekMap> {
  const r = await runProcess(bin, ['-v', 'error', '-select_streams', `${info.video.index}`, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { timeoutMs: 120000, signal, maxStdoutBytes: 64 * 1024 * 1024 });
  if (r.code !== 0) throw new LabError('media', 'Could not read frame timestamps.', { details: { stderr: r.stderrTail.slice(-500) } });
  const pts = r.stdout.toString('utf8').split(/\r?\n/).map((l) => parseFloat(l.split(',')[0]!)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!pts.length) throw new LabError('input_rejected', 'No decodable video frames were found.');
  const first = pts[0]!;
  const rel = pts.map((p) => Math.round((p - first) * 1e6) / 1e6);
  let imin: number | null = null, imax: number | null = null;
  for (let i = 1; i < rel.length; i++) { const d = rel[i]! - rel[i - 1]!; if (d <= 0) continue; imin = imin === null ? d : Math.min(imin, d); imax = imax === null ? d : Math.max(imax, d); }
  const vfr = imin !== null && imax !== null && imax / imin > 1.15;
  return {
    media_role: role, first_video_pts: first, container_start_time: info.container_start_time, frame_times: rel, frame_count: rel.length,
    duration: info.duration, avg_fps: info.video.avg_fps, variable_frame_rate: vfr, interval_min: imin, interval_max: imax,
    rotation_deg: info.video.rotation_deg, display_width: info.video.display_width, display_height: info.video.display_height,
  };
}

/** Index of the frame presented at time t (the last frame whose time is <= t). */
export function frameIndexAt(map: SeekMap, t: number): number {
  const ft = map.frame_times; let lo = 0, hi = ft.length - 1;
  if (t <= ft[0]!) return 0;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ft[mid]! <= t + 1e-9) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Evenly spaced actual frame indices within [start, end]. */
export function sampleFrames(map: SeekMap, start: number, end: number, count: number): number[] {
  const a = frameIndexAt(map, Math.max(0, start)), b = frameIndexAt(map, Math.max(start, end));
  if (count <= 1 || b <= a) return [Math.round((a + b) / 2)];
  const n = Math.min(count, b - a + 1);
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(Math.round(a + ((b - a) * i) / (n - 1)));
  return [...out].sort((x, y) => x - y);
}
