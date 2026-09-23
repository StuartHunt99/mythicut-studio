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

  function artwork(beatId, imageId, geometry, layer, imageVersionId, required) {
    const beat = beatById.get(beatId);
    const candidate = reviewBeats.get(beatId)?.candidates.find(item => item.imageId === imageId);
    const filename = candidate?.filename ?? beat?.search?.response?.results?.find(item => item.imageId === imageId)?.filename ?? imageId;
    const reason = !beat ? 'beat no longer exists' : !candidate || candidate.foundInCatalog === false ? 'image is absent from the current catalog' :
      candidate.availability && candidate.availability !== 'present' ? 'image file is missing' :
      candidate.active === false ? 'image is deactivated' :
      candidate.reviewState && candidate.reviewState !== 'accepted' ? 'image is no longer accepted' :
      candidate.imageVersionId !== imageVersionId ? 'image version changed' :
      !candidate.usable ? 'image is unavailable' : !candidate.previewUrl ? 'image path is unavailable' :
      !geometry ? 'motion geometry is missing' :
      geometry.startFrame !== beat.startFrame || geometry.endFrame !== beat.endFrame ? 'motion geometry has a stale beat range' : null;
    if (reason) {
      if (!required) return null;
      throw new Error(`Artwork for beat ${beatId} (${filename}) is unavailable: ${reason}`);
    }
    let path;
    try { path = fileURLToPath(candidate.previewUrl); }
    catch {
      if (!required) return null;
      throw new Error(`Artwork for beat ${beatId} (${filename}) is unavailable: image path is invalid`);
    }
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
    const geometry = effectiveBrollGeometry({ beatPlan, motion, beat, imageId: original.selectedImageId,
      intent: base?.intent, geometry: base?.geometry });
    const clip = artwork(beat.id, original.selectedImageId, geometry, 0,
      base?.imageVersionId, final.get(beat.id).trackLayer === 0);
    if (clip) tracks[0].push(clip);
  }
  validateBrollOverrides(overrides);
  for (const entry of overrides) {
    if (entry.beatPlanId !== beatPlan.id || entry.selectionId !== selection.id || entry.motionId !== motion.id ||
        !entry.imageId || !final.get(entry.beatId)?.imageId) continue;
    const beat = beatById.get(entry.beatId);
    const required = final.get(entry.beatId).trackLayer === entry.layer;
    if (!beat || entry.startFrame !== beat.startFrame || entry.endFrame !== beat.endFrame) {
      if (required) throw new Error(`Override range for beat ${entry.beatId} differs from its locked interval`);
      continue;
    }
    const geometry = effectiveBrollGeometry({ beatPlan, motion, beat, imageId: entry.imageId,
      intent: entry.intent, geometry: entry.geometry, candidate: entry.candidate });
    const clip = artwork(entry.beatId, entry.imageId, geometry, entry.layer,
      entry.imageVersionId, required);
    if (clip) tracks.push([clip]);
  }
  return { timeline, sources: compiled.sources, beatPlanId: beatPlan.id, selectionId: selection.id,
    motionId: motion.id, projectRevision: review.projectRevision ?? null, tracks,
    selectedCount: decisions.filter(item => item.imageId).length };
}
