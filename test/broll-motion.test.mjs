import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeMotionGeometry, detectionAnchors, planBrollMotion, readBrollMotion, recalculateBrollMotion, saveBrollMotion, validateMotionConfig } from '../src/broll-motion.mjs';
import { brollPreviewLayout } from '../src/broll-preview-layout.mjs';

const image = { width: 1920, height: 1080 };
const output = { width: 1920, height: 1080 };
const input = (kind, speed = 'slow', anchorId = 'center', extra = {}) => ({ image, output, startFrame: 0, endFrame: 300,
  fps: 30, intent: { kind, speed, anchorId }, ...extra });
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);

test('zoom rate and clip duration set scale while one endpoint remains centered full frame', () => {
  const inside = computeMotionGeometry(input('zoom_in'));
  assert.equal(inside.kind, 'zoom_in');
  approx(inside.startCrop.relativeScale, 1);
  approx(inside.endCrop.relativeScale, 1.2);
  approx(inside.startCrop.centerX, 0.5);
  approx(inside.startCrop.centerY, 0.5);
  const outside = computeMotionGeometry(input('zoom_out', 'fast'));
  approx(outside.startCrop.relativeScale, 1.4);
  approx(outside.endCrop.relativeScale, 1);
  approx(outside.endCrop.centerX, 0.5);
  const tooLong = computeMotionGeometry(input('zoom_in', 'fast', 'center', { endFrame: 900 }));
  assert.equal(tooLong.kind, 'zoom_in');
  assert.ok(tooLong.endCrop.relativeScale > 1.5);
  assert.ok(tooLong.warnings.includes('zoom_exceeds_quality_scale_limit'));
});

test('detected anchors are selected by ID and edge subjects cannot be clipped silently', () => {
  const detection = { faces: [{ label: 'Lucy', x: 0.7, y: 0.4, width: 0.1, height: 0.1 }], objects: [] };
  assert.equal(detectionAnchors(detection)[1].id, 'face:0');
  const result = computeMotionGeometry(input('zoom_in', 'slow', 'face:0', { detection }));
  assert.equal(result.anchorLabel, 'Lucy');
  assert.ok(result.endCrop.x <= 0.7 && result.endCrop.x + result.endCrop.width >= 0.8);
  const unknown = computeMotionGeometry(input('zoom_in', 'slow', 'face:99', { detection }));
  assert.equal(unknown.anchorId, 'center');
  assert.ok(unknown.warnings.includes('unknown_anchor_center_fallback'));
  const portrait = { width: 1080, height: 1920 };
  const edge = { faces: [{ label: 'Far edge', x: 0.1, y: 0.02, width: 0.1, height: 0.1 }] };
  const unsafe = computeMotionGeometry(input('zoom_out', 'slow', 'face:0', { image: portrait, detection: edge }));
  assert.equal(unsafe.kind, 'zoom_out');
  assert.ok(unsafe.startCrop.relativeScale > 1);
  assert.equal(unsafe.endCrop.relativeScale, 1);
  assert.ok(unsafe.warnings.includes('subject_would_be_cropped'));
});

test('all pan directions preserve fill and change center in the requested direction', () => {
  for (const [kind, axis, sign] of [['pan_right', 'X', 1], ['pan_left', 'X', -1], ['pan_down', 'Y', 1], ['pan_up', 'Y', -1]]) {
    const result = computeMotionGeometry(input(kind));
    assert.equal(result.kind, kind);
    const delta = result.endCrop[`center${axis}`] - result.startCrop[`center${axis}`];
    assert.ok(Math.sign(delta) === sign);
    assert.ok(result.startCrop.x >= -1e-8 && result.startCrop.y >= -1e-8);
    assert.ok(result.endCrop.x + result.endCrop.width <= 1 + 1e-8);
    assert.ok(result.endCrop.y + result.endCrop.height <= 1 + 1e-8);
    approx(result.startCrop.relativeScale, result.endCrop.relativeScale);
  }
});

