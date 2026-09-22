import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTimeline } from '../src/timeline.mjs';
import { brollPremiereFixtureXml } from '../scripts/broll-premiere-fixture-xml.mjs';

const sources = { host: { path: '/tmp/synthetic-host.mov', fps: 30, frames: 90, width: 960, height: 540, channels: 1 } };
const timeline = { ...compileTimeline([{ sourceId: 'host', inFrame: 0, outFrame: 90 }], sources), width: 1920, height: 1080 };
const clip = (start, end) => ({ path: '/tmp/landscape & more.png', width: 2560, height: 1440, start, end, motion: { start: { scale: 75, x: 0, y: 0 }, end: { scale: 90, x: -0.05, y: 0 } } });

test('M0 fixture adds direct stills and only sparse upper-track clips', () => {
  const xml = brollPremiereFixtureXml(timeline, sources, [[clip(0, 60)], [clip(30, 60)]]);
  assert.equal((xml.match(/<video><format>/g) ?? []).length, 1);
  assert.equal((xml.match(/<video><format>.*?<\/format><track>/g) ?? []).length, 1);
  assert.equal((xml.match(/<stillframe>TRUE<\/stillframe>/g) ?? []).length, 3); // Host diagnostic still plus two artwork stills
  assert.match(xml, /landscape%20&amp;%20more\.png/);
  assert.match(xml, /<clipitem id="fixture-art-3-0-[a-f0-9]{12}">.*?<start>30<\/start><end>60<\/end>/s);
  assert.match(xml, /<parameterid>scale<\/parameterid>.*?<when>0<\/when><value>75<\/value>.*?<when>60<\/when><value>90<\/value>/s);
  assert.match(xml, /<parameterid>center<\/parameterid>.*?<horiz>-0\.05<\/horiz>/s);
  assert.equal((xml.match(/<track>/g) ?? []).length, 4); // V1, V2, V3, A1
});

test('M0 fixture gives distinct XML identities to different source locations', () => {
  const first = brollPremiereFixtureXml(timeline, sources, [[clip(0, 60)]]);
  const second = brollPremiereFixtureXml(timeline, sources, [[{ ...clip(0, 60), path: '/tmp/other/landscape & more.png' }]]);
  assert.notEqual(first.match(/<clipitem id="(fixture-art-[^"]+)/)[1], second.match(/<clipitem id="(fixture-art-[^"]+)/)[1]);
  assert.notEqual(first.match(/<sequence id="([^"]+)/)[1], second.match(/<sequence id="([^"]+)/)[1]);
});

test('M0 fixture rejects invalid motion and same-track overlaps', () => {
  assert.throws(() => brollPremiereFixtureXml(timeline, sources, [[clip(0, 60), clip(59, 90)]]), /overlap/i);
  assert.throws(() => brollPremiereFixtureXml(timeline, sources, [[clip(-1, 60)]]), /interval/i);
  assert.throws(() => brollPremiereFixtureXml(timeline, sources, [[{ ...clip(0, 60), motion: { start: { scale: NaN, x: 0, y: 0 }, end: { scale: 90, x: 0, y: 0 } } }]]), /motion/i);
  assert.throws(() => brollPremiereFixtureXml(timeline, sources, [[{ ...clip(0, 60), motion: { start: { scale: 75, x: 5, y: 0 }, end: { scale: 90, x: 0, y: 0 } } }]]), /motion/i);
});
