import { computeMotionGeometry } from './broll-motion.mjs';
import { artworkMinimumForPlan } from './broll-artwork-config.mjs';

const ID = /^[a-f0-9]{64}$/;

function candidateForBeat(beat, imageId, candidate = null) {
  if (candidate && candidate.imageId === imageId) return candidate;
  return beat.search?.response?.results?.find(item => item.imageId === imageId) ?? null;
}

function savedCandidate(image) {
  if (!image) return null;
  const { imageId, imageVersionId, revisionId, filename, width, height, detection, values } = image;
  if (![imageId, imageVersionId, revisionId, filename].every(value => typeof value === 'string' && value) ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('Invalid manually searched artwork candidate');
  }
  const tags = Object.fromEntries(['book', 'characters', 'setting', 'mood', 'image_type'].map(key =>
    [key, Array.isArray(values?.[key]) ? values[key].filter(value => typeof value === 'string').slice(0, 20) : []]));
  return { imageId, imageVersionId, revisionId, filename, width, height, detection: detection ?? null,
    ...(values === undefined ? {} : { values: tags }) };
}

export function validateBrollOverrides(value = []) {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid B-roll override list');
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !ID.test(item.beatPlanId) ||
        !ID.test(item.selectionId) || !ID.test(item.motionId) || typeof item.beatId !== 'string' ||
        !item.beatId || !Number.isSafeInteger(item.layer) || item.layer !== index + 1 ||
        !Number.isSafeInteger(item.startFrame) || !Number.isSafeInteger(item.endFrame) ||
        item.startFrame < 0 || item.endFrame <= item.startFrame ||
        (item.imageId !== null && (typeof item.imageId !== 'string' || !item.imageId)) ||
        (item.imageId !== null && (!item.geometry || !item.intent)) ||
        (item.candidate !== undefined && (item.imageId === null || savedCandidate(item.candidate).imageId !== item.imageId ||
          JSON.stringify(savedCandidate(item.candidate)) !== JSON.stringify(item.candidate)))) throw new Error('Invalid B-roll override entry');
  }
  return value;
}

export function effectiveBrollGeometry({ beatPlan, motion, beat, imageId, intent, geometry, candidate = null }) {
  if (!geometry || !intent || !imageId || geometry.kind === intent.kind || intent.kind === 'static') return geometry;
  const image = candidateForBeat(beat, imageId, candidate);
  if (!image) return geometry;
  return computeMotionGeometry({ image, output: { width: beatPlan.timeline.width, height: beatPlan.timeline.height },
    startFrame: beat.startFrame, endFrame: beat.endFrame,
    fps: beatPlan.timeline.fps.numerator / beatPlan.timeline.fps.denominator,
    intent, detection: image.detection, config: motion.config });
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
    const intent = layer ? layer.intent : baseMotion?.intent ?? null;
    const originalGeometry = layer ? layer.geometry : baseMotion?.geometry ?? null;
    return { beatId: beat.id, startFrame: beat.startFrame, endFrame: beat.endFrame,
      imageId, imageVersionId: layer ? layer.imageVersionId : baseMotion?.imageVersionId ?? null,
      reason: layer ? 'Manual override' : base.reason,
      intent, geometry: effectiveBrollGeometry({ beatPlan, motion, beat, imageId, intent, geometry: originalGeometry,
        candidate: layer?.candidate }),
      trackLayer: layer?.layer ?? 0, override: Boolean(layer) };
  });
}

