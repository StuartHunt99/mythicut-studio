import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildReferenceHandoff, saveEditHandoff } from '../src/edit-handoff.mjs';

const [manifestPath, projectPath] = process.argv.slice(2);
if (!manifestPath || !projectPath) {
  console.error('Usage: npm run m1:reference -- <source-words-and-edit.json> <test-project-path>');
  process.exitCode = 2;
} else {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
  const handoff = buildReferenceHandoff(manifest);
  const output = await saveEditHandoff(resolve(projectPath), handoff);
  console.log(JSON.stringify({ id: handoff.id, path: output, wordCount: handoff.words.length, durationFrames: handoff.timeline.duration }, null, 2));
}
