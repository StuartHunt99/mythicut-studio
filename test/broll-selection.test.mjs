import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBrollSelection, saveBrollSelection, selectBrollImages, summarizeBrollCoverage } from '../src/broll-selection.mjs';
import { hashDistance } from '../src/image-tagging/near-duplicate.mjs';

function beat(id, startFrame, endFrame, ids, extra = {}) {
  return { id, startFrame, endFrame, text: `Narration ${id}`, searchStatus: ids.length ? 'candidates' : 'no_candidates',
    artworkNeed: 'optional', opening: false, closing: false, establishing: false,
    search: { response: { results: ids.map(imageId => ({ imageId })),
      selectionPacket: { candidates: ids.map((imageId, index) => ({ imageId, filename: `${imageId}.png`, retrievalRank: index + 1 })) } } }, ...extra };
}

function plan(beats) {
  return { id: 'beat-plan-1', handoffId: 'handoff-1', catalogId: 'catalog-1', wholeScriptSummary: 'A magical journey.',
    timeline: { fps: { numerator: 30, denominator: 1 }, duration: beats.at(-1).endFrame }, beats };
}

test('coverage warnings follow the minimum captured in the beat plan', () => {
  const beats = [beat('a', 0, 120, ['one'])];
  const choices = new Map([['a', { selectedImageId: 'one' }]]);
  assert.ok(summarizeBrollCoverage(beats, choices, 30, 5).warnings.some(item => item.code === 'artwork_group_under_minimum'));
  assert.ok(!summarizeBrollCoverage(beats, choices, 30, 4).warnings.some(item => item.code === 'artwork_group_under_minimum'));
});

test('image selection separates initial choices and sparse conflict updates without searching again', async () => {
  const beats = [beat('a', 0, 180, ['shared', 'other']), beat('b', 180, 360, ['shared', 'fallback']), beat('c', 360, 540, [])];
  let selections = 0, allocations = 0;
  const provider = { async generateStructuredText(request) {
    if (request.outputSchema.properties.selectedImageId) {
      selections++;
      return { values: { selectedImageId: 'shared', reason: 'A literal visual fit.' }, providerRequestId: `selection-${selections}` };
    }
    allocations++;
    assert.ok(request.userText.includes('fallback'));
    return { values: { updates: [{ beatId: 'a', selectedImageId: 'other', reason: 'Reserve the stronger shared image for the later beat.' }], reuseExceptions: [] } };
  } };
  const selected = await selectBrollImages({ beatPlan: plan(beats), provider, model: 'test-model' });
  assert.equal(selections, 2);
  assert.equal(allocations, 1);
  assert.deepEqual(selected.initialDecisions.map(item => item.selectedImageId), ['shared', 'shared', null]);
  assert.deepEqual(selected.finalDecisions.map(item => item.selectedImageId), ['other', 'shared', null]);
  assert.deepEqual(selected.allocationUpdates.map(item => item.beatId), ['a']);
  assert.equal(selected.coverage.brollPercent, 100 * 360 / 540);
  assert.equal(selected.coverage.longestUncoveredSeconds, 6);
  assert.equal(selected.promptSnapshot.selectionRequests.length, 2);
  const directory = await mkdtemp(join(tmpdir(), 'mythicut-broll-selection-'));
  await saveBrollSelection(join(directory, 'project.json'), selected);
  assert.deepEqual((await readBrollSelection(join(directory, 'project.json'), selected.id)).finalDecisions, selected.finalDecisions);
});

test('invented image IDs and ungrounded allocation updates are rejected', async () => {
  const beats = [beat('a', 0, 180, ['one'])];
  await assert.rejects(selectBrollImages({ beatPlan: plan(beats), model: 'test-model',
    provider: { async generateStructuredText() { return { values: { selectedImageId: 'invented', reason: 'No.' } }; } } }), /invented/);
  const duplicates = [beat('a', 0, 180, ['one']), beat('b', 180, 360, ['one'])];
  let calls = 0;
  await assert.rejects(selectBrollImages({ beatPlan: plan(duplicates), model: 'test-model',
    provider: { async generateStructuredText() {
      calls++;
      return calls <= 2 ? { values: { selectedImageId: 'one', reason: 'The image fits.' } } :
        { values: { updates: [{ beatId: 'missing', selectedImageId: '', reason: 'No image.' }], reuseExceptions: [] } };
    } } }), /invented or repeated a beat/);
});

