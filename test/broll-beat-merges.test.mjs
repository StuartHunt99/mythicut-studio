import test from 'node:test';
import assert from 'node:assert/strict';
import { appendBrollMerge, mergeBrollDecision, mergedBrollPlan, validateBrollMerges } from '../src/broll-beat-merges.mjs';
import { appendBrollOverride, rebaseBrollOverrides, resolvedBrollDecisions } from '../src/broll-overrides.mjs';
import { computeMotionGeometry } from '../src/broll-motion.mjs';
import { buildBrollReviewData } from '../src/broll-review.mjs';
import { compileBrollTimeline } from '../src/broll-timeline.mjs';
import { premiereBrollXml } from '../src/broll-xml.mjs';
import { createProject, openProject, saveProject } from '../src/project.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const image = name => ({ imageId: name, imageVersionId: `${name}-version`, revisionId: `${name}-revision`,
  filename: `${name}.png`, width: 2560, height: 1440, detection: { faces: [], objects: [] } });
const images = [image('one'), image('two'), image('three')];
const fps = { numerator: 30, denominator: 1 };
const timeline = { width: 1920, height: 1080, duration: 450, fps };
const beatPlan = { id: 'a'.repeat(64), timeline, artworkMinimumSeconds: 4, beats: images.map((item, index) => ({
  id: ['first', 'second', 'third'][index], startIndex: index * 10, endIndex: (index + 1) * 10 - 1,
  startWordId: `w${index * 10}`, endWordId: `w${(index + 1) * 10 - 1}`,
  startFrame: index * 150, endFrame: (index + 1) * 150,
  wordStartFrame: index * 150 + 1, wordEndFrame: (index + 1) * 150 - 1,
  text: `Passage ${index + 1}.`, artworkNeed: 'required', talkingHeadPriority: 'normal',
  previousSentence: index ? `Passage ${index}.` : null,
  nextSentence: index < 2 ? `Passage ${index + 2}.` : null,
  opening: index === 0, closing: index === 2, establishing: false,
  warnings: [], searchStatus: 'candidates', search: { query: { semanticText: `Passage ${index + 1}.` },
    response: { results: [item], resultCount: 1 } }
})) };
const selection = { id: 'b'.repeat(64), beatPlanId: beatPlan.id,
  finalDecisions: beatPlan.beats.map((beat, index) => ({ beatId: beat.id, selectedImageId: images[index].imageId })) };
const motion = { id: 'c'.repeat(64), selectionId: selection.id, config: {},
  motions: beatPlan.beats.map((beat, index) => {
    const intent = { kind: 'zoom_in', speed: 'slow', anchorId: 'center' };
    return { beatId: beat.id, imageId: images[index].imageId, imageVersionId: images[index].imageVersionId,
      intent, geometry: computeMotionGeometry({ image: images[index], output: timeline,
        startFrame: beat.startFrame, endFrame: beat.endFrame, fps: 30, intent }) };
  }) };
const catalogImages = images.map(item => ({ ...item, active: true, availability: 'present',
  reviewState: 'accepted', path: `C:\\fixture\\${item.filename}` }));
const compiled = { timeline: { ...timeline, intervals: [
  { sourceId: 'host', start: 0, end: 450, inFrame: 0, outFrame: 450 }
] }, sources: { host: { path: 'C:\\fixture\\host.mov', width: 1920,
  height: 1080, frames: 450, channels: 1 } } };

test('merge up keeps the upper image, spans both locked ranges, and carries both suggestion lists into XML', () => {
  const merge = mergeBrollDecision({ beatPlan, selection, motion, beatId: 'second', direction: 'up' });
  const plan = merge.beatPlan;
  assert.deepEqual(plan.beats.map(beat => beat.id), ['first', 'third']);
  assert.deepEqual(plan.beats[0].memberBeatIds, ['first', 'second']);
  assert.equal(plan.beats[0].text, 'Passage 1. Passage 2.');
  assert.deepEqual([plan.beats[0].startFrame, plan.beats[0].endFrame], [0, 300]);
  assert.deepEqual(plan.beats[0].search.response.results.map(item => item.imageId), ['one', 'two']);
  const overrides = merge.overrides;
  const review = buildBrollReviewData({ beatPlan: plan, selection, motion, overrides, catalogImages });
  assert.equal(review.beats[0].selectedImageId, 'one');
  assert.deepEqual(review.beats[0].candidates.map(item => item.imageId), ['one', 'two']);
  const broll = compileBrollTimeline({ compiled, beatPlan: plan, selection, motion, overrides, review });
  assert.deepEqual(broll.tracks.map(track => track.map(clip => clip.beatId)), [['third'], ['first']]);
  assert.deepEqual([broll.tracks[1][0].start, broll.tracks[1][0].end], [0, 300]);
  assert.equal(broll.tracks[1][0].geometry.endFrame, 300);
  assert.doesNotMatch(premiereBrollXml(broll), /two\.png/);
});

