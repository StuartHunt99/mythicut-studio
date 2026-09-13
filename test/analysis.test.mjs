import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeProject, runTool } from '../src/analysis.mjs';
import { createProject } from '../src/project.mjs';
import { parseScript } from '../src/script.mjs';
import { transcriptWords } from '../src/transcript.mjs';
import { matchSentences } from '../src/matching.mjs';

const transcript = { transcription: [{ tokens: [' Because', ' today', ' because', ' today'].map((text, i) => ({ id: 123, text, offsets: { from: i * 400, to: i * 400 + 200 }, p: .9, t_dtw: -1 })) }] };
test('token reconstruction preserves repeated words and separate source identities', () => {
 const words = transcriptWords(transcript, 'camera1');
 assert.deepEqual(words.map(w => w.text), ['Because', 'today', 'because', 'today']);
 assert.equal(words[0].mediaId, 'camera1');
 const matches = matchSentences(parseScript('Because today.').sentences, words);
 assert.equal(matches[0].candidates.length, 2);
 assert.equal(matches[0].latestCandidateId, 's1-c2');
 assert.equal(matches[0].suggestedCandidateId, null);
 assert.equal(matches[0].needsReview, true);
 const split = words.slice(0, 2).map((w, i) => ({ ...w, mediaId: `camera${i}` }));
 assert.equal(matchSentences(parseScript('Because today.').sentences, split)[0].candidates.length, 0);
});

test('completed transcription is reused, input changes invalidate it, failed work is retried', async () => {
 const root = await mkdtemp(join(tmpdir(), 'mythicut-analysis-'));
 const model = join(root, 'model'); const source = join(root, 'source.mov');
 await writeFile(model, 'fixture'); await writeFile(source, 'fixture'); const identity = await stat(source);
 const p = createProject(); p.script = parseScript('Because today.');
 p.media = [{ id: 'a', filename: 'source.mov', path: source, identity: { size: identity.size, mtimeMs: identity.mtimeMs }, selectedAudio: { streamIndex: 1, channel: 1 } }];
 const calls = [];
 const tool = async (name, args) => {
  calls.push({ name, args });
  if (name === 'whisper-cli') await writeFile(args[args.indexOf('-of') + 1] + '.json', JSON.stringify(transcript));
 };
 const first = await analyzeProject(p, join(root, 'analysis'), { model, tool });
 assert.equal(calls.length, 2);
 assert.ok(calls[0].args.includes('pan=mono|c0=c1'));
 const second = await analyzeProject(p, join(root, 'analysis'), { model, tool });
 assert.equal(first.inputId, second.inputId); assert.equal(calls.length, 2);
 p.script = parseScript('Because today again.');
 await assert.rejects(analyzeProject(p, join(root, 'analysis'), { model, tool: async () => { throw new Error('fixture failure'); } }), /fixture failure/);
 await analyzeProject(p, join(root, 'analysis'), { model, tool });
 assert.equal(calls.length, 4);
});

test('cancellation terminates a live subprocess and rejects the job', async () => {
 const controller = new AbortController();
 const result = runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
 setTimeout(() => controller.abort(), 80);
 await assert.rejects(result, /canceled/);
});
