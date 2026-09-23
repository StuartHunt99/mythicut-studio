import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderPrompt } from './prompt-templates.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export const MOTION_INTENT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['kind', 'speed', 'anchorId', 'reason'], properties: {
    kind: { type: 'string', enum: ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'static'] },
    speed: { type: 'string', enum: ['slow', 'fast'] },
    anchorId: { type: 'string' }, reason: { type: 'string' }
  }
});

export const DEFAULT_MOTION_CONFIG = Object.freeze({ slowZoomRate: 0.02, fastZoomRate: 0.04,
  slowPanRate: 0.01, fastPanRate: 0.02, maxRelativeScale: 1.5, subjectMargin: 0.01 });

export function validateMotionConfig(input = {}) {
  const config = { ...DEFAULT_MOTION_CONFIG, ...input };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_MOTION_CONFIG, key))) throw new Error('Invalid motion configuration');
  for (const key of ['slowZoomRate', 'fastZoomRate', 'slowPanRate', 'fastPanRate']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0 || config[key] > 0.2) throw new Error(`${key} must be a positive scale/travel fraction per second no larger than 20%`);
  }
  if (config.fastZoomRate <= config.slowZoomRate || config.fastPanRate <= config.slowPanRate) throw new Error('Fast motion rates must exceed slow rates');
  if (!Number.isFinite(config.maxRelativeScale) || config.maxRelativeScale < 1 || config.maxRelativeScale > 3) throw new Error('Maximum relative scale must be between 1 and 3');
  if (!Number.isFinite(config.subjectMargin) || config.subjectMargin < 0 || config.subjectMargin > 0.1) throw new Error('Subject margin must be between 0 and 10%');
  return config;
}

export function detectionAnchors(detection) {
  const anchors = [{ id: 'center', label: 'Image center', x: 0.5, y: 0.5, box: null }];
  for (const [kind, items] of [['face', detection?.faces], ['object', detection?.objects]]) {
    for (const [index, item] of (items ?? []).entries()) {
      const { x, y, width, height } = item;
      if (![x, y, width, height].every(value => Number.isFinite(value)) || x < 0 || y < 0 || width < 0 || height < 0 || x + width > 1 || y + height > 1) continue;
      anchors.push({ id: `${kind}:${index}`, label: item.label, x: x + width / 2, y: y + height / 2,
        box: { x, y, width, height } });
    }
  }
  return anchors;
}

function validatedIntent(value) {
  if (!MOTION_INTENT_SCHEMA.properties.kind.enum.includes(value?.kind) || !['slow', 'fast'].includes(value?.speed) ||
      typeof value.anchorId !== 'string' || value.anchorId.length > 100 ||
      typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000 || /\[[^\]]*\]/.test(value.reason)) {
    throw new Error('Motion agent returned an invalid intent');
  }
  return { kind: value.kind, speed: value.speed, anchorId: value.anchorId, reason: value.reason.trim() };
}

function cropAt(image, output, relativeScale, center) {
  const fillScale = Math.max(output.width / image.width, output.height / image.height);
  const width = output.width / (image.width * fillScale * relativeScale);
  const height = output.height / (image.height * fillScale * relativeScale);
  const x = clamp(center.x, width / 2, 1 - width / 2) - width / 2;
  const y = clamp(center.y, height / 2, 1 - height / 2) - height / 2;
  return { x, y, width, height, centerX: x + width / 2, centerY: y + height / 2, relativeScale,
    sourceWidth: image.width * width, sourceHeight: image.height * height };
}

function boxFits(box, crop, margin) {
  if (!box) return true;
  const insetX = Math.min(margin, crop.width / 10), insetY = Math.min(margin, crop.height / 10);
  return box.x >= crop.x + insetX - 1e-9 && box.y >= crop.y + insetY - 1e-9 &&
    box.x + box.width <= crop.x + crop.width - insetX + 1e-9 &&
    box.y + box.height <= crop.y + crop.height - insetY + 1e-9;
}

