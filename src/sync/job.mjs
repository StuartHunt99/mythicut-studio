import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runTool } from '../analysis.mjs';
import { ANALYSIS_RATE, spectralFeatures, matchFeatures } from './features.mjs';
import { videosOf, recordersOf, solveSession, sessionRate, currentSync, sessionIssues } from './session.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function readFeatures(asset, directory, { tool, signal, progress }) {
  if (!asset.selectedAudio) throw new Error(`${asset.filename}: select a scratch-audio channel or set its position manually.`);
  const identity = await stat(asset.path);
  if (identity.size !== asset.identity.size || identity.mtimeMs !== asset.identity.mtimeMs) throw new Error(`${asset.filename}: recording changed since import`);
  const key = hash([1, asset.identity, asset.path, asset.selectedAudio]);
  const path = join(directory, `${key}.json`);
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (saved.version === 1 && saved.bands.length === 10 && saved.bands.every(band => band.length === saved.count && band.every(Number.isFinite))) {
      return { ...saved, bands: saved.bands.map(band => Float32Array.from(band)) };
    }
  } catch (error) { if (error.code && error.code !== 'ENOENT') throw error; }
  progress({ stage: 'Extracting audio', filename: asset.filename });
  const temporary = join(directory, `${key}.${randomUUID()}.f32`);
  try {
    await tool('ffmpeg', ['-v', 'error', '-nostdin', '-i', asset.path, '-vn', '-sn', '-dn',
      '-map', `0:${asset.selectedAudio.streamIndex}`, '-af', `pan=mono|c0=c${asset.selectedAudio.channel}`,
      '-ar', String(ANALYSIS_RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', temporary], { signal });
    const bytes = await readFile(temporary);
    const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (!samples.every(Number.isFinite)) throw new Error(`${asset.filename}: invalid decoded samples`);
    const features = spectralFeatures(samples);
    const pending = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(pending, JSON.stringify({ ...features, version: 1, bands: features.bands.map(band => Array.from(band)) }));
      await rename(pending, path);
    } finally { await rm(pending, { force: true }); }
    return features;
  } finally { await rm(temporary, { force: true }); }
}

export async function synchronizeProject(project, directory, { signal, progress = () => {}, tool = runTool } = {}) {
  sessionRate(project);
  const videos = videosOf(project), recorders = recordersOf(project);
  if (!recorders.length) throw new Error('Import at least one external audio recording.');
  for (const asset of project.media) {
    if (Number(asset.video?.startTime ?? 0) !== 0 || asset.audio.some(stream => Number(stream.startTime ?? 0) !== 0)) {
      throw new Error(`${asset.filename}: nonzero stream starts need a verified source-time mapping before synchronization.`);
    }
  }
  await mkdir(directory, { recursive: true });
  const features = new Map();
  for (const [i, asset] of project.media.entries()) {
    signal?.throwIfAborted();
    progress({ stage: 'Reading recordings', filename: asset.filename, completed: i, total: project.media.length });
    if (asset.selectedAudio) features.set(asset.id, await readFeatures(asset, directory, { tool, signal, progress }));
  }
  const matches = [];
  for (const video of videos) for (const recorder of recorders) {
    signal?.throwIfAborted();
    progress({ stage: 'Matching audio', filename: `${video.filename} · ${recorder.filename}` });
    if (!features.has(video.id) || !features.has(recorder.id)) continue;
    const result = matchFeatures(features.get(video.id), features.get(recorder.id));
    if (result) matches.push({ a: video.id, b: recorder.id, ...result });
    // Yield between pairs so cancellation reaches the worker.
    await new Promise(resolve => setImmediate(resolve));
  }
  const sync = solveSession(project, matches);
  for (const previous of currentSync(project)?.placements ?? []) {
    if (!previous.manual) continue;
    const placement = sync.placements.find(item => item.mediaId === previous.mediaId);
    placement.startSeconds = previous.startSeconds; placement.manual = true;
  }
  sync.issues = sessionIssues(project, sync);
  return sync;
}