export function previewBrollOverride({ beatPlan, selection, motion, beatId, imageId,
  kind = 'static', speed = 'slow', anchorId = 'center', candidate = null }) {
  const beat = beatPlan.beats.find(item => item.id === beatId);
  if (!beat || selection.beatPlanId !== beatPlan.id || motion.selectionId !== selection.id) throw new Error('Unknown or stale B-roll beat');
  if (imageId !== null && (typeof imageId !== 'string' || !imageId)) throw new Error('Choose a saved candidate or no image');
  const image = imageId === null ? null : candidateForBeat(beat, imageId, candidate);
  if (imageId !== null && !image) throw new Error('Image is not a saved candidate for this beat');
  const fps = beatPlan.timeline.fps.numerator / beatPlan.timeline.fps.denominator;
  const minimumSeconds = artworkMinimumForPlan(beatPlan);
  if (image && (beat.endFrame - beat.startFrame) / fps < minimumSeconds) {
    throw new Error(`A single artwork clip must cover at least ${minimumSeconds} seconds`);
  }
  const intent = image ? { kind, speed, anchorId, reason: 'Manually edited motion' } : null;
  const geometry = image ? computeMotionGeometry({ image, output: { width: beatPlan.timeline.width,
    height: beatPlan.timeline.height }, startFrame: beat.startFrame, endFrame: beat.endFrame,
  fps, intent, detection: image.detection, config: motion.config }) : null;
  return { image, intent, geometry };
}

export function appendBrollOverride({ beatPlan, selection, motion, overrides = [], beatId, imageId,
  kind = 'static', speed = 'slow', anchorId = 'center', candidate = null, clock = () => new Date() }) {
  const previous = validateBrollOverrides(overrides);
  const beat = beatPlan.beats.find(item => item.id === beatId);
  const { image, intent, geometry } = previewBrollOverride({ beatPlan, selection, motion, beatId,
    imageId, kind, speed, anchorId, candidate });
  const entry = { beatPlanId: beatPlan.id, selectionId: selection.id, motionId: motion.id,
    beatId, startFrame: beat.startFrame, endFrame: beat.endFrame,
    imageId, imageVersionId: image?.imageVersionId ?? null, revisionId: image?.revisionId ?? null,
    intent, geometry, ...(image && (!beat.search?.response?.results?.some(item =>
      item.imageId === imageId && item.imageVersionId === image.imageVersionId && item.revisionId === image.revisionId))
      ? { candidate: savedCandidate(image) } : {}), layer: previous.length + 1, createdAt: clock().toISOString() };
  return [...previous, entry];
}

export function rebaseBrollOverrides({ beatPlan, selection, motion, updatedMotion, overrides = [], clock = () => new Date() }) {
  const previous = validateBrollOverrides(overrides);
  if (beatPlan.id !== selection.beatPlanId || motion.selectionId !== selection.id ||
      updatedMotion.selectionId !== selection.id) throw new Error('B-roll plans do not match');
  if (updatedMotion.id === motion.id) return previous;
  const beats = new Map(beatPlan.beats.map(beat => [beat.id, beat]));
  const fps = beatPlan.timeline.fps.numerator / beatPlan.timeline.fps.denominator;
  const output = { width: beatPlan.timeline.width, height: beatPlan.timeline.height };
  const active = previous.filter(item => item.beatPlanId === beatPlan.id &&
    item.selectionId === selection.id && item.motionId === motion.id);
  const additions = active.map((item, index) => {
    const beat = beats.get(item.beatId);
    if (!beat || item.startFrame !== beat.startFrame || item.endFrame !== beat.endFrame) {
      throw new Error(`Override range changed for beat ${item.beatId}`);
    }
    const image = item.imageId === null ? null : candidateForBeat(beat, item.imageId, item.candidate);
    if (item.imageId !== null && (!image || image.imageVersionId !== item.imageVersionId)) {
      throw new Error(`Override image unavailable for beat ${item.beatId}`);
    }
    const geometry = image ? computeMotionGeometry({ image, output, startFrame: beat.startFrame,
      endFrame: beat.endFrame, fps, intent: item.intent, detection: image.detection,
      config: updatedMotion.config }) : null;
    return { ...item, motionId: updatedMotion.id, geometry, layer: previous.length + index + 1,
      createdAt: clock().toISOString(), recalculatedFromLayer: item.layer };
  });
  return validateBrollOverrides([...previous, ...additions]);
}
