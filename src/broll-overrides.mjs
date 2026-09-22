import { computeMotionGeometry } from './broll-motion.mjs';

const ID = /^[a-f0-9]{64}$/;

export function validateBrollOverrides(value = []) {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid B-roll override list');
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !ID.test(item.beatPlanId) ||
        !ID.test(item.selectionId) || !ID.test(item.motionId) || typeof item.beatId !== 'string' ||
        !item.beatId || !Number.isSafeInteger(item.layer) || item.layer !== index + 1 ||
        !Number.isSafeInteger(item.startFrame) || !Number.isSafeInteger(item.endFrame) ||
        item.startFrame < 0 || item.endFrame <= item.startFrame ||
        (item.imageId !== null && (typeof item.imageId !== 'string' || !item.imageId)) ||
        (item.imageId !== null && (!item.geometry || !item.intent))) throw new Error('Invalid B-roll override entry');
  }
  return value;
}

export function resolvedBrollDecisions({ beatPlan, selection, motion, overrides = [] }) {
  if (selection.beatPlanId !== beatPlan.id || motion.selectionId !== selection.id) throw new Error('B-roll plans do not match');
  validateBrollOverrides(overrides);
  const selected = new Map(selection.finalDecisions.map(item => [item.beatId, item]));
  const geometry = new Map(motion.motions.map(item => [item.beatId, item]));
  return beatPlan.beats.map(beat => {
    const base = selected.get(beat.id);
    if (!base) throw new Error(`Missing image decision for beat ${beat.id}`);
    const baseMotion = geometry.get(beat.id);
    const layer = overrides.filter(item => item.beatPlanId === beatPlan.id && item.selectionId === selection.id &&
      item.motionId === motion.id && item.beatId === beat.id).at(-1);
    const imageId = layer ? layer.imageId : base.selectedImageId;
    return { beatId: beat.id, startFrame: beat.startFrame, endFrame: beat.endFrame,
      imageId, imageVersionId: layer ? layer.imageVersionId : baseMotion?.imageVersionId ?? null,
      reason: layer ? 'Manual override' : base.reason,
      intent: layer ? layer.intent : baseMotion?.intent ?? null,
      geometry: layer ? layer.geometry : baseMotion?.geometry ?? null,
      trackLayer: layer?.layer ?? 0, override: Boolean(layer) };
  });
}

export function previewBrollOverride({ beatPlan, selection, motion, beatId, imageId,
  kind = 'static', speed = 'slow', anchorId = 'center' }) {
  const beat = beatPlan.beats.find(item => item.id === beatId);
  if (!beat || selection.beatPlanId !== beatPlan.id || motion.selectionId !== selection.id) throw new Error('Unknown or stale B-roll beat');
  if (imageId !== null && (typeof imageId !== 'string' || !imageId)) throw new Error('Choose a saved candidate or no image');
  const image = imageId === null ? null : beat.search?.response?.results?.find(item => item.imageId === imageId);
  if (imageId !== null && !image) throw new Error('Image is not a saved candidate for this beat');
  const fps = beatPlan.timeline.fps.numerator / beatPlan.timeline.fps.denominator;
  if (image && (beat.endFrame - beat.startFrame) / fps < 5) throw new Error('A single artwork clip must cover at least five seconds');
  const intent = image ? { kind, speed, anchorId, reason: 'Manually edited motion' } : null;
  const geometry = image ? computeMotionGeometry({ image, output: { width: beatPlan.timeline.width,
    height: beatPlan.timeline.height }, startFrame: beat.startFrame, endFrame: beat.endFrame,
  fps, intent, detection: image.detection, config: motion.config }) : null;
  return { image, intent, geometry };
}

export function appendBrollOverride({ beatPlan, selection, motion, overrides = [], beatId, imageId,
  kind = 'static', speed = 'slow', anchorId = 'center', clock = () => new Date() }) {
  const previous = validateBrollOverrides(overrides);
  const beat = beatPlan.beats.find(item => item.id === beatId);
  const { image, intent, geometry } = previewBrollOverride({ beatPlan, selection, motion, beatId,
    imageId, kind, speed, anchorId });
  const entry = { beatPlanId: beatPlan.id, selectionId: selection.id, motionId: motion.id,
    beatId, startFrame: beat.startFrame, endFrame: beat.endFrame,
    imageId, imageVersionId: image?.imageVersionId ?? null, revisionId: image?.revisionId ?? null,
    intent, geometry, layer: previous.length + 1, createdAt: clock().toISOString() };
  return [...previous, entry];
}
