import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compileTimeline } from '../src/timeline.mjs';
import { premiereXml } from '../src/premiere-xml.mjs';

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(result.error?.message || result.stderr);
  return result.stdout;
};
const root = resolve('artifacts/sample');
const probe = JSON.parse(await readFile(`${root}/media.json`, 'utf8'));
const video = probe.streams.find(s => s.codec_type === 'video');
const audio = probe.streams.find(s => s.codec_type === 'audio');
const [numerator, denominator] = video.avg_frame_rate.split('/').map(Number);
const fps = { numerator, denominator };
if (numerator !== 24000 || denominator !== 1001 || audio.sample_rate !== '48000' || video.start_time !== '0.000000') throw new Error('This fixture expects the supplied GH5 recording; other layouts need mapping validation');
const sources = { P1100565: { path: probe.format.filename, fps, frames: Number(video.nb_frames), width: video.width, height: video.height, channels: audio.channels } };
const timeline = compileTimeline([{ sourceId: 'P1100565', inFrame: 720, outFrame: 816 }, { sourceId: 'P1100565', inFrame: 21600, outFrame: 21696 }], sources, fps);
await writeFile(`${root}/timing-experiment.json`, JSON.stringify({ note: 'Technical excerpts only; not a proposed editorial selection', sources, timeline }, null, 2));
await writeFile(`${root}/timing-experiment.xml`, premiereXml(timeline, sources));
const start = performance.now();
const filters = timeline.intervals.flatMap((clip, i) => [
  `[${i}:v]trim=end_frame=${clip.outFrame - clip.inFrame},setpts=PTS-STARTPTS,scale=960:540:force_original_aspect_ratio=increase,crop=960:540,format=yuv420p[v${i}]`,
  `[${i}:a]pan=mono|c0=c0,atrim=end_sample=${(clip.outFrame - clip.inFrame) * 2002},asetpts=PTS-STARTPTS[a${i}]`
]);
filters.push('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]');
run('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...timeline.intervals.flatMap(clip => ['-threads', '2', '-ss', String(clip.inFrame * denominator / numerator), '-i', sources[clip.sourceId].path]), '-filter_complex_threads', '2', '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-r', '24000/1001', '-c:a', 'aac', '-movflags', '+faststart', `${root}/timing-preview.mp4`]);
const preview = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', `${root}/timing-preview.mp4`]));
const actualVideo = preview.streams.find(s => s.codec_type === 'video');
const actualAudio = preview.streams.find(s => s.codec_type === 'audio');
const expectedDuration = timeline.duration * denominator / numerator;
if (Number(actualVideo.nb_read_frames) !== timeline.duration || Math.abs(Number(actualAudio.duration) - expectedDuration) > 0.002) throw new Error('Fractional-rate preview does not match compiled duration');
const result = { elapsedSeconds: (performance.now() - start) / 1000, frames: Number(actualVideo.nb_read_frames), expectedDuration, videoDuration: Number(actualVideo.duration), audioDuration: Number(actualAudio.duration), premiereImportVerified: false, editorialSelection: false };
await writeFile(`${root}/timing-results.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