export function computeMotionGeometry({ image, output, startFrame, endFrame, fps, intent, detection = null, config: inputConfig = {} }) {
  const config = validateMotionConfig(inputConfig);
  if (![image?.width, image?.height, output?.width, output?.height, startFrame, endFrame, fps].every(Number.isFinite) ||
      image.width <= 0 || image.height <= 0 || output.width <= 0 || output.height <= 0 ||
      startFrame < 0 || endFrame <= startFrame || fps <= 0) throw new Error('Invalid image, output, or clip geometry');
  if (!MOTION_INTENT_SCHEMA.properties.kind.enum.includes(intent?.kind) || !['slow', 'fast'].includes(intent?.speed) ||
      typeof intent.anchorId !== 'string') throw new Error('Invalid motion intent');
  const anchors = detectionAnchors(detection);
  const anchor = anchors.find(item => item.id === intent.anchorId) ?? anchors[0];
  const warnings = intent.anchorId !== anchor.id ? ['unknown_anchor_center_fallback'] : [];
  const seconds = (endFrame - startFrame) / fps;
  const center = { x: 0.5, y: 0.5 };
  const full = cropAt(image, output, 1, center);
  const subjectInFull = boxFits(anchor.box, full, config.subjectMargin);
  let first = full, last = full, effectiveKind = intent.kind;
  if (intent.kind.startsWith('zoom_')) {
    const rate = config[`${intent.speed}ZoomRate`];
    const scale = 1 + rate * seconds;
    if (scale > config.maxRelativeScale) warnings.push('zoom_exceeds_quality_scale_limit');
    const anchored = cropAt(image, output, scale, anchor);
    if (Math.abs(anchored.centerX - anchor.x) > 1e-8 || Math.abs(anchored.centerY - anchor.y) > 1e-8) warnings.push('anchor_clamped_for_frame_fill');
    if (!subjectInFull || !boxFits(anchor.box, anchored, config.subjectMargin)) warnings.push('subject_would_be_cropped');
    if (intent.kind === 'zoom_in') { first = full; last = anchored; }
    else { first = anchored; last = full; }
  } else if (intent.kind.startsWith('pan_')) {
    const horizontal = intent.kind === 'pan_left' || intent.kind === 'pan_right';
    const travel = config[`${intent.speed}PanRate`] * seconds;
    const baseWindow = horizontal ? full.width : full.height;
    const scale = travel >= 1 ? Infinity : Math.max(1, baseWindow / (1 - travel));
    if (scale > config.maxRelativeScale) warnings.push('pan_exceeds_quality_scale_limit');
    if (Number.isFinite(scale)) {
      const window = baseWindow / scale;
      const half = window / 2;
      const target = horizontal ? anchor.x : anchor.y;
      const low = clamp(target - travel / 2, half, 1 - half - travel);
      const high = low + travel;
      const reverse = intent.kind === 'pan_left' || intent.kind === 'pan_up';
      const startCenter = { x: horizontal ? reverse ? high : low : anchor.x,
        y: horizontal ? anchor.y : reverse ? high : low };
      const endCenter = { x: horizontal ? reverse ? low : high : anchor.x,
        y: horizontal ? anchor.y : reverse ? low : high };
      const startCrop = cropAt(image, output, scale, startCenter);
      const endCrop = cropAt(image, output, scale, endCenter);
      if (Math.abs((startCrop.centerX + endCrop.centerX) / 2 - anchor.x) > 1e-8 ||
          Math.abs((startCrop.centerY + endCrop.centerY) / 2 - anchor.y) > 1e-8) warnings.push('anchor_clamped_for_frame_fill');
      if (!boxFits(anchor.box, startCrop, config.subjectMargin) || !boxFits(anchor.box, endCrop, config.subjectMargin)) warnings.push('subject_would_be_cropped');
      first = startCrop; last = endCrop;
    }
  }
  if (first === full && last === full && intent.kind !== 'static') effectiveKind = 'static';
  if (intent.kind === 'static' && !subjectInFull) warnings.push('subject_outside_center_crop');
  if (Math.min(first.sourceWidth, last.sourceWidth) < output.width / 2 ||
      Math.min(first.sourceHeight, last.sourceHeight) < output.height / 2) warnings.push('effective_detail_below_half_output');
  return { startFrame, endFrame, durationSeconds: seconds, requestedKind: intent.kind, kind: effectiveKind,
    speed: intent.speed, anchorId: anchor.id, anchorLabel: anchor.label, anchorPoint: { x: anchor.x, y: anchor.y },
    fillScale: Math.max(output.width / image.width, output.height / image.height), startCrop: first, endCrop: last, warnings };
}

export async function planBrollMotion({ beatPlan, selection, provider, model, config = {}, promptOverride = null, signal }) {
  if (!beatPlan || !selection || selection.beatPlanId !== beatPlan.id || !Array.isArray(selection.finalDecisions) ||
      typeof provider?.generateStructuredText !== 'function' || typeof model !== 'string' || !model.trim()) throw new Error('Matching beat/image plans and provider are required');
  const settings = validateMotionConfig(config);
  const fps = beatPlan.timeline.fps.numerator / beatPlan.timeline.fps.denominator;
  const output = { width: beatPlan.timeline.width, height: beatPlan.timeline.height };
  const byBeat = new Map(selection.finalDecisions.map(item => [item.beatId, item]));
  const motions = [], requests = [];
  for (const beat of beatPlan.beats) {
    if (signal?.aborted) throw new Error('Motion planning canceled');
    const imageId = byBeat.get(beat.id)?.selectedImageId;
    if (!imageId) continue;
    const image = beat.search?.response?.results?.find(item => item.imageId === imageId);
    if (!image) throw new Error(`Selected image is not in saved candidates for ${beat.id}`);
    const anchors = detectionAnchors(image.detection);
    const prompt = renderPrompt('motion', { motionContextJson: JSON.stringify({ beatId: beat.id, spokenText: beat.text,
      visualIntent: beat.visualIntent, image: { imageId, filename: image.filename, width: image.width, height: image.height },
      clipSeconds: (beat.endFrame - beat.startFrame) / fps, anchors,
      allowedKinds: MOTION_INTENT_SCHEMA.properties.kind.enum, config: settings }) }, promptOverride);
    const response = await provider.generateStructuredText({ model, systemText: prompt.systemText, userText: prompt.userText,
      outputSchema: MOTION_INTENT_SCHEMA, signal });
    const intent = validatedIntent(response.values);
    const geometry = computeMotionGeometry({ image, output, startFrame: beat.startFrame, endFrame: beat.endFrame,
      fps, intent, detection: image.detection, config: settings });
    motions.push({ beatId: beat.id, imageId, imageVersionId: image.imageVersionId, intent, geometry });
    requests.push({ beatId: beat.id, systemText: prompt.systemText, userText: prompt.userText,
      providerModel: response.providerModel ?? model, providerRequestId: response.providerRequestId ?? null });
  }
  const content = { schemaVersion: 1, beatPlanId: beatPlan.id, selectionId: selection.id,
    handoffId: beatPlan.handoffId, config: settings, motions,
    promptSnapshot: { model, template: renderPrompt('motion', { motionContextJson: '{}' }, promptOverride).template, requests } };
  return { ...content, id: hash(content) };
}

