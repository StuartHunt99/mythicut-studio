import { readFile, writeFile, rename, copyFile, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseScript } from './script.mjs';
import { validateReview } from './review.mjs';
import { effectivePromptTemplate, migratePromptOverrides } from './prompt-templates.mjs';
import { DEFAULT_MOTION_CONFIG, validateMotionConfig } from './broll-motion.mjs';
import { DEFAULT_ARTWORK_CONFIG, validateArtworkConfig } from './broll-artwork-config.mjs';
import { validateBrollOverrides } from './broll-overrides.mjs';
import { validateBrollMerges } from './broll-beat-merges.mjs';
const execute = promisify(execFile);

export function createProject() {
  return { schemaVersion: 1, id: randomUUID(), name: 'Untitled project', revision: 0, phase: 'import', media: [], script: parseScript(''), settings: { pauseMs: 500, width: 1920, height: 1080, scale: 'fill', restartPhrase: '' }, review: { decisions: {} }, brollPromptTemplates: {}, brollMotionConfig: { ...DEFAULT_MOTION_CONFIG }, brollArtworkConfig: { ...DEFAULT_ARTWORK_CONFIG }, brollOverrides: [], brollMerges: [] };
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
  const review = validateReview(project.review);
  const ids = new Set();
  for (const media of project.media) {
    if (!media || typeof media.id !== 'string' || ids.has(media.id) || typeof media.path !== 'string' || !Number.isFinite(media.duration) || media.duration <= 0 || !Array.isArray(media.audio) || !media.video || !media.identity) throw new Error('Invalid media record');
    ids.add(media.id);
    if (media.selectedAudio !== null && !media.audio.some(a => a.index === media.selectedAudio?.streamIndex && Number.isInteger(media.selectedAudio.channel) && media.selectedAudio.channel >= 0 && media.selectedAudio.channel < a.channels)) throw new Error('Invalid audio channel selection');
  }
  if (!Number.isFinite(project.settings?.pauseMs) || project.settings.pauseMs < 0 || project.settings.pauseMs > 10000 || typeof project.settings.restartPhrase !== 'string') throw new Error('Invalid project settings');
  if (project.lockedHandoffId !== undefined && !/^[a-f0-9]{64}$/.test(project.lockedHandoffId)) throw new Error('Invalid locked handoff reference');
  if (project.brollBeatPlanId !== undefined && !/^[a-f0-9]{64}$/.test(project.brollBeatPlanId)) throw new Error('Invalid B-roll beat plan reference');
  if (project.brollSelectionId !== undefined && !/^[a-f0-9]{64}$/.test(project.brollSelectionId)) throw new Error('Invalid B-roll selection reference');
  if (project.brollMotionId !== undefined && !/^[a-f0-9]{64}$/.test(project.brollMotionId)) throw new Error('Invalid B-roll motion reference');
  const brollPromptTemplates = migratePromptOverrides(project.brollPromptTemplates ?? {});
  if (!brollPromptTemplates || typeof brollPromptTemplates !== 'object' || Array.isArray(brollPromptTemplates) ||
      Object.keys(brollPromptTemplates).some(task => !['beatPlanning', 'imageSelection', 'allocation', 'motion'].includes(task))) throw new Error('Invalid B-roll prompt templates');
  for (const [task, template] of Object.entries(brollPromptTemplates)) effectivePromptTemplate(task, template);
  return { ...project, review, brollPromptTemplates, brollMotionConfig: validateMotionConfig(project.brollMotionConfig ?? {}),
    brollArtworkConfig: validateArtworkConfig(project.brollArtworkConfig ?? {}),
    brollOverrides: validateBrollOverrides(project.brollOverrides ?? []),
    brollMerges: validateBrollMerges(project.brollMerges ?? []), script: parseScript(project.script.original) };
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
