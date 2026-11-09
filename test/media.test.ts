import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureClip, meanLuma, frameFromLuma, tmp, testTrace, FFMPEG, FFPROBE } from './helpers.js';
import { prepareMedia } from '../src/media/prepare.js';
import { extractPacket } from '../src/media/evidence.js';
import type { SeekMap } from '../src/media/probe.js';
import YAML from 'yaml';
import { fromRoot } from '../src/util/paths.js';

const mediaCfg = YAML.parse(readFileSync(fromRoot('config.example.yaml'), 'utf8')).media;

async function prepare(src: string, dir: string) {
  const trace = testTrace();
  const manifest = await trace.span('prepare', {}, (span) => prepareMedia({ sourcePath: src, originalName: 'clip.mp4', runDir: join(dir, 'run'), cfg: mediaCfg, ffmpeg: FFMPEG, ffprobe: FFPROBE, span }));
  return { manifest, trace };
}

test('VFR clip with non-zero start: evidence frames map to the exact source frame', async () => {
  const dir = tmp();
  const src = await makeFixtureClip(dir, { offset: 5, frames: 30 });
  const { manifest, trace } = await prepare(src, dir);
  assert.equal(manifest.timeline.variable_frame_rate, true);
  assert.ok(Math.abs(manifest.timeline.source_first_video_pts - 5) < 0.01, 'source start offset recorded');
  assert.ok(manifest.prepared.transforms.some((t) => t.includes('re-based')), 'non-zero start normalised for providers');
  const map: SeekMap = JSON.parse(readFileSync(manifest.prepared.seek_map_file, 'utf8'));
  assert.equal(map.frame_count, 30);
  // frame k is at k/30 + k^2/1500 seconds
  for (const k of [3, 17, 29]) assert.ok(Math.abs(map.frame_times[k]! - (k / 30 + (k * k) / 1500)) < 0.0015, `frame ${k} time`);
  const pkt = await extractPacket({ ffmpeg: FFMPEG, mediaFile: manifest.prepared.file, map, runDir: join(dir, 'run'), packetId: 'pk_t', windowId: null, label: 't', purpose: 'test', start: 0.5, end: 1.0, contextSeconds: 0, frames: 4, width: 160 });
  for (const f of pkt.frames) {
    const got = frameFromLuma(await meanLuma(f.file));
    assert.equal(got, f.frame_index, `extracted frame for t=${f.t.toFixed(3)} is frame ${got}, expected ${f.frame_index}`);
  }
  // Index/average-fps mapping would be wrong for this clip, demonstrating why a per-frame map is used.
  const naive = Math.round(map.frame_times[29]! * (map.avg_fps ?? 30));
  assert.notEqual(naive, 29);
  const names = trace.spans.map((s) => s.name);
  for (const n of ['hashing', 'source_snapshot', 'ffprobe', 'decode_check', 'resize_transcode']) assert.ok(names.includes(n), `span ${n}`);
});

test('352-pixel-wide input is upscaled for provider compatibility without claiming detail', async () => {
  const dir = tmp();
  const src = await makeFixtureClip(dir, { width: 352, height: 288, frames: 10, vfr: false });
  const { manifest } = await prepare(src, dir);
  assert.ok(Math.min(manifest.prepared.probe.video.display_width, manifest.prepared.probe.video.display_height) >= 360);
  assert.ok(manifest.prepared.transforms.some((t) => /upscaled.*adds no visual detail/.test(t)));
  assert.ok(manifest.notes.some((n) => /No detail was added/.test(n)));
});

test('HEVC source gets an H.264 browser playback copy with matching frame timeline', async () => {
  const dir = tmp();
  const src = await makeFixtureClip(dir, { codec: 'hevc', frames: 20, width: 640, height: 480 });
  const { manifest, trace } = await prepare(src, dir);
  assert.equal(manifest.prepared.probe.video.codec, 'hevc', 'provider-compatible HEVC is uploaded unchanged');
  assert.equal(manifest.playback.probe.video.codec, 'h264');
  assert.ok(trace.spans.some((s) => s.name === 'playback_transcode'));
  assert.ok(manifest.timeline.max_frame_time_deviation_s !== null && manifest.timeline.max_frame_time_deviation_s < 0.002);
  // playback frame k shows fixture frame k
  const pm: SeekMap = JSON.parse(readFileSync(manifest.playback.seek_map_file, 'utf8'));
  const l = await meanLuma(manifest.playback.file, pm.frame_times[12]! - 0.001 + 0.0005);
  assert.equal(frameFromLuma(l), 12);
});

test('rotated source is normalised and rotation recorded', async () => {
  const dir = tmp();
  const src = await makeFixtureClip(dir, { rotation: 90, frames: 10, vfr: false });
  const { manifest } = await prepare(src, dir);
  assert.equal(manifest.timeline.rotation_applied_deg, 90);
  assert.equal(manifest.prepared.probe.video.rotation_deg, 0);
  assert.equal(manifest.prepared.probe.video.display_width, 360);
});

test('corrupt file is rejected with a clear outcome and timed spans', async () => {
  const dir = tmp();
  const bad = join(dir, 'corrupt.mp4');
  writeFileSync(bad, Buffer.concat([Buffer.from('not really a video'), Buffer.alloc(4096, 7)]));
  const trace = testTrace();
  await assert.rejects(trace.span('prepare', {}, (span) => prepareMedia({ sourcePath: bad, originalName: 'corrupt.mp4', runDir: join(dir, 'run'), cfg: mediaCfg, ffmpeg: FFMPEG, ffprobe: FFPROBE, span })), (e: any) => e.kind === 'input_rejected');
  const failed = trace.spans.filter((s) => s.status === 'error').map((s) => s.name);
  assert.ok(failed.includes('ffprobe') && failed.includes('prepare'));
  assert.ok(trace.spans.every((s) => s.duration_ms >= 0));
});

test('truncated video fails the decode check', async () => {
  const dir = tmp();
  const src = await makeFixtureClip(dir, { frames: 60, vfr: false });
  const buf = readFileSync(src);
  const trunc = join(dir, 'trunc.mp4');
  writeFileSync(trunc, buf.subarray(0, Math.floor(buf.length * 0.6)));
  const trace = testTrace();
  await assert.rejects(trace.span('prepare', {}, (span) => prepareMedia({ sourcePath: trunc, originalName: 'trunc.mp4', runDir: join(dir, 'run'), cfg: mediaCfg, ffmpeg: FFMPEG, ffprobe: FFPROBE, span })), (e: any) => e.kind === 'input_rejected');
});