export function validateMotionCatalogImages({ beatPlan, selection, catalogImages }) {
  if (!beatPlan || !selection || selection.beatPlanId !== beatPlan.id ||
      !Array.isArray(selection.finalDecisions) || !Array.isArray(catalogImages)) {
    throw new Error('Matching beat, image, and catalog records are required');
  }
  const current = new Map(catalogImages.map(image => [image.imageId, image]));
  const decisions = new Map(selection.finalDecisions.map(item => [item.beatId, item.selectedImageId]));
  for (const beat of beatPlan.beats) {
    const imageId = decisions.get(beat.id);
    if (!imageId) continue;
    const saved = beat.search?.response?.results?.find(item => item.imageId === imageId);
    const image = current.get(imageId);
    if (!saved || !image || image.imageVersionId !== saved.imageVersionId ||
        !image.active || image.availability !== 'present') {
      throw new Error(`Selected artwork for beat ${beat.id} was replaced, deactivated, or is missing; choose another image before AI motion planning`);
    }
  }
}

export function recalculateBrollMotion({ beatPlan, selection, motion, config }) {
  if (!beatPlan || !selection || !motion || selection.beatPlanId !== beatPlan.id ||
      motion.beatPlanId !== beatPlan.id || motion.selectionId !== selection.id ||
      motion.handoffId !== beatPlan.handoffId || !Array.isArray(motion.motions)) {
    throw new Error('Matching beat, image, and motion plans are required');
  }
  const settings = validateMotionConfig(config);
  if (JSON.stringify(settings) === JSON.stringify(motion.config)) return motion;
  const beats = new Map(beatPlan.beats.map(beat => [beat.id, beat]));
  const choices = new Map(selection.finalDecisions.map(item => [item.beatId, item.selectedImageId]));
  const fps = beatPlan.timeline.fps.numerator / beatPlan.timeline.fps.denominator;
  const output = { width: beatPlan.timeline.width, height: beatPlan.timeline.height };
  const motions = motion.motions.map(item => {
    const beat = beats.get(item.beatId);
    if (!beat || choices.get(item.beatId) !== item.imageId) throw new Error(`Motion image changed for beat ${item.beatId}`);
    const image = beat.search?.response?.results?.find(candidate => candidate.imageId === item.imageId);
    if (!image || image.imageVersionId !== item.imageVersionId) throw new Error(`Motion image unavailable for beat ${item.beatId}`);
    return { ...item, geometry: computeMotionGeometry({ image, output, startFrame: beat.startFrame,
      endFrame: beat.endFrame, fps, intent: item.intent, detection: image.detection, config: settings }) };
  });
  const content = { schemaVersion: motion.schemaVersion, beatPlanId: beatPlan.id, selectionId: selection.id,
    handoffId: beatPlan.handoffId, config: settings, motions, promptSnapshot: motion.promptSnapshot,
    recalculatedFromMotionId: motion.id };
  return { ...content, id: hash(content) };
}

export function brollMotionPath(projectPath, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid B-roll motion ID');
  return join(`${projectPath}.broll-motions`, `${id}.json`);
}

export async function saveBrollMotion(projectPath, plan) {
  const { id, ...content } = plan;
  if (hash(content) !== id) throw new Error('B-roll motion fingerprint mismatch');
  const path = brollMotionPath(projectPath, id);
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(plan)) throw new Error('Existing B-roll motion differs');
    return path;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(plan, null, 2), { flag: 'wx' }); await rename(temporary, path); }
  catch (error) { try { await unlink(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; } throw error; }
  return path;
}

export async function readBrollMotion(projectPath, id) {
  const plan = JSON.parse(await readFile(brollMotionPath(projectPath, id), 'utf8'));
  const { id: actualId, ...content } = plan;
  if (actualId !== id || hash(content) !== id) throw new Error('B-roll motion fingerprint mismatch');
  return plan;
}
