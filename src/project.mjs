import { readFile, writeFile, rename, copyFile, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseScript } from './script.mjs';
const execute = promisify(execFile);

export function createProject() {
  return { schemaVersion: 1, id: randomUUID(), name: 'Untitled project', revision: 0, phase: 'import', media: [], script: parseScript(''), settings: { pauseMs: 500, width: 1920, height: 1080, scale: 'fill', restartPhrase: '' }, review: { decisions: {} } };
}

export async function probeMedia(paths, { signal, progress = () => {} } = {}) {
  const ordered = [...new Set(paths.map(p => resolve(p)))].sort((a, b) => basename(a).localeCompare(basename(b), 'en', { numeric: true }));
  const assets = [];
  for (const path of ordered) {
    progress({ stage: 'probe', completed: assets.length, total: ordered.length, filename: basename(path) });
    const identity = await stat(path);
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { signal, maxBuffer: 8 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    const video = data.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const audio = data.streams.filter(s => s.codec_type === 'audio');
    if (!video) throw new Error(`${basename(path)} has no video stream`);
    const duration = Number(data.format.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${basename(path)} has an invalid duration`);
    assets.push({ id: randomUUID(), path, filename: basename(path), identity: { size: identity.size, mtimeMs: identity.mtimeMs }, duration, video: { index: video.index, width: video.width, height: video.height, frameRate: video.avg_frame_rate, timeBase: video.time_base, startTime: video.start_time ?? '0' }, audio: audio.map(s => ({ index: s.index, channels: s.channels, sampleRate: s.sample_rate, timeBase: s.time_base, startTime: s.start_time ?? '0' })), selectedAudio: audio.length ? { streamIndex: audio[0].index, channel: 0 } : null });
  }
  return assets;
}

export function validateProject(project) {
  if (project?.schemaVersion !== 1 || typeof project.id !== 'string' || typeof project.name !== 'string' || !Number.isSafeInteger(project.revision) || project.revision < 0 || !['import', 'analysis'].includes(project.phase) || !Array.isArray(project.media) || typeof project.script?.original !== 'string') throw new Error('Unsupported or invalid project file');
  const review = project.review ?? { decisions: {} };
  if (!review || typeof review.decisions !== 'object' || Array.isArray(review.decisions)) throw new Error('Invalid review state');
  const ids = new Set();
  for (const media of project.media) {
    if (!media || typeof media.id !== 'string' || ids.has(media.id) || typeof media.path !== 'string' || !Number.isFinite(media.duration) || media.duration <= 0 || !Array.isArray(media.audio) || !media.video || !media.identity) throw new Error('Invalid media record');
    ids.add(media.id);
    if (media.selectedAudio !== null && !media.audio.some(a => a.index === media.selectedAudio?.streamIndex && Number.isInteger(media.selectedAudio.channel) && media.selectedAudio.channel >= 0 && media.selectedAudio.channel < a.channels)) throw new Error('Invalid audio channel selection');
  }
  if (!Number.isFinite(project.settings?.pauseMs) || project.settings.pauseMs < 0 || project.settings.pauseMs > 10000 || typeof project.settings.restartPhrase !== 'string') throw new Error('Invalid project settings');
  return { ...project, review, script: parseScript(project.script.original) };
}

export async function saveProject(path, project) {
  const validated = validateProject(project);
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(validated, null, 2), { flag: 'wx' });
  // Keep the last committed snapshot. An interrupted temporary write never
  // replaces the active project, and recovery can open the backup explicitly.
  try { await copyFile(path, `${path}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(temp, path);
}

export async function openProject(path) {
  const project = validateProject(JSON.parse(await readFile(path, 'utf8')));
  const warnings = [];
  for (const asset of project.media) {
    try {
      const current = await stat(asset.path);
      if (current.size !== asset.identity.size || current.mtimeMs !== asset.identity.mtimeMs) warnings.push(`${asset.filename}: source file changed since import`);
    } catch { warnings.push(`${asset.filename}: source file unavailable`); }
    if (!asset.selectedAudio) warnings.push(`${asset.filename}: no audio stream`);
  }
  return { project, warnings };
}
