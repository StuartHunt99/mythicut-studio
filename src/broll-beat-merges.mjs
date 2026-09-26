import { artworkMinimumForPlan } from './broll-artwork-config.mjs';
import { appendBrollOverride, resolvedBrollDecisions } from './broll-overrides.mjs';

const planId = /^[a-f0-9]{64}$/;

export function validateBrollMerges(value = []) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid B-roll merge list');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !planId.test(item.beatPlanId) ||
        !planId.test(item.selectionId) || typeof item.targetBeatId !== 'string' || !item.targetBeatId ||
        typeof item.donorBeatId !== 'string' || !item.donorBeatId || item.targetBeatId === item.donorBeatId ||
        typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) {
      throw new Error('Invalid B-roll merge entry');
    }
  }
  return value;
}

function combinedCandidates(target, donor, overrides, memberBeatIds, beatPlanId, selectionId) {
  const results = new Map();
  for (const candidate of [...(target.search?.response?.results ?? []), ...(donor.search?.response?.results ?? []),
    ...overrides.filter(item => item.beatPlanId === beatPlanId && item.selectionId === selectionId &&
      memberBeatIds.includes(item.beatId) && item.candidate).map(item => item.candidate)]) {
    if (candidate?.imageId && !results.has(candidate.imageId)) results.set(candidate.imageId, candidate);
  }
  return [...results.values()];
}

export function mergedBrollPlan({ beatPlan, selection, merges = [], overrides = [] }) {
  validateBrollMerges(merges);
  const active = merges.filter(item => item.beatPlanId === beatPlan.id && item.selectionId === selection.id);
  if (!active.length) return beatPlan;
  const fps = beatPlan.timeline.fps.numerator / beatPlan.timeline.fps.denominator;
  const minimum = artworkMinimumForPlan(beatPlan);
  const beats = beatPlan.beats.map(beat => ({ ...beat, memberBeatIds: [beat.id] }));
  for (const item of active) {
    const targetIndex = beats.findIndex(beat => beat.id === item.targetBeatId);
    const donorIndex = beats.findIndex(beat => beat.id === item.donorBeatId);
    if (targetIndex < 0 || donorIndex < 0 || Math.abs(targetIndex - donorIndex) !== 1) {
      throw new Error('Saved B-roll merge no longer joins adjacent beats');
    }
    const target = beats[targetIndex], donor = beats[donorIndex];
    const first = beats[Math.min(targetIndex, donorIndex)], last = beats[Math.max(targetIndex, donorIndex)];
    const memberBeatIds = [...first.memberBeatIds, ...last.memberBeatIds];
    const text = `${first.text} ${last.text}`.trim();
    const results = combinedCandidates(target, donor, overrides, memberBeatIds, beatPlan.id, selection.id);
    const response = { ...(target.search?.response ?? {}), results, resultCount: results.length };
    const search = { ...(target.search ?? {}), query: { ...(target.search?.query ?? {}), semanticText: text, spokenText: text }, response };
    const duration = (last.endFrame - first.startFrame) / fps;
    const warnings = [...new Set([...(target.warnings ?? []), ...(donor.warnings ?? [])])]
      .filter(warning => warning !== 'shorter_than_artwork_group_minimum' || duration < minimum);
    const artworkNeed = [target, donor].some(beat => beat.artworkNeed === 'required') ? 'required' :
      [target, donor].some(beat => beat.artworkNeed === 'optional') ? 'optional' : 'none';
    const combined = { ...target, memberBeatIds, text,
      startIndex: first.startIndex, endIndex: last.endIndex,
      startWordId: first.startWordId, endWordId: last.endWordId,
      startFrame: first.startFrame, endFrame: last.endFrame,
      wordStartFrame: first.wordStartFrame, wordEndFrame: last.wordEndFrame,
      previousSentence: first.previousSentence, nextSentence: last.nextSentence,
      paragraphContext: text,
      opening: first.opening || last.opening, closing: first.closing || last.closing,
      establishing: first.establishing || last.establishing, artworkNeed, warnings,
      searchQuery: text, searchStatus: results.length ? 'candidates' : target.searchStatus, search };
    beats.splice(Math.min(targetIndex, donorIndex), 2, combined);
  }
  return { ...beatPlan, beats };
}

export function appendBrollMerge({ beatPlan, selection, merges = [], overrides = [], beatId, direction,
  clock = () => new Date() }) {
  if (!['up', 'down'].includes(direction)) throw new Error('Choose merge up or merge down');
  const current = mergedBrollPlan({ beatPlan, selection, merges, overrides });
  const index = current.beats.findIndex(beat => beat.id === beatId);
  const neighbor = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || neighbor < 0 || neighbor >= current.beats.length) throw new Error('There is no adjacent beat to merge');
  const entry = { beatPlanId: beatPlan.id, selectionId: selection.id,
    targetBeatId: current.beats[neighbor].id, donorBeatId: beatId,
    createdAt: clock().toISOString() };
  const updated = [...validateBrollMerges(merges), entry];
  return { merges: updated, targetBeatId: entry.targetBeatId, donorBeatId: beatId,
    beatPlan: mergedBrollPlan({ beatPlan, selection, merges: updated, overrides }) };
}

export function mergeBrollDecision({ beatPlan, selection, motion, merges = [], overrides = [],
  beatId, direction, clock = () => new Date() }) {
  const current = mergedBrollPlan({ beatPlan, selection, merges, overrides });
  const merge = appendBrollMerge({ beatPlan, selection, merges, overrides, beatId, direction, clock });
  const target = resolvedBrollDecisions({ beatPlan: current, selection, motion, overrides })
    .find(item => item.beatId === merge.targetBeatId);
  const updatedOverrides = appendBrollOverride({ beatPlan: merge.beatPlan, selection, motion,
    overrides, beatId: merge.targetBeatId, imageId: target.imageId,
    kind: target.intent?.kind ?? 'static', speed: target.intent?.speed ?? 'slow',
    anchorId: target.intent?.anchorId ?? 'center', clock });
  return { ...merge, overrides: updatedOverrides };
}