test('unresolved duplicates become null while intro reuse remains allowed', async () => {
  const plain = [beat('a', 0, 180, ['one']), beat('b', 180, 360, ['one'])];
  const provider = { async generateStructuredText(request) {
    return request.outputSchema.properties.selectedImageId ? { values: { selectedImageId: 'one', reason: 'Relevant.' } } :
      { values: { updates: [], reuseExceptions: [] } };
  } };
  const selected = await selectBrollImages({ beatPlan: plan(plain), provider, model: 'test-model' });
  assert.deepEqual(selected.finalDecisions.map(item => item.selectedImageId), ['one', null]);
  assert.equal(selected.allocationUpdates[0].source, 'duplicate_safety');
  const intro = [beat('a', 0, 180, ['one'], { opening: true }), beat('b', 180, 360, ['one'])];
  const allowed = await selectBrollImages({ beatPlan: plan(intro), provider, model: 'test-model' });
  assert.deepEqual(allowed.finalDecisions.map(item => item.selectedImageId), ['one', 'one']);
});

test('uncovered and required-artwork coverage warnings stay separate', async () => {
  const beats = [beat('a', 0, 600, [], { artworkNeed: 'required', opening: true }), beat('b', 600, 1200, [])];
  const selected = await selectBrollImages({ beatPlan: plan(beats), model: 'test-model',
    provider: { async generateStructuredText() { throw new Error('No hosted call expected'); } } });
  assert.equal(selected.coverage.brollPercent, 0);
  assert.equal(selected.coverage.longestUncoveredSeconds, 40);
  assert.ok(selected.coverage.warnings.some(item => item.code === 'required_artwork_missing'));
  assert.ok(selected.coverage.warnings.some(item => item.code === 'below_50_percent_broll'));
  assert.ok(selected.coverage.warnings.some(item => item.code === 'uncovered_gap_over_15_seconds'));
});

test('candidate-only perceptual hashes warn about near duplicates without forcing a poor replacement', async () => {
  assert.equal(hashDistance('0000000000000000', '0000000000000001'), 1);
  const beats = [beat('a', 0, 180, ['one']), beat('b', 180, 360, ['two'])];
  let choices = 0, reviews = 0, hashes = 0;
  const selected = await selectBrollImages({ beatPlan: plan(beats), model: 'test-model',
    nearDuplicateHash: async imageId => { hashes++; return imageId === 'one' ? '1111111111111111' : '1111111111111110'; },
    provider: { async generateStructuredText(request) {
      if (request.outputSchema.properties.selectedImageId) {
        choices++; return { values: { selectedImageId: choices === 1 ? 'one' : 'two', reason: 'Good fit.' } };
      }
      reviews++;
      assert.ok(request.userText.includes('nearDuplicateWarnings'));
      return { values: { updates: [], reuseExceptions: [] } };
    } } });
  assert.equal(hashes, 2);
  assert.equal(reviews, 1);
  assert.deepEqual(selected.finalDecisions.map(item => item.selectedImageId), ['one', 'two']);
  assert.ok(selected.coverage.warnings.some(item => item.code === 'possible_near_duplicate' && item.hashDistance === 1));
});

test('non-intro image reuse needs both four-minute separation and an explicit allocation reason', async () => {
  const beats = [beat('a', 0, 180, ['one']), beat('b', 180, 9000, []), beat('c', 9000, 9180, ['one'])];
  const provider = { async generateStructuredText(request) {
    return request.outputSchema.properties.selectedImageId ? { values: { selectedImageId: 'one', reason: 'Distinct relevant passages.' } } :
      { values: { updates: [], reuseExceptions: [{ firstBeatId: 'a', secondBeatId: 'c', reason: 'The image is narratively essential in both passages.' }] } };
  } };
  const selected = await selectBrollImages({ beatPlan: plan(beats), provider, model: 'test-model' });
  assert.deepEqual(selected.finalDecisions.map(item => item.selectedImageId), ['one', null, 'one']);
  const close = [beat('a', 0, 180, ['one']), beat('b', 180, 360, ['one'])];
  const denied = await selectBrollImages({ beatPlan: plan(close), provider, model: 'test-model' });
  assert.deepEqual(denied.finalDecisions.map(item => item.selectedImageId), ['one', null]);
});
