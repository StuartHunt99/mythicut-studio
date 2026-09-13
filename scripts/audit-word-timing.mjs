import { readFile } from 'node:fs/promises';
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/audit-word-timing.mjs WORD_JSON');
const data = JSON.parse(await readFile(path, 'utf8'));
const words = data.words;
if (!Array.isArray(words) || !words.length) throw new Error('No word intervals');
const invalid = words.filter(w => !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs) || w.startMs < 0 || w.endMs <= w.startMs);
console.log(JSON.stringify({ file: path, wordCount: words.length, invalidCount: invalid.length, firstInvalid: invalid[0], note: 'Structural validity does not establish acoustic boundary accuracy.' }, null, 2));
process.exitCode = invalid.length ? 1 : 0;
