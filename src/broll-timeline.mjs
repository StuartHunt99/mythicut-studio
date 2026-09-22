import { fileURLToPath } from 'node:url';
import { effectiveBrollGeometry, resolvedBrollDecisions, validateBrollOverrides } from './broll-overrides.mjs';

function sameRate(a, b) {
  return a?.numerator === b?.numerator && a?.denominator === b?.denominator;
}

export function compileBrollTimeline({ compiled, beatPlan, selection, motion, overrides = [], review }) {
  const timeline = compiled?.timeline;
  if (!timeline || !beatPlan || !review || review.beatPlanId !== beatPlan.id ||
      review.selectionId !== selection?.id || review.motionId !== motion?.id ||
      !sameRate(timeline.fps, beatPlan.timeline.fps) || timeline.duration !== beatPlan.timeline.duration ||
      timeline.width !== beatPlan.timeline.width || timeline.height !== beatPlan.timeline.height) {
    throw new Error('B-roll plan does not match the compiled phase-1 timeline');
  }
  const decisions = resolvedBrollDecisions({ beatPlan, selection, motion, overrides });
  const final = new Map(decisions.map(item => [item.beatId, item]));
  const reviewBeats = new Map(review.beats.map(item => [item.id, item]));
  const beatById = new Map(beatPlan.beats.map(item => [item.id, item]));
  const tracks = [[]];

  function artwork(beatId, imageId, geometry, layer, imageVersionId, revisionId) {
    const beat = beatById.get(beatId);
    const candidate = reviewBeats.get(beatId)?.candidates.find(item => item.imageId === imageId);
    if (!beat || !candidate?.usable || !candidate.previewUrl || !geometry ||
        candidate.imageVersionId !== imageVersionId || candidate.revisionId !== revisionId ||
        geometry.startFrame !== beat.startFrame || geometry.endFrame !== beat.endFrame) {
      throw new Error(`Artwork for beat ${beatId} is unavailable, changed, or has stale geometry`);
    }
    let path;
    try { path = fileURLToPath(candidate.previewUrl); }
    catch { throw new Error(`Artwork path for beat ${beatId} is invalid`); }
    return { beatId, imageId, imageVersionId: candidate.imageVersionId, filename: candidate.filename,
      path, width: candidate.width, height: candidate.height, start: beat.startFrame,
      end: beat.endFrame, geometry, layer };
  }

  for (const beat of beatPlan.beats) {
    const original = selection.finalDecisions.find(item => item.beatId === beat.id);
    // A final clear removes that beat from every lower track; an empty upper
    // track would not conceal the prior still in Premiere.
    if (!final.get(beat.id)?.imageId || !original?.selectedImageId) continue;
    const base = motion.motions.find(item => item.beatId === beat.id);
    const candidate = beat.search?.response?.results?.find(item => item.imageId === original.selectedImageId);
    const geometry = effectiveBrollGeometry({ beatPlan, motion, beat, imageId: original.selectedImageId,
      intent: base?.intent, geometry: base?.geometry });
    tracks[0].push(artwork(beat.id, original.selectedImageId, geometry, 0,
      base?.imageVersionId, candidate?.revisionId));
  }
  validateBrollOverrides(overrides);
  for (const entry of overrides) {
    if (entry.beatPlanId !== beatPlan.id || entry.selectionId !== selection.id || entry.motionId !== motion.id ||
        !entry.imageId || !final.get(entry.beatId)?.imageId) continue;
    const beat = beatById.get(entry.beatId);
    if (!beat || entry.startFrame !== beat.startFrame || entry.endFrame !== beat.endFrame) {
      throw new Error(`Override range for beat ${entry.beatId} differs from its locked interval`);
    }
    const geometry = effectiveBrollGeometry({ beatPlan, motion, beat, imageId: entry.imageId,
      intent: entry.intent, geometry: entry.geometry });
    tracks.push([artwork(entry.beatId, entry.imageId, geometry, entry.layer,
      entry.imageVersionId, entry.revisionId)]);
  }
  return { timeline, sources: compiled.sources, beatPlanId: beatPlan.id, selectionId: selection.id,
    motionId: motion.id, projectRevision: review.projectRevision ?? null, tracks,
    selectedCount: decisions.filter(item => item.imageId).length };
}
