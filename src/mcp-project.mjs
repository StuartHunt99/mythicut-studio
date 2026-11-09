import { resolve } from 'node:path';
import { openProject } from './project.mjs';
import { readEditHandoff } from './edit-handoff.mjs';
import { readBrollBeatPlan } from './broll-beats.mjs';

const fpsValue = fps => fps.numerator / fps.denominator;
const secondsForFrames = (frames, fps) => frames / fpsValue(fps);

export async function loadMcpProject(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('A MythiCut project file is required');
  const location = resolve(projectPath);
  let loaded;
  try { loaded = await openProject(location); }
  catch (error) {
    const message = error?.code === 'ENOENT' ? 'the configured project file does not exist' : String(error?.message ?? error);
    throw new Error(`Could not open the configured MythiCut project: ${message}`);
  }

  const warnings = [...loaded.warnings];
  let handoff = null;
  if (loaded.project.lockedHandoffId) {
    try { handoff = await readEditHandoff(location, loaded.project.lockedHandoffId); }
    catch { warnings.push('The locked edit handoff is unavailable or failed fingerprint verification.'); }
  }

  let beatPlan = null;
  if (loaded.project.brollBeatPlanId) {
    try { beatPlan = await readBrollBeatPlan(location, loaded.project.brollBeatPlanId); }
    catch { warnings.push('The B-roll beat plan is unavailable or failed fingerprint verification.'); }
  }

  return { location, project: loaded.project, warnings, handoff, beatPlan };
}

export function summarizeMcpProject({ project, warnings, handoff, beatPlan }) {
  const handoffMatchesProject = Boolean(handoff && (!handoff.projectId || handoff.projectId === project.id));
  const beatPlanMatchesHandoff = Boolean(beatPlan && handoff && beatPlan.handoffId === handoff.id);
  return {
    project: {
      id: project.id,
      name: project.name,
      revision: project.revision,
      phase: project.phase,
      sourceRecordingCount: project.media.length,
      sourceRecordings: project.media.map(media => ({ id: media.id, filename: media.filename, durationSeconds: media.duration })),
      scriptCharacterCount: project.script.original.length,
      scriptParagraphCount: new Set(project.script.sentences.map(sentence => sentence.paragraphId)).size,
      scriptSentenceCount: project.script.sentences.length
    },
    lockedTranscript: {
      configured: Boolean(project.lockedHandoffId),
      available: Boolean(handoff),
      id: handoff?.id ?? null,
      matchesProject: handoffMatchesProject,
      wordCount: handoff?.words.length ?? 0,
      durationFrames: handoff?.timeline.duration ?? 0,
      durationSeconds: handoff ? secondsForFrames(handoff.timeline.duration, handoff.timeline.fps) : 0
    },
    beatPlan: {
      configured: Boolean(project.brollBeatPlanId),
      available: Boolean(beatPlan),
      id: beatPlan?.id ?? null,
      status: beatPlan?.status ?? null,
      beatCount: beatPlan?.beats?.length ?? 0,
      matchesLockedTranscript: beatPlanMatchesHandoff
    },
    warnings
  };
}

export function transcriptFromMcpProject({ handoff }, { includeWords = false, offset = 0, limit = 200 } = {}) {
  if (!handoff) throw new Error('This project does not have a readable locked edit handoff. Lock the reviewed selection first.');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Transcript offset must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Transcript limit must be between 1 and 500');

  const result = {
    handoffId: handoff.id,
    kind: handoff.kind,
    wordCount: handoff.words.length,
    text: handoff.text ?? handoff.words.map(word => word.text).join(' '),
    timeline: {
      fps: handoff.timeline.fps,
      durationFrames: handoff.timeline.duration,
      durationSeconds: secondsForFrames(handoff.timeline.duration, handoff.timeline.fps)
    },
    timingNeedsReviewCount: handoff.words.filter(word => word.timingNeedsReview).length
  };
  if (includeWords) {
    const words = handoff.words.slice(offset, offset + limit).map(word => ({
      id: word.id,
      text: word.text,
      sourceId: word.sourceId,
      startFrame: word.startFrame,
      endFrame: word.endFrame,
      timingNeedsReview: Boolean(word.timingNeedsReview)
    }));
    result.wordPage = { offset, limit, returned: words.length, total: handoff.words.length, words };
  }
  return result;
}

export function beatsFromMcpProject({ handoff, beatPlan }) {
  if (!beatPlan) throw new Error('This project does not have a readable B-roll beat plan. Plan visual beats first.');
  if (!Array.isArray(beatPlan.beats) || !beatPlan.timeline?.fps) throw new Error('The stored B-roll beat plan is malformed');
  const fps = beatPlan.timeline.fps;
  return {
    planId: beatPlan.id,
    handoffId: beatPlan.handoffId,
    matchesLockedTranscript: Boolean(handoff && beatPlan.handoffId === handoff.id),
    status: beatPlan.status,
    beatCount: beatPlan.beats.length,
    timeline: {
      fps,
      durationFrames: beatPlan.timeline.duration,
      durationSeconds: secondsForFrames(beatPlan.timeline.duration, fps)
    },
    beats: beatPlan.beats.map(beat => ({
      id: beat.id,
      startWordId: beat.startWordId,
      endWordId: beat.endWordId,
      startFrame: beat.startFrame,
      endFrame: beat.endFrame,
      durationSeconds: secondsForFrames(beat.endFrame - beat.startFrame, fps),
      text: beat.text,
      visualIntent: beat.visualIntent,
      artworkNeed: beat.artworkNeed,
      talkingHeadPriority: beat.talkingHeadPriority,
      searchQuery: beat.searchQuery,
      reason: beat.reason,
      warnings: Array.isArray(beat.warnings) ? beat.warnings : [],
      searchStatus: beat.searchStatus ?? null,
      candidateCount: Array.isArray(beat.search?.response?.results) ? beat.search.response.results.length : 0
    }))
  };
}