test('merge down retains the lower image and can merge an already grouped neighbor', () => {
  const first = mergeBrollDecision({ beatPlan, selection, motion, beatId: 'first', direction: 'down' });
  assert.equal(first.targetBeatId, 'second');
  assert.equal(first.beatPlan.beats[0].text, 'Passage 1. Passage 2.');
  assert.deepEqual(first.beatPlan.beats[0].search.response.results.map(item => item.imageId), ['two', 'one']);
  const second = mergeBrollDecision({ beatPlan, selection, motion, merges: first.merges,
    overrides: first.overrides, beatId: 'second', direction: 'down' });
  assert.deepEqual(second.beatPlan.beats.map(beat => beat.id), ['third']);
  assert.deepEqual(second.beatPlan.beats[0].memberBeatIds, ['first', 'second', 'third']);
  assert.deepEqual(second.beatPlan.beats[0].search.response.results.map(item => item.imageId), ['three', 'two', 'one']);
  assert.equal(resolvedBrollDecisions({ beatPlan: second.beatPlan, selection, motion,
    overrides: second.overrides })[0].imageId, 'three');
  assert.throws(() => appendBrollMerge({ beatPlan, selection, beatId: 'first', direction: 'up' }), /adjacent/);
  assert.throws(() => validateBrollMerges([{ beatPlanId: beatPlan.id, selectionId: selection.id,
    targetBeatId: 'first', donorBeatId: 'first', createdAt: new Date().toISOString() }]), /Invalid/);
});

test('a donor suggestion can be selected later, and motion recalculation skips obsolete donor intervals', () => {
  const donorOverrides = appendBrollOverride({ beatPlan, selection, motion, beatId: 'second', imageId: 'two' });
  const merge = appendBrollMerge({ beatPlan, selection, overrides: donorOverrides,
    beatId: 'second', direction: 'up' });
  const overrides = appendBrollOverride({ beatPlan: merge.beatPlan, selection, motion,
    overrides: donorOverrides, beatId: 'first', imageId: 'one' });
  const changed = appendBrollOverride({ beatPlan: merge.beatPlan, selection, motion,
    overrides, beatId: 'first', imageId: 'two' });
  assert.equal(resolvedBrollDecisions({ beatPlan: merge.beatPlan, selection, motion,
    overrides: changed })[0].imageId, 'two');
  const updatedMotion = { ...motion, id: 'd'.repeat(64), config: { slowZoomRate: 0.03 } };
  const rebased = rebaseBrollOverrides({ beatPlan: merge.beatPlan, selection, motion, updatedMotion,
    overrides: changed, omitObsolete: true });
  assert.equal(rebased.length, changed.length + 2);
  assert.equal(rebased.at(-1).endFrame, 300);
  assert.equal(rebased.at(-1).imageId, 'two');
});

test('a donor manual-search suggestion moves into the target without taking its image assignment', () => {
  const searched = image('searched');
  const donor = appendBrollOverride({ beatPlan, selection, motion, beatId: 'second',
    imageId: searched.imageId, candidate: searched });
  const merge = mergeBrollDecision({ beatPlan, selection, motion, overrides: donor,
    beatId: 'second', direction: 'up' });
  assert.equal(merge.overrides.at(-1).imageId, 'one');
  assert.deepEqual(merge.beatPlan.beats[0].search.response.results.map(item => item.imageId),
    ['one', 'two', 'searched']);
  const chosenLater = appendBrollOverride({ beatPlan: merge.beatPlan, selection, motion,
    overrides: merge.overrides, beatId: 'first', imageId: searched.imageId });
  assert.equal(chosenLater.at(-1).imageId, searched.imageId);
  const noImage = { ...selection, finalDecisions: selection.finalDecisions.map(item =>
    item.beatId === 'first' ? { ...item, selectedImageId: null } : item) };
  const clearMerge = mergeBrollDecision({ beatPlan, selection: noImage, motion,
    beatId: 'second', direction: 'up' });
  assert.equal(clearMerge.overrides.at(-1).imageId, null);
  assert.equal(resolvedBrollDecisions({ beatPlan: clearMerge.beatPlan, selection: noImage,
    motion, overrides: clearMerge.overrides })[0].imageId, null);
});

test('merge decisions survive project save and reopen without changing the source beat artifact', async () => {
  const merge = appendBrollMerge({ beatPlan, selection, beatId: 'second', direction: 'up' });
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-broll-merge-'));
  const path = join(directory, 'project.json');
  await saveProject(path, { ...createProject(), brollMerges: merge.merges });
  const reopened = (await openProject(path)).project;
  assert.deepEqual(reopened.brollMerges, merge.merges);
  assert.deepEqual(mergedBrollPlan({ beatPlan, selection, merges: reopened.brollMerges }).beats[0].memberBeatIds,
    ['first', 'second']);
  assert.deepEqual(beatPlan.beats.map(beat => beat.id), ['first', 'second', 'third']);
});