test('half-resolution images remain eligible but magnification warns about effective detail', () => {
  const result = computeMotionGeometry(input('zoom_in', 'slow', 'center', { image: { width: 960, height: 540 } }));
  assert.equal(result.kind, 'zoom_in');
  assert.ok(result.warnings.includes('effective_detail_below_half_output'));
  assert.throws(() => validateMotionConfig({ slowZoomRate: 0.05, fastZoomRate: 0.04 }), /Fast motion/);
});

test('review preview shows the full fill frame so zoom keyframe boxes retain their actual size', () => {
  for (const kind of ['zoom_in', 'zoom_out', 'pan_right', 'static']) {
    const geometry = computeMotionGeometry(input(kind));
    const layout = brollPreviewLayout(geometry);
    const crop = layout.crop;
    approx(layout.widthPercent * crop.width, 100);
    approx(layout.heightPercent * crop.height, 100);
    approx(layout.leftPercent + layout.widthPercent * crop.x, 0);
    approx(layout.topPercent + layout.heightPercent * crop.y, 0);
    approx(crop.width, 1);
    approx(crop.height, 1);
    if (kind.startsWith('zoom_')) {
      const keyframe = kind === 'zoom_in' ? geometry.endCrop : geometry.startCrop;
      assert.ok(keyframe.width < crop.width);
      assert.ok(keyframe.height < crop.height);
    }
  }
  const portrait = computeMotionGeometry(input('zoom_out', 'slow', 'center',
    { image: { width: 1080, height: 1920 } }));
  const layout = brollPreviewLayout(portrait);
  assert.ok(layout.crop.height < 1);
  assert.ok(portrait.startCrop.height < layout.crop.height);
  approx(layout.crop.y, (1 - layout.crop.height) / 2);
});

test('motion agent uses local detections, stores deterministic crops and no artwork paths', async () => {
  const beatPlan = { id: 'beats', handoffId: 'handoff', timeline: { fps: { numerator: 30, denominator: 1 }, width: 1920, height: 1080 },
    beats: [{ id: 'b1', text: 'Lucy finds the lantern.', visualIntent: 'Lucy at the lamp', startFrame: 0, endFrame: 180,
      search: { response: { results: [{ imageId: 'image-1', imageVersionId: 'version-1', filename: 'lantern.png', path: 'C:\secret\lantern.png',
        width: 1920, height: 1080, detection: { faces: [{ label: 'Lucy', x: 0.45, y: 0.35, width: 0.1, height: 0.2 }] } }] } } }] };
  const selection = { id: 'selection', beatPlanId: 'beats', finalDecisions: [{ beatId: 'b1', selectedImageId: 'image-1' }] };
  const plan = await planBrollMotion({ beatPlan, selection, model: 'test-model',
    provider: { async generateStructuredText(request) {
      assert.ok(!request.userText.includes('C:\secret'));
      assert.ok(request.userText.includes('face:0'));
      return { values: { kind: 'zoom_in', speed: 'slow', anchorId: 'face:0', reason: 'Guide toward Lucy.' } };
    } } });
  assert.equal(plan.motions[0].geometry.anchorId, 'face:0');
  assert.ok(!JSON.stringify(plan).includes('C:\secret'));
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-broll-motion-'));
  await saveBrollMotion(join(directory, 'project.json'), plan);
  assert.equal((await readBrollMotion(join(directory, 'project.json'), plan.id)).id, plan.id);
  const updated = recalculateBrollMotion({ beatPlan, selection, motion: plan,
    config: { slowZoomRate: 0.03, fastZoomRate: 0.05 } });
  assert.notEqual(updated.id, plan.id);
  assert.equal(updated.recalculatedFromMotionId, plan.id);
  assert.deepEqual(updated.motions[0].intent, plan.motions[0].intent);
  assert.equal(updated.motions[0].imageId, plan.motions[0].imageId);
  assert.ok(updated.motions[0].geometry.endCrop.relativeScale > plan.motions[0].geometry.endCrop.relativeScale);
  assert.equal(plan.config.slowZoomRate, 0.02);
  assert.equal(recalculateBrollMotion({ beatPlan, selection, motion: plan, config: plan.config }), plan);
  await saveBrollMotion(join(directory, 'project.json'), updated);
  assert.equal((await readBrollMotion(join(directory, 'project.json'), updated.id)).id, updated.id);
});
