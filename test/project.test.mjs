import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, saveProject, openProject, validateProject } from '../src/project.mjs';
import { parseScript } from '../src/script.mjs';

test('saved inputs survive reopen; failed saves preserve current and previous snapshots', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mythicut-project-'));
  const path = join(folder, 'project.json'); const p = createProject();
  p.script = parseScript('Hello. [Direction]\nGoodbye.');
  await saveProject(path, p);
  p.name = 'Changed'; p.revision++;
  await saveProject(path, p);
  assert.equal((await openProject(path)).project.name, 'Changed');
  assert.equal((await openProject(`${path}.bak`)).project.name, 'Untitled project');
  await assert.rejects(saveProject(path, { ...p, script: { original: '[unfinished' } }), /Unclosed/);
  assert.equal((await openProject(path)).project.name, 'Changed');
  // A temporary file from a terminated write does not affect reopening.
  await writeFile(`${path}.interrupted.tmp`, '{');
  assert.equal((await openProject(path)).project.script.sentences.length, 2);
});

test('missing media is reported without discarding inputs; bad channel references are rejected', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mythicut-source-'));
  const p = createProject();
  p.media.push({ id: 'a', path: join(folder, 'missing.mov'), filename: 'missing.mov', identity: { size: 123, mtimeMs: 100 }, duration: 1, video: { width: 1920, height: 1080 }, audio: [{ index: 1, channels: 2 }], selectedAudio: { streamIndex: 1, channel: 1 } });
  await saveProject(join(folder, 'project.json'), p);
  const result = await openProject(join(folder, 'project.json'));
  assert.equal(result.project.media[0].selectedAudio.channel, 1);
  assert.match(result.warnings[0], /unavailable/);
  p.media[0].selectedAudio.channel = 2;
  assert.throws(() => validateProject(p), /channel/);
});

test('new projects include an empty persistent review decision set', () => {
  const project = createProject();
  assert.deepEqual(project.review, { decisions: {} });
  assert.deepEqual(validateProject(project).review, { decisions: {}, wordOverrides: {}, revision: 0, history: { entries: [], cursor: 0 } });
});
