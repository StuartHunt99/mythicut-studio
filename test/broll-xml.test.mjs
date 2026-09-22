import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { computeMotionGeometry } from '../src/broll-motion.mjs';
import { compileBrollTimeline } from '../src/broll-timeline.mjs';
import { cropToPremiereMotion, premiereBrollXml } from '../src/broll-xml.mjs';
import { premiereXml } from '../src/premiere-xml.mjs';

const id = char => char.repeat(64);
const image = (imageId, filename) => ({ imageId, imageVersionId: `${imageId}-version`, revisionId: `${imageId}-revision`,
  filename, width: 2560, height: 1440, detection: { faces: [], objects: [] } });
const one = image('one', 'one & only.png'), two = image('two', 'two.png');
const fps = { numerator: 30, denominator: 1 };
const output = { width: 1920, height: 1080 };
const beatPlan = { id: id('a'), timeline: { ...output, fps, duration: 360 }, beats: [
  { id: 'first', startFrame: 0, endFrame: 180, search: { response: { results: [one, two] } } },
  { id: 'second', startFrame: 180, endFrame: 360, search: { response: { results: [one, two] } } }
] };
const selection = { id: id('b'), beatPlanId: beatPlan.id, finalDecisions: [
  { beatId: 'first', selectedImageId: 'one' }, { beatId: 'second', selectedImageId: 'two' }
] };
const motion = { id: id('c'), selectionId: selection.id, motions: beatPlan.beats.map((beat, index) => {
  const selected = index ? two : one;
  return { beatId: beat.id, imageVersionId: selected.imageVersionId,
    geometry: computeMotionGeometry({ image: selected, output, startFrame: beat.startFrame,
      endFrame: beat.endFrame, fps: 30, intent: { kind: index ? 'zoom_out' : 'zoom_in', speed: 'slow', anchorId: 'center' } }) };
}) };
const compiled = { timeline: { ...beatPlan.timeline, intervals: [
  { sourceId: 'host', start: 0, end: 360, inFrame: 0, outFrame: 360 }
] }, sources: { host: { path: 'C:\\fixture\\host.mov', frames: 360, width: 1920, height: 1080, channels: 1 } } };
const review = { beatPlanId: beatPlan.id, selectionId: selection.id, motionId: motion.id,
  beats: beatPlan.beats.map(beat => ({ id: beat.id, candidates: [one, two].map(item => ({ ...item, usable: true,
    previewUrl: pathToFileURL(`C:\\fixture\\${item.filename}`).href })) })) };

test('B-roll export preserves phase-1 audio and stacks sparse still tracks', () => {
  const overrideGeometry = computeMotionGeometry({ image: two, output, startFrame: 0, endFrame: 180,
    fps: 30, intent: { kind: 'pan_right', speed: 'slow', anchorId: 'center' } });
  const overrides = [{ beatPlanId: beatPlan.id, selectionId: selection.id, motionId: motion.id,
    beatId: 'first', startFrame: 0, endFrame: 180, imageId: 'two', imageVersionId: two.imageVersionId,
    revisionId: two.revisionId,
    geometry: overrideGeometry, intent: { kind: 'pan_right', speed: 'slow', anchorId: 'center' }, layer: 1 }];
  const broll = compileBrollTimeline({ compiled, beatPlan, selection, motion, overrides, review });
  assert.deepEqual(broll.tracks.map(track => track.map(clip => clip.beatId)), [['first', 'second'], ['first']]);
  const xml = premiereBrollXml(broll);
  const original = premiereXml(compiled.timeline, compiled.sources);
  assert.equal(xml.slice(xml.indexOf('<audio><numOutputChannels>')),
    original.slice(original.indexOf('<audio><numOutputChannels>')));
  assert.equal((xml.match(/<stillframe>TRUE<\/stillframe>/g) ?? []).length, 3);
  assert.equal((xml.match(/<track>/g) ?? []).length, 4); // host video, base artwork, override, audio
  assert.match(xml, /one &amp; only\.png/);
  assert.match(xml, /<parameterid>scale<\/parameterid>.*?<when>0<\/when><value>75<\/value>/s);
  assert.match(xml, /<parameterid>center<\/parameterid>.*?<horiz>[^<]+<\/horiz>/s);
});

test('clearing a beat removes every underlying still for that interval', () => {
  const overrides = [{ beatPlanId: beatPlan.id, selectionId: selection.id, motionId: motion.id,
    beatId: 'first', startFrame: 0, endFrame: 180, imageId: null, geometry: null, intent: null, layer: 1 }];
  const broll = compileBrollTimeline({ compiled, beatPlan, selection, motion, overrides, review });
  assert.deepEqual(broll.tracks.map(track => track.map(clip => clip.beatId)), [['second']]);
  assert.equal((premiereBrollXml(broll).match(/<stillframe>TRUE<\/stillframe>/g) ?? []).length, 1);
});

test('stale plans and changed catalog artwork cannot reach XML', () => {
  assert.throws(() => compileBrollTimeline({ compiled: { ...compiled, timeline: { ...compiled.timeline, duration: 361 } },
    beatPlan, selection, motion, review }), /does not match/);
  const changed = structuredClone(review); changed.beats[0].candidates[0].usable = false;
  assert.throws(() => compileBrollTimeline({ compiled, beatPlan, selection, motion, review: changed }), /unavailable/);
  const staleMotion = structuredClone(motion); staleMotion.motions[0].imageVersionId = 'different-version';
  assert.throws(() => compileBrollTimeline({ compiled, beatPlan, selection, motion: staleMotion, review }), /unavailable/);
});

test('crop coordinates map to Premiere scale and source-relative center', () => {
  const geometry = motion.motions[0].geometry;
  const endpoint = cropToPremiereMotion(geometry.endCrop, one, output);
  assert.ok(endpoint.scale > 75);
  assert.equal(endpoint.x, 0);
  assert.equal(endpoint.y, 0);
  const shifted = { ...geometry.endCrop, centerX: geometry.endCrop.centerX + 0.05 };
  shifted.x = shifted.centerX - shifted.width / 2;
  assert.equal(cropToPremiereMotion(shifted, one, output).x, Number((-0.05 * endpoint.scale / 100).toFixed(6)));
});

test('portrait stills retain fill framing and rational NTSC rate', () => {
  const portrait = { imageId: 'portrait', width: 1200, height: 1800 };
  const geometry = computeMotionGeometry({ image: portrait, output, startFrame: 0, endFrame: 240,
    fps: 24000 / 1001, intent: { kind: 'zoom_out', speed: 'slow', anchorId: 'center' } });
  const rate = { numerator: 24000, denominator: 1001 };
  const timeline = { width: 1920, height: 1080, fps: rate, duration: 240,
    intervals: [{ sourceId: 'host', start: 0, end: 240, inFrame: 0, outFrame: 240 }] };
  const xml = premiereBrollXml({ timeline, sources: { host: { ...compiled.sources.host, frames: 240 } },
    tracks: [[{ ...portrait, beatId: 'portrait-beat', filename: 'portrait.png',
      path: 'C:\\fixture\\portrait.png', start: 0, end: 240, geometry }]] });
  assert.match(xml, /<timebase>24<\/timebase><ntsc>TRUE<\/ntsc>/);
  assert.match(xml, /<width>1200<\/width><height>1800<\/height>/);
  assert.match(xml, /<parameterid>scale<\/parameterid>.*?<when>240<\/when><value>160<\/value>/s);
  assert.equal((xml.match(/<stillframe>TRUE<\/stillframe>/g) ?? []).length, 1);
});
