import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript } from '../src/script.mjs';

test('BOM, CRLF, multiline notes and original offsets survive import', () => {
  const text = '\uFEFF[Heading\r\nmore]\r\nHello world.\r\nAgain!';
  const parsed = parseScript(text);
  assert.equal(parsed.annotations.length, 1);
  assert.deepEqual(parsed.sentences.map(s => s.text), ['Hello world.', 'Again!']);
  for (const sentence of parsed.sentences) assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
  assert.notEqual(parsed.sentences[0].paragraphId, parsed.sentences[1].paragraphId);
});

test('malformed annotations cannot silently erase the script', () => {
  for (const text of ['Hello [note\nGoodbye.', 'Hello ] Goodbye.', '[outer [inner]]']) assert.throws(() => parseScript(text));
});

test('inline notes are masked and repeated sentences retain distinct IDs', () => {
  const result = parseScript('Hello [pause] world. Hello world.');
  assert.deepEqual(result.sentences.map(s => s.text), ['Hello world.', 'Hello world.']);
  assert.notEqual(result.sentences[0].id, result.sentences[1].id);
});

test('initials and titles stay attached to the complete spoken sentence', () => {
 const original = 'C.S. Lewis wrote it. We thanked Mr. and Mrs. Pevensie. It is done.';
 const result = parseScript(original);
 assert.deepEqual(result.sentences.map(s => s.text), ['C.S. Lewis wrote it.', 'We thanked Mr. and Mrs. Pevensie.', 'It is done.']);
 for (const s of result.sentences) assert.equal(original.slice(s.start, s.end), s.text);
});
