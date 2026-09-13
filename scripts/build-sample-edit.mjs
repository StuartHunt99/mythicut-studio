import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compileTimeline, outwardFrames } from '../src/timeline.mjs';
import { paddedWordRange } from '../src/cut-boundaries.mjs';
import { premiereXml } from '../src/premiere-xml.mjs';

const root = resolve('artifacts/sample');
const out = `${root}/edit`;
await mkdir(out, { recursive: true });
const probe = JSON.parse(await readFile(`${root}/media.json`, 'utf8'));
const fps = { numerator: 24000, denominator: 1001 };
const sources = { P1100565: { path: probe.format.filename, fps, frames: 40584, width: 3840, height: 2160, channels: 2 } };
const configs = [
  { id: 'opening', startPhrase: "WELL I'VE PUT THIS OFF LONG ENOUGH", endPhrase: 'SO BE WARNED', ends: ['LONG ENOUGH', 'ENTIRE NARNIAD', 'TALK ABOUT IT', 'BIG SPOILER'] },
  { id: 'question', startPhrase: 'BECAUSE TODAY WE ARE FINALLY', endPhrase: 'TRAGICALLY EMPTY', ends: ['GO TO HELL'] }
];
const clips = [];
const sections = [];
function occurrences(words, phrase) {
  const target = phrase.split(' ');
  return words.flatMap((_, i) => target.every((text, j) => words[i + j]?.text === text) ? [i] : []);
}
for (const config of configs) {
  const data = JSON.parse(await readFile(`${root}/alignment/${config.id}.json`, 'utf8'));
  const words = data.words;
  const start = occurrences(words, config.startPhrase).at(-1);
  const end = occurrences(words, config.endPhrase).at(-1) + config.endPhrase.split(' ').length - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) throw new Error('Expected sample passage not found');
  const splits = config.ends.flatMap(phrase => occurrences(words, phrase).map(i => i + phrase.split(' ').length - 1)).filter(i => i >= start && i < end && words[i + 1].startMs - words[i].endMs > 500).sort((a, b) => a - b);
  let firstIndex = start;
  for (const lastIndex of [...splits, end]) {
    const boundary = paddedWordRange({ first: words[firstIndex], last: words[lastIndex], previous: words[firstIndex - 1], next: words[lastIndex + 1], sourceDurationMs: 1692691, fps });
    const selected = words.slice(firstIndex, lastIndex + 1);
    clips.push({ sourceId: 'P1100565', inFrame: boundary.inFrame, outFrame: boundary.outFrame });
    sections.push({ label: config.id, boundary, words: selected, text: selected.map(w => w.text).join(' '), lowConfidenceWords: selected.filter(w => w.needsReview).map(w => w.text) });
    firstIndex = lastIndex + 1;
  }
}
// Frame rounding can leave a nominal pause edit with no source frames removed.
// Merge that seam instead of exporting an unnecessary cut.
for (let i = 1; i < clips.length;) {
  if (clips[i - 1].sourceId === clips[i].sourceId && clips[i - 1].outFrame === clips[i].inFrame) {
    clips[i - 1].outFrame = clips[i].outFrame;
    const previous = sections[i - 1];
    const current = sections[i];
    previous.boundary.outFrame = current.boundary.outFrame;
    previous.boundary.speechEndMs = current.boundary.speechEndMs;
    previous.boundary.trailingPaddingMs = current.boundary.trailingPaddingMs;
    previous.words.push(...current.words);
    previous.text += ' ' + current.text;
    previous.lowConfidenceWords.push(...current.lowConfidenceWords);
    clips.splice(i, 1); sections.splice(i, 1);
  } else i++;
}
const timeline = compileTimeline(clips, sources, fps);
const joins = timeline.intervals.slice(1).map((clip, i) => ({ sequenceSeconds: clip.start * 1001 / 24000, pauseMs: sections[i].boundary.trailingPaddingMs + sections[i + 1].boundary.leadingPaddingMs }));
const manifest = { schemaVersion: 1, status: 'Sample for listening review; not a finished rough cut', selectionMethod: 'Curated passage fixture using local CTC alignment; full take selection is not implemented', sources, timeline, sections, joins, expectedDuration: timeline.duration * 1001 / 24000 };
await writeFile(`${out}/edit.json`, JSON.stringify(manifest, null, 2));
await writeFile(`${out}/premiere.xml`, premiereXml(timeline, sources));
await writeFile(`${out}/review-data.js`, `window.sampleEdit = ${JSON.stringify(manifest).replaceAll('<', '\\u003c')};\n`);
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(result.error?.message || result.stderr);
  return result.stdout;
};
const started = performance.now();
const filters = timeline.intervals.flatMap((clip, i) => [
  `[${i}:v]trim=end_frame=${clip.outFrame - clip.inFrame},setpts=PTS-STARTPTS,scale=1280:720,format=yuv420p[v${i}]`,
  `[${i}:a]pan=mono|c0=c0,atrim=end_sample=${(clip.outFrame - clip.inFrame) * 2002},asetpts=PTS-STARTPTS[a${i}]`
]);
filters.push(timeline.intervals.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${clips.length}:v=1:a=1[v][a]`);
run('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...clips.flatMap(clip => ['-threads', '2', '-ss', String(clip.inFrame * 1001 / 24000), '-i', sources[clip.sourceId].path]), '-filter_complex_threads', '2', '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '21', '-r', '24000/1001', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', `${out}/sample-edit.mp4`]);
const result = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', `${out}/sample-edit.mp4`]));
const video = result.streams.find(s => s.codec_type === 'video');
const audio = result.streams.find(s => s.codec_type === 'audio');
if (Number(video.nb_read_frames) !== timeline.duration || Math.abs(Number(audio.duration) - manifest.expectedDuration) > 0.002) throw new Error('Rendered timing differs from the shared timeline');
const report = { elapsedSeconds: (performance.now() - started) / 1000, frames: Number(video.nb_read_frames), videoDuration: Number(video.duration), audioDuration: Number(audio.duration), joins, premiereImportVerified: false, humanListeningVerified: false };
await writeFile(`${out}/render-results.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
