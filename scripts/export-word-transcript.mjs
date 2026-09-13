import { transcriptWords } from '../src/transcript.mjs';
import { readFile, writeFile } from 'node:fs/promises';

const [input, requestedOutput] = process.argv.slice(2);
if (!input) throw new Error('Usage: node scripts/export-word-transcript.mjs TRANSCRIPT_JSON [OUTPUT]');
const output = requestedOutput ?? input.replace(/\.json$/i, '.words.json');

const source = JSON.parse(await readFile(input, 'utf8'));
const words = transcriptWords(source);
const result = {
  schemaVersion: 1,
  sourceTranscript: input,
  timing: 'whisper.cpp token offsets; word boundaries reconstructed from token-leading whitespace',
  summary: { wordCount: words.length, invalidIntervalCount: words.filter(word => !word.valid).length },
  words
};
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output, wordCount: words.length }, null, 2));
