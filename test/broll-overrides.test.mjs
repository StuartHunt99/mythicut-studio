import test from 'node:test';
import assert from 'node:assert/strict';
import { appendBrollOverride, rebaseBrollOverrides, resolvedBrollDecisions, validateBrollOverrides } from '../src/broll-overrides.mjs';
import { DEFAULT_MOTION_CONFIG, computeMotionGeometry } from '../src/broll-motion.mjs';
import { createProject, validateProject } from '../src/project.mjs';
import { saveProject, openProject } from '../src/project.mjs';
import { buildBrollReviewData } from '../src/broll-review.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ids = { beatPlan: 'a'.repeat(64), selection: 'b'.repeat(64), motion: 'c'.repeat(64) };
const candidate = (id, filename) => ({ imageId: id, imageVersionId: `${id}-version`, revisionId: `${id}-revision`,
  filename, width: 1920, height: 1080, detection: { faces: [{ label: 'Lucy', x: 0.45, y: 0.35, width: 0.1, height: 0.2 }] } });
const beatPlan = { id: ids.beatPlan, timeline: { fps: { numerator: 30, denominator: 1 }, width: 1920, height: 1080 },
  beats: [{ id: 'first', startFrame: 0, endFrame: 180, search: { response: { results: [candidate('one', 'one.png'), candidate('two', 'two.png')] } } },
    { id: 'second', startFrame: 180, endFrame: 360, search: { response: { results: [candidate('three', 'three.png')] } } }] };
const selection = { id: ids.selection, beatPlanId: ids.beatPlan,
  finalDecisions: [{ beatId: 'first', selectedImageId: 'one', reason: 'Initial fit.' },
    { beatId: 'second', selectedImageId: 'three', reason: 'Another fit.' }] };
const motion = { id: ids.motion, selectionId: ids.selection, config: DEFAULT_MOTION_CONFIG,
  motions: [{ beatId: 'first', imageVersionId: 'one-version', intent: { kind: 'zoom_in', speed: 'slow', anchorId: 'center' },
    geometry: computeMotionGeometry({ image: candidate('one', 'one.png'), output: { width: 1920, height: 1080 },
      startFrame: 0, endFrame: 180, fps: 30, intent: { kind: 'zoom_in', speed: 'slow', anchorId: 'center' } }) },
    { beatId: 'second', imageVersionId: 'three-version', intent: { kind: 'zoom_out', speed: 'slow', anchorId: 'center' },
      geometry: computeMotionGeometry({ image: candidate('three', 'three.png'), output: { width: 1920, height: 1080 },
        startFrame: 180, endFrame: 360, fps: 30, intent: { kind: 'zoom_out', speed: 'slow', anchorId: 'center' } }) }] };

test('each manual edit appends one sparse, beat-bounded layer without replacing other decisions', () => {
  const one = appendBrollOverride({ beatPlan, selection, motion, overrides: [], beatId: 'first', imageId: 'two',
    kind: 'pan_right', speed: 'fast', anchorId: 'face:0', clock: () => new Date('2026-01-01T00:00:00Z') });
  assert.equal(one.length, 1);
  assert.equal(one[0].startFrame, 0);
  assert.equal(one[0].endFrame, 180);
  assert.equal(one[0].layer, 1);
  assert.equal(one[0].geometry.kind, 'pan_right');
  let resolved = resolvedBrollDecisions({ beatPlan, selection, motion, overrides: one });
  assert.deepEqual(resolved.map(item => item.imageId), ['two', 'three']);
  assert.deepEqual(resolved.map(item => item.trackLayer), [1, 0]);
  const two = appendBrollOverride({ beatPlan, selection, motion, overrides: one, beatId: 'first', imageId: null });
  resolved = resolvedBrollDecisions({ beatPlan, selection, motion, overrides: two });
  assert.deepEqual(resolved.map(item => item.imageId), [null, 'three']);
  assert.equal(resolved[0].geometry, null);
  assert.equal(two[0].imageId, 'two');
  assert.equal(two[1].layer, 2);
  const project = validateProject({ ...createProject(), brollOverrides: two });
  assert.equal(project.brollOverrides.length, 2);
});

