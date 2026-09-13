import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compileTimeline } from '../src/timeline.mjs';
import { premiereXml } from '../src/premiere-xml.mjs';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message || result.stderr}`);
  return result.stdout;
}
const root = resolve('artifacts/m0');
await mkdir(root, { recursive: true });
const started = performance.now();
const sources = {};
for (const [id, color, frequency] of [['first', 'blue', 440], ['second', 'green', 880]]) {
  const path = resolve(root, `${id}.mov`);
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1920x1080:r=30:d=3`, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=3`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', path]);
  sources[id] = { path, fps: 30, frames: 90 };
}
const timeline = compileTimeline([{ sourceId: 'first', inFrame: 30, outFrame: 90 }, { sourceId: 'second', inFrame: 0, outFrame: 45 }], sources);
await writeFile(resolve(root, 'timeline.json'), JSON.stringify({ sources, timeline }, null, 2));
await writeFile(resolve(root, 'premiere.xml'), premiereXml(timeline, sources));
const filters = timeline.intervals.flatMap((clip, i) => [
  `[${i}:v]trim=start_frame=${clip.inFrame}:end_frame=${clip.outFrame},setpts=PTS-STARTPTS,scale=960:540[v${i}]`,
  `[${i}:a]atrim=start_sample=${clip.inFrame * 1600}:end_sample=${clip.outFrame * 1600},asetpts=PTS-STARTPTS[a${i}]`
]);
filters.push('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]');
const preview = resolve(root, 'preview.mp4');
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...timeline.intervals.flatMap(clip => ['-i', sources[clip.sourceId].path]), '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', preview]);
const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', preview]));
const video = probe.streams.find(stream => stream.codec_type === 'video');
const audio = probe.streams.find(stream => stream.codec_type === 'audio');
if (Number(video.nb_read_frames) !== 105 || Math.abs(Number(audio.duration) - 3.5) > 1 / 48000) throw new Error('Preview frame/audio duration mismatch');
const results = { generatedAt: new Date().toISOString(), elapsedSeconds: (performance.now() - started) / 1000, expectedFrames: 105, actualFrames: Number(video.nb_read_frames), audioDuration: Number(audio.duration), expectedJoinSeconds: 2, xmlImportVerified: false, realSpeechVerified: false, note: 'Synthetic constant-rate timing experiment only; not a processing-ratio benchmark or Premiere compatibility proof.' };
await writeFile(resolve(root, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ ...results, outputDirectory: root }, null, 2));
