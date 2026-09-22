import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../src/project.mjs';
import { parseScript } from '../src/script.mjs';
import { applyReviewCommand, resolveReview } from '../src/review.mjs';
import { sentenceEvidence, selectLatestTakes } from '../src/take-selection.mjs';
import { buildEditHandoff, buildReferenceHandoff, handoffPath, readEditHandoff, saveEditHandoff } from '../src/edit-handoff.mjs';
import { compileReview } from '../src/review-timeline.mjs';
import { premiereXml } from '../src/premiere-xml.mjs';

function fixture({ fractional = false } = {}) {
  const project = createProject();
  project.script = parseScript('[B-roll note] Hello there.\n[Do not speak] Goodbye now.');
  project.media = [{ id: 'camera', path: '/recording.mov', filename: 'recording.mov', identity: { size: 100, mtimeMs: 1 }, duration: 10,
    video: { frameRate: '30/1', width: 1920, height: 1080, index: 0 }, audio: [{ index: 1, channels: 2 }], selectedAudio: { streamIndex: 1, channel: 0 } }];
  const words = [
    ['Hello', 1000, 1250], ['there.', 1260, 1500], ['discard', 1510, 1700],
    ['Goodbye', 2000, 2260], ['now.', 2270, 2500]
  ].map(([text, startMs, endMs], i) => ({ id: `w${i}`, mediaId: 'camera', text, startMs, endMs, valid: true }));
  if (fractional) { words[0].startMs = 1001; words[0].endMs = 1234; }
  const result = { projectId: project.id, inputId: 'input', words, takeSelection: selectLatestTakes(sentenceEvidence(project.script.sentences, words)) };
  const view = resolveReview(project.review, result);
  project.review = applyReviewCommand(project.review, result, { type: 'words', action: 'remove', wordIds: ['w2'], analysisId: view.analysisId, revision: view.revision });
  return { project, result };
}

test('locked handoff follows exported joins, excludes discarded words and annotations, and records context', () => {
  const { project, result } = fixture();
  const handoff = buildEditHandoff(project, result);
  assert.equal(handoff.text, 'Hello there. Goodbye now.');
  assert.deepEqual(handoff.words.map(word => word.id), ['w0', 'w1', 'w3', 'w4']);
  assert.equal(handoff.timeline.intervals.length, 2);
  assert.equal(handoff.timeline.intervals[0].end, handoff.timeline.intervals[1].start);
  assert.equal(handoff.words[0].startFrame, handoff.words[0].sourceStartFrame - handoff.timeline.intervals[0].inFrame);
  assert.equal(handoff.words[0].sourceStartFrame, 30);
  assert.equal(handoff.words[0].sourceStartMs, result.words[0].startMs);
  assert.equal(handoff.words[2].startFrame, handoff.timeline.intervals[1].start + handoff.words[2].sourceStartFrame - handoff.timeline.intervals[1].inFrame);
  assert.equal(handoff.sentences[0].nextText, 'Goodbye now.');
  assert.equal(handoff.paragraphs[1].previousText, 'Hello there.');
  assert.equal(handoff.wholeScriptSummary, 'Hello there. Goodbye now.');
  assert.ok(!JSON.stringify(handoff).includes('B-roll note'));
  const compiled = compileReview(project, result);
  const xml = premiereXml(compiled.timeline, compiled.sources);
  for (const interval of handoff.timeline.intervals) {
    assert.match(xml, new RegExp(`<start>${interval.start}</start><end>${interval.end}</end><in>${interval.inFrame}</in><out>${interval.outFrame}</out>`));
  }
});

test('frame rounding clamps word placement to its exported source interval', () => {
  const { project, result } = fixture({ fractional: true });
  const handoff = buildEditHandoff(project, result);
  assert.equal(handoff.words[0].sourceStartFrame, 30);
  assert.equal(handoff.words[0].sourceEndFrame, 38);
  assert.equal(handoff.words[0].endFrame, handoff.timeline.intervals[0].start + 38 - handoff.timeline.intervals[0].inFrame);
});

test('a retained pause stays a sequence gap between spoken words', () => {
  const { project, result } = fixture();
  const view = resolveReview(project.review, result);
  project.review = applyReviewCommand(project.review, result, { type: 'words', action: 'keep', wordIds: ['w2'], analysisId: view.analysisId, revision: view.revision });
  const handoff = buildEditHandoff(project, result);
  assert.equal(handoff.timeline.intervals.length, 1);
  assert.ok(handoff.words[3].startFrame - handoff.words[2].endFrame >= 8);
});

test('a changed phase-1 selection yields a new immutable handoff without rewriting the old one', async () => {
  const { project, result } = fixture();
  const folder = await mkdtemp(join(tmpdir(), 'mythicut-handoff-'));
  const projectPath = join(folder, 'project.json');
  const first = buildEditHandoff(project, result);
  await saveEditHandoff(projectPath, first);
  await saveEditHandoff(projectPath, first);
  const view = resolveReview(project.review, result);
  project.review = applyReviewCommand(project.review, result, { type: 'words', action: 'remove', wordIds: ['w4'], analysisId: view.analysisId, revision: view.revision });
  const second = buildEditHandoff(project, result);
  assert.notEqual(first.id, second.id);
  await saveEditHandoff(projectPath, second);
  assert.equal((await readEditHandoff(projectPath, first.id)).text, 'Hello there. Goodbye now.');
  assert.equal((await readEditHandoff(projectPath, second.id)).text, 'Hello there. Goodbye');
  assert.equal(JSON.parse(await readFile(handoffPath(projectPath, first.id), 'utf8')).id, first.id);
  await assert.rejects(saveEditHandoff(projectPath, { ...first, text: 'tampered' }), /fingerprint/);
});

test('unusable retained word timing cannot be locked', () => {
  const { project, result } = fixture();
  result.words[1].valid = false;
  assert.throws(() => buildEditHandoff(project, result), /Cannot lock unusable transcript word w1/);
});

test('test-only reference importer maps original source timestamps through XML clip placements', () => {
  const input = { width: 1920, height: 1080,
    sources: { camera: { fps: { numerator: 30, denominator: 1 }, frames: 120, filename: 'original.mov' } },
    timeline: { fps: { numerator: 30, denominator: 1 }, duration: 60,
      intervals: [
        { sourceId: 'camera', inFrame: 30, outFrame: 60, start: 0, end: 30, wordIds: ['r1'] },
        { sourceId: 'camera', inFrame: 90, outFrame: 120, start: 30, end: 60, wordIds: ['r2'] }
      ] },
    words: [{ id: 'r1', mediaId: 'camera', text: 'A', startMs: 1100, endMs: 1250 },
      { id: 'r2', mediaId: 'camera', text: 'scene.', startMs: 3100, endMs: 3250 }] };
  const reference = buildReferenceHandoff(input);
  assert.equal(reference.kind, 'reference-fixture');
  assert.equal(reference.forEvaluationOnly, true);
  assert.equal(reference.timingBasis, 'source-transcript-and-compiled-xml-intervals');
  assert.deepEqual(reference.words.map(word => [word.sourceStartMs, word.startFrame, word.endFrame]), [[1100, 3, 8], [3100, 33, 38]]);
  assert.throws(() => buildReferenceHandoff({ ...input, timeline: { ...input.timeline, intervals: [{ ...input.timeline.intervals[0], start: 1 }, input.timeline.intervals[1]] } }), /clip placement/);
  assert.throws(() => buildReferenceHandoff({ ...input, words: [{ ...input.words[0], text: '[silent]' }, input.words[1]] }), /unusable transcript word/);
});
