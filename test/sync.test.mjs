import test from 'node:test';
import assert from 'node:assert/strict';
import { spectralFeatures, matchFeatures, ANALYSIS_RATE } from '../src/sync/features.mjs';
import { createProject, validateProject } from '../src/project.mjs';
import { solveSession, currentSync, requireSync, adjustSync } from '../src/sync/session.mjs';
import { compileSyncReview, attachDialogue, dialogueSegments, mediaSources } from '../src/sync/timeline.mjs';
import { premiereXml } from '../src/premiere-xml.mjs';
import { compileTimeline } from '../src/timeline.mjs';

function recording(id, duration, video = false) {
  return { id, path: `/recordings/${id}.${video ? 'mov' : 'wav'}`, filename: `${id}.${video ? 'mov' : 'wav'}`,
    identity: { size: 1, mtimeMs: 1 }, duration,
    video: video ? { index: 0, width: 1920, height: 1080, frameRate: '30/1', startTime: '0' } : null,
    audio: [{ index: video ? 1 : 0, channels: 1, sampleRate: '48000', startTime: '0' }],
    selectedAudio: { streamIndex: video ? 1 : 0, channel: 0 } };
}
const edge = (a, b, offset) => ({ a, b, offset, confidence: 0.9, driftSeconds: 0, driftPpm: 0, anchors: [{ a: 0, b: -offset }, { a: 4, b: 4 - offset }] });

function signal(duration, seed = 1) {
  let state = seed, level = 0.1;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  return Float32Array.from({ length: Math.round(duration * ANALYSIS_RATE) }, (_, i) => {
    if (i % 731 === 0) level = 0.02 + random() ** 2;
    return (random() * 2 - 1) * level;
  });
}
const slice = (samples, start, end) => samples.slice(Math.round(start * ANALYSIS_RATE), Math.round(end * ANALYSIS_RATE));

test('spectral matcher handles different gain, polarity, and partial overlaps in either direction', () => {
  const source = signal(32);
  const a = spectralFeatures(slice(source, 0, 22));
  const b = spectralFeatures(Float32Array.from(slice(source, 12, 32), value => -0.3 * value));
  const ab = matchFeatures(a, b), ba = matchFeatures(b, a);
  assert.ok(ab); assert.ok(ba);
  assert.ok(Math.abs(ab.offset - 12) <= 0.02);
  assert.ok(Math.abs(ba.offset + 12) <= 0.02);
  assert.ok(ab.anchors.length >= 2);
});

test('silence and unrelated recordings cannot receive a confident match', () => {
  const a = spectralFeatures(signal(12, 1)), b = spectralFeatures(signal(18, 782));
  assert.equal(matchFeatures(a, b), null);
  assert.equal(matchFeatures(a, spectralFeatures(new Float32Array(18 * ANALYSIS_RATE))), null);
});

test('identical repeated regions remain ambiguous instead of forcing a match', () => {
  const segment = signal(10), doubled = new Float32Array(20 * ANALYSIS_RATE);
  doubled.set(segment); doubled.set(segment, segment.length);
  assert.equal(matchFeatures(spectralFeatures(segment), spectralFeatures(doubled)), null);
});

test('multi-window alignment measures clock drift', () => {
  const source = signal(160), ratio = 1.0005;
  const changed = Float32Array.from({ length: Math.floor(source.length / ratio) }, (_, i) => {
    const position = i * ratio, index = Math.floor(position), fraction = position - index;
    return source[index] * (1 - fraction) + source[index + 1] * fraction;
  });
  const match = matchFeatures(spectralFeatures(source), spectralFeatures(changed));
  assert.ok(match);
  assert.ok(match.driftSeconds > 0.04);
  assert.ok(Math.abs(match.driftPpm) > 300);
});

