import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { delimiter } from 'node:path';
const require = createRequire(import.meta.url);
const { prepareLocalTools } = require('../src/local-tools.cjs');

test('local tool directories are prepended once without changing a missing-tool setup', () => {
  const original = process.env.PATH;
  try {
    const available = prepareLocalTools();
    const first = process.env.PATH;
    for (const directory of available) assert.ok(first.toLowerCase().split(delimiter).includes(directory.toLowerCase()));
    prepareLocalTools();
    assert.equal(process.env.PATH, first);
  } finally { process.env.PATH = original; }
});
