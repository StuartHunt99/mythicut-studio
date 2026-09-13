import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecommendation } from '../src/recommendation.mjs';
const packet = { caseId: 's2', allowedCandidateIds: ['s2-c1', 's2-c2'] };
const valid = { caseId: 's2', candidateId: 's2-c2', unresolved: false, reason: 'Latest complete corresponding sentence.' };
test('accept a referenced recommendation or an explicit unresolved case', () => {
  assert.deepEqual(validateRecommendation(valid, packet), valid);
  assert.equal(validateRecommendation({ ...valid, candidateId: null, unresolved: true }, packet).unresolved, true);
});
test('reject model-generated IDs, timestamps, stale cases and false resolution', () => {
  for (const value of [{ ...valid, candidateId: 'invented' }, { ...valid, startMs: 100 }, { ...valid, caseId: 'old' }, { ...valid, candidateId: null }, { ...valid, reason: 'x'.repeat(241) }]) assert.throws(() => validateRecommendation(value, packet));
});