test('one recorder to three camera files retains actual gaps and original paths in XML', () => {
  const project = createProject();
  project.media = [recording('v1', 20, true), recording('v2', 30, true), recording('v3', 10, true), recording('rec', 300)];
  project.synchronization = solveSession(project, [edge('v1', 'rec', -10), edge('v2', 'rec', -40), edge('v3', 'rec', -100)]);
  assert.deepEqual(project.synchronization.issues, []);
  const { timeline, sources } = compileSyncReview(project);
  assert.deepEqual(timeline.intervals.map(p => [p.start, p.end]), [[300, 900], [1200, 2100], [3000, 3300]]);
  assert.equal(timeline.audioTracks[1][0].end, 9000);
  const xml = premiereXml(timeline, sources);
  assert.match(xml, /<pathurl>[^<]*\/recordings\/rec.wav<\/pathurl>/);
  assert.match(xml, /<start>1200<\/start><end>2100<\/end>/);
  assert.match(xml, /<enabled>FALSE<\/enabled>/);
  assert.equal(validateProject(project).synchronization.accepted, false);
  assert.throws(() => requireSync(project), /Synchronize/);
  project.synchronization.accepted = true;
  assert.ok(requireSync(project));
});

test('one camera across recorder rollovers splits audio and preserves uncovered camera dialogue', () => {
  const project = createProject();
  project.media = [recording('video', 300, true), recording('r1', 60), recording('r2', 50), recording('r3', 100)];
  project.synchronization = solveSession(project, [edge('video', 'r1', 0), edge('video', 'r2', 65), edge('video', 'r3', 150)]);
  project.synchronization.accepted = true;
  const parts = dialogueSegments(project, 'video', 50, 80);
  assert.deepEqual(parts.map(p => [p.mediaId, p.start, p.end, p.offset, p.fallback]), [
    ['r1', 50, 60, 0, false], ['video', 60, 65, 10, true], ['r2', 0, 15, 15, false]
  ]);
  const sources = mediaSources(project), base = compileTimeline([{ sourceId: 'video', inFrame: 1500, outFrame: 2400, linkGroup: 'cut' }], sources, { numerator: 30, denominator: 1 });
  const timeline = attachDialogue(project, base);
  assert.deepEqual(timeline.audioTracks[1].map(p => [p.sourceId, p.start, p.end, p.inFrame]), [
    ['r1', 0, 300, 1500], ['video', 300, 450, 1800], ['r2', 450, 900, 0]
  ]);
  const xml = premiereXml(timeline, sources);
  assert.match(xml, /<linkclipref>audio-2-2<\/linkclipref>/);
  assert.match(xml, /<mediatype>audio<\/mediatype><trackindex>2<\/trackindex><clipindex>3<\/clipindex>/);
});

test('many-to-many graph connects transitively without assuming consecutive files touch', () => {
  const project = createProject();
  project.media = [recording('v1', 100, true), recording('v2', 100, true), recording('r1', 130), recording('r2', 120)];
  const sync = solveSession(project, [edge('v1', 'r1', -5), edge('v2', 'r1', -110), edge('v2', 'r2', 5)]);
  assert.equal(sync.issues.length, 0);
  assert.deepEqual(sync.placements.map(p => p.startSeconds), [5, 0, 110, 115]);
});

test('unknown gaps require a manual component position; script edits reuse synchronization', () => {
  const project = createProject(); project.media = [recording('v', 20, true), recording('r', 30)];
  project.synchronization = solveSession(project, []);
  assert.equal(project.synchronization.issues[0].kind, 'unplaced');
  project.synchronization = adjustSync(project, 'r', 5);
  assert.equal(project.synchronization.issues.length, 0);
  project.script.original = 'An edited script.';
  assert.ok(currentSync(project));
  project.media[0].identity.size++;
  assert.equal(currentSync(project), null);
});

test('silent cameras need full external coverage and manually located groups still obey recording order', () => {
  const project = createProject();
  const video = recording('video', 20, true); video.audio = []; video.selectedAudio = null;
  project.media = [video, recording('r1', 8), recording('r2', 15)];
  project.synchronization = solveSession(project, []);
  project.synchronization = adjustSync(project, 'r1', 0);
  project.synchronization = adjustSync(project, 'r2', 10);
  assert.ok(project.synchronization.issues.some(issue => issue.kind === 'coverage'));
  project.synchronization = adjustSync(project, 'r2', 8);
  assert.deepEqual(project.synchronization.issues, []);
  project.synchronization = adjustSync(project, 'r1', 9);
  assert.ok(project.synchronization.issues.some(issue => issue.kind === 'order'));
});
