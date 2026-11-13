import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import localTools from '../src/local-tools.cjs';
import { createProject, probeMedia, saveProject, openProject } from '../src/project.mjs';
import { synchronizeProject } from '../src/sync/job.mjs';
import { compileSyncReview } from '../src/sync/timeline.mjs';
import { renderDialogue } from '../src/sync/dialogue.mjs';
import { runTool } from '../src/analysis.mjs';
import { premiereXml } from '../src/premiere-xml.mjs';
import { orderRecordings, adjustSync } from '../src/sync/session.mjs';
import { analyzeProject } from '../src/analysis.mjs';
import { parseScript } from '../src/script.mjs';

localTools.prepareLocalTools();
const available = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const execute = promisify(execFile);

test('real media import, many-to-many synchronization, cache reuse, and recorder-boundary playback', { skip: !available }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mythicut-sync-media-'));
  const master = join(root, 'session.f32');
  let seed = 23, level = 0.1;
  function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; }
  const samples = Float32Array.from({ length: 45 * 8000 }, (_, i) => {
    if (i % 731 === 0) level = 0.02 + random() ** 2;
    return (random() * 2 - 1) * level;
  });
  // Short, decaying broadband claps supply clear transients between the
  // speech-like background. Every camera excerpt includes at least one clap.
  for (const time of [8.3, 19.4, 26.7, 39.5]) {
    for (let i = 0; i < 1600; i++) samples[Math.round(time * 8000) + i] += (random() * 2 - 1) * Math.exp(-i / 200);
  }
  await writeFile(master, Buffer.from(samples.buffer));
  const paths = [];
  for (const [name, start, duration, video] of [
    ['video1.mkv', 6, 9, true], ['video2.mkv', 17, 17, true], ['video3.mkv', 36, 8, true],
    ['audio1.wav', 0, 25, false], ['audio2.wav', 25, 20, false]
  ]) {
    const path = join(root, name); paths.push(path);
    await runTool('ffmpeg', ['-v', 'error', '-nostdin',
      ...(video ? ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30'] : []),
      '-f', 'f32le', '-ar', '8000', '-ac', '1', '-ss', String(start), '-i', master, '-t', String(duration),
      ...(video ? ['-c:v', 'ffv1'] : []), '-c:a', 'pcm_s16le', path]);
  }
  const project = createProject(); project.name = 'Sync integration fixture';
  project.media = orderRecordings(await probeMedia(paths));
  assert.equal(project.media.filter(asset => !asset.video).length, 2);
  const cache = join(root, 'cache');
  const sync = await synchronizeProject(project, cache);
  assert.deepEqual(sync.issues, []);
  for (const [name, expected] of [['video1.mkv', 6], ['video2.mkv', 17], ['video3.mkv', 36], ['audio1.wav', 0], ['audio2.wav', 25]]) {
    const id = project.media.find(asset => asset.filename === name).id;
    assert.ok(Math.abs(sync.placements.find(p => p.mediaId === id).startSeconds - expected) <= 0.04, name);
  }
  project.synchronization = sync;
  const cached = await synchronizeProject(project, cache, { tool: async () => { throw new Error('Audio should be cached'); } });
  assert.equal(cached.matches.length, sync.matches.length);
  const firstVideo = project.media.find(asset => asset.video);
  const originalStart = sync.placements.find(p => p.mediaId === firstVideo.id).startSeconds;
  project.synchronization = adjustSync(project, firstVideo.id, originalStart + 0.01);
  const corrected = await synchronizeProject(project, cache, { tool: async () => { throw new Error('Audio should be cached'); } });
  assert.equal(corrected.placements.find(p => p.mediaId === firstVideo.id).startSeconds, originalStart + 0.01);
  project.synchronization = sync;
  project.synchronization.accepted = true;
  await saveProject(join(root, 'project.json'), project);
  assert.equal((await openProject(join(root, 'project.json'))).project.synchronization.accepted, true);
  const compiled = compileSyncReview(project);
  const xml = premiereXml(compiled.timeline, compiled.sources);
  assert.match(xml, /audio1.wav/); assert.match(xml, /audio2.wav/);
  const video = project.media.find(asset => asset.filename === 'video2.mkv');
  const dialogue = join(root, 'dialogue.wav');
  await renderDialogue(project, video.id, 0, video.duration, dialogue, { tool: runTool });
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', dialogue]);
  assert.ok(Math.abs(Number(JSON.parse(stdout).format.duration) - 17) < 1 / 16000);
  project.script = parseScript('Synthetic dialogue.');
  const model = join(root, 'fake-model'); await writeFile(model, 'test-only model identity');
  const analysis = await analyzeProject(project, join(root, 'analysis'), { model, tool: async (name, args, options) => {
    if (name === 'ffmpeg') return runTool(name, args, options);
    assert.equal(name, 'whisper-cli');
    await writeFile(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({ transcription: [{ tokens: [
      { id: 1, text: ' Synthetic', offsets: { from: 1000, to: 1500 }, p: 0.99 },
      { id: 2, text: ' dialogue.', offsets: { from: 1500, to: 2000 }, p: 0.99 }
    ] }] }));
  } });
  const evidence = JSON.parse(await readFile(analysis.resultPath, 'utf8'));
  assert.equal(evidence.words.length, 6);
  assert.deepEqual(new Set(evidence.words.map(word => word.mediaId)), new Set(project.media.filter(asset => asset.video).map(asset => asset.id)));
  await assert.rejects(synchronizeProject(project, cache, { signal: AbortSignal.abort() }), /abort/i);

  // Publish only synthetic fixtures for the isolated Electron import smoke run.
  const artifacts = resolve('artifacts/sync-check'); await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'review.xml'), xml);
  await saveProject(join(artifacts, 'project.json'), { ...project, phase: 'import', synchronization: undefined });
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ sourceRoot: root, clips: paths.length,
    matches: sync.matches.length, issues: sync.issues, playbackBytes: (await stat(dialogue)).size }, null, 2));
});
