import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTimeline, outwardFrames } from '../src/timeline.mjs';
import { premiereXml } from '../src/premiere-xml.mjs';

test('outward rounding protects both word edges', () => {
  assert.deepEqual(outwardFrames(0.101, 0.199, 30), { inFrame: 3, outFrame: 6 });
  assert.deepEqual(outwardFrames(0.1, 0.2, 30), { inFrame: 3, outFrame: 6 });
  assert.throws(() => outwardFrames(-1, 1, 30));
  assert.throws(() => outwardFrames(1, 1, 30));
});

const sources = { a: { fps: 30, frames: 90, path: '/tmp/a & b.mov' }, b: { fps: 30, frames: 90, path: '/tmp/b.mov' } };
test('23.976 footage keeps rational rate and correct 4K dimensions in XML', () => {
  const fps = { numerator: 24000, denominator: 1001 };
  assert.deepEqual(outwardFrames(1001, 1002, fps), { inFrame: 24000, outFrame: 24024 });
  const media = { camera: { fps, frames: 40584, width: 3840, height: 2160, channels: 2, path: '/tmp/camera.mov' } };
  const timeline = compileTimeline([{ sourceId: 'camera', inFrame: 0, outFrame: 40584 }], media, fps);
  assert.equal(timeline.duration * fps.denominator / fps.numerator, 1692.691);
  const xml = premiereXml(timeline, media);
  assert.match(xml, /<timebase>24<\/timebase><ntsc>TRUE<\/ntsc>/);
  assert.match(xml, /<width>3840<\/width>/);
  assert.match(xml, /<value>50<\/value>/);
});
test('camera file edges survive and placements are contiguous', () => {
  const timeline = compileTimeline([{ sourceId: 'a', inFrame: 30, outFrame: 90 }, { sourceId: 'b', inFrame: 0, outFrame: 45 }], sources);
  assert.equal(timeline.duration, 105);
  assert.equal(timeline.intervals[0].outFrame, 90);
  assert.equal(timeline.intervals[1].inFrame, 0);
  assert.equal(timeline.intervals[0].end, timeline.intervals[1].start);
});

test('reject unavailable media, out-of-bounds ranges, fractional frames and unsupported rates', () => {
  for (const clip of [{ sourceId: 'x', inFrame: 0, outFrame: 1 }, { sourceId: 'a', inFrame: 0, outFrame: 91 }, { sourceId: 'a', inFrame: 0.5, outFrame: 1 }]) {
    assert.throws(() => compileTimeline([clip], sources));
  }
  assert.throws(() => compileTimeline([{ sourceId: 'a', inFrame: 0, outFrame: 30 }], sources, 24));
});

test('XML uses FCP7, escaped paths and linked video/audio intervals', () => {
  const xml = premiereXml(compileTimeline([{ sourceId: 'a', inFrame: 10, outFrame: 30 }], sources), sources);
  assert.match(xml, /xmeml version="5"/);
  assert.equal((xml.match(/<in>10<\/in>/g) || []).length, 2);
  assert.equal((xml.match(/<end>20<\/end>/g) || []).length, 2);
  assert.match(xml, /a%20&amp;%20b.mov/);
  assert.match(xml, /<linkclipref>audio-0<\/linkclipref>/);
});
