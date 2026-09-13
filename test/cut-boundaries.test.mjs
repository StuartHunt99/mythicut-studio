import test from 'node:test';
import assert from 'node:assert/strict';
import { paddedWordRange } from '../src/cut-boundaries.mjs';
const common = { first: { startMs: 1000, endMs: 1200 }, last: { startMs: 1800, endMs: 2000 }, sourceDurationMs: 5000, fps: 30 };
test('zero-duration recognizer word cannot reach the cut compiler', () => {
  assert.throws(() => paddedWordRange({ ...common, first: { startMs: 71600, endMs: 71600 }, sourceDurationMs: 100000 }), /alignment required/);
});
test('quiet padding rounds outward while preserving selected words', () => {
  const cut = paddedWordRange(common);
  assert.equal(cut.inFrame, 22);
  assert.equal(cut.outFrame, 68);
  assert.ok(cut.leadingPaddingMs >= 250 && cut.leadingPaddingMs <= 284);
  assert.ok(cut.trailingPaddingMs >= 250 && cut.trailingPaddingMs <= 284);
});
test('shorter clean padding is used and a rounding collision requires review', () => {
  const cut = paddedWordRange({ ...common, previous: { startMs: 500, endMs: 900 }, next: { startMs: 2100, endMs: 2300 } });
  assert.equal(cut.leadingPaddingMs, 100);
  assert.equal(cut.trailingPaddingMs, 100);
  const short = paddedWordRange({ ...common, previous: { startMs: 500, endMs: 990 } });
  assert.equal(short.inFrame, 30); // Drop unavailable padding, not the word.
  assert.throws(() => paddedWordRange({ ...common, first: { startMs: 1005, endMs: 1200 }, previous: { startMs: 500, endMs: 1001 } }), /neighboring speech/);
  assert.throws(() => paddedWordRange({ ...common, first: { ...common.first, needsReview: true } }), /requires review/);
});