test('invalid candidates, short clips, and malformed layers cannot override the locked beat', () => {
  assert.throws(() => appendBrollOverride({ beatPlan, selection, motion, beatId: 'first', imageId: 'invented' }), /saved candidate/);
  const short = { ...beatPlan, beats: [{ ...beatPlan.beats[0], endFrame: 120 }] };
  assert.throws(() => appendBrollOverride({ beatPlan: short, selection, motion, beatId: 'first', imageId: 'one' }), /five seconds/);
  const valid = appendBrollOverride({ beatPlan, selection, motion, beatId: 'first', imageId: null });
  assert.throws(() => validateBrollOverrides([{ ...valid[0], layer: 3 }]), /Invalid B-roll override/);
});

test('local rate update preserves manual image and clear layers while recalculating their geometry', () => {
  const first = appendBrollOverride({ beatPlan, selection, motion, beatId: 'first', imageId: 'two',
    kind: 'zoom_in', speed: 'slow', anchorId: 'face:0' });
  const original = appendBrollOverride({ beatPlan, selection, motion, overrides: first,
    beatId: 'second', imageId: null });
  const updatedMotion = { ...motion, id: 'd'.repeat(64), config: { ...DEFAULT_MOTION_CONFIG,
    slowZoomRate: 0.03, fastZoomRate: 0.05 } };
  const rebased = rebaseBrollOverrides({ beatPlan, selection, motion, updatedMotion,
    overrides: original, clock: () => new Date('2026-01-02T00:00:00Z') });
  assert.equal(rebased.length, 4);
  assert.deepEqual(rebased.slice(0, 2), original);
  assert.deepEqual(rebased.slice(2).map(item => [item.layer, item.motionId, item.imageId]),
    [[3, updatedMotion.id, 'two'], [4, updatedMotion.id, null]]);
  assert.deepEqual(rebased[2].intent, original[0].intent);
  assert.ok(rebased[2].geometry.endCrop.relativeScale > original[0].geometry.endCrop.relativeScale);
  assert.equal(rebased[3].geometry, null);
  assert.deepEqual(resolvedBrollDecisions({ beatPlan, selection, motion: updatedMotion,
    overrides: rebased }).map(item => item.imageId), ['two', null]);
  assert.equal(rebaseBrollOverrides({ beatPlan, selection, motion, updatedMotion: motion,
    overrides: original }), original);
});

test('manual layers survive project reopen and review resolves current catalog availability', async () => {
  const overrides = appendBrollOverride({ beatPlan, selection, motion, beatId: 'first', imageId: 'two',
    kind: 'zoom_in', speed: 'slow', anchorId: 'face:0' });
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-broll-overrides-'));
  const projectPath = join(directory, 'project.json');
  await saveProject(projectPath, { ...createProject(), brollOverrides: overrides });
  const reopened = (await openProject(projectPath)).project;
  const current = [candidate('one', 'one.png'), candidate('two', 'two.png'), candidate('three', 'three.png')]
    .map(item => ({ imageId: item.imageId, imageVersionId: item.imageVersionId, revisionId: item.revisionId,
      path: join(directory, item.filename), active: true, availability: 'present', reviewState: 'accepted' }));
  const view = buildBrollReviewData({ beatPlan, selection, motion, overrides: reopened.brollOverrides, catalogImages: current });
  assert.equal(view.beats[0].selectedImageId, 'two');
  assert.equal(view.beats[0].trackLayer, 1);
  assert.equal(view.beats[0].candidates.length, 2);
  assert.equal(view.beats[0].candidates[1].revisionId, 'two-revision');
  assert.match(view.beats[0].candidates[1].previewUrl, /^file:/);
  assert.equal(view.beats[1].selectedImageId, 'three');
  assert.equal(view.beats[1].trackLayer, 0);
  const moved = buildBrollReviewData({ beatPlan, selection, motion, overrides: reopened.brollOverrides,
    catalogImages: current.map(item => item.imageId === 'two' ? { ...item, imageVersionId: 'changed' } : item) });
  assert.equal(moved.beats[0].selectedUsable, false);
  assert.equal(moved.beats[0].candidates[1].previewUrl, null);
});
