import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

const [audio, model, output, durationMs = '0', dtwModel = ''] = process.argv.slice(2);
if (!audio || !model || !output || !/^\d+$/.test(durationMs)) {
  throw new Error('Usage: node scripts/transcribe.mjs AUDIO MODEL OUTPUT_PREFIX [DURATION_MS] [DTW_MODEL]');
}
await mkdir(dirname(resolve(output)), { recursive: true });
// Keep the human-readable SRT/ TXT outputs, but ask whisper.cpp to split
// decoded segments at word boundaries as well. The full JSON remains the
// source of truth for the word export produced after transcription.
const args = ['-m', resolve(model), '-f', resolve(audio), '-l', 'en', '-t', '4', '-ng', '-ojf', '-otxt', '-osrt', '-sow', '-owts', '-pp', '-d', durationMs, '-of', resolve(output)];
if (dtwModel) args.push('-nfa', '-dtw', dtwModel);
const stdout = createWriteStream(`${output}.stdout.log`);
const stderr = createWriteStream(`${output}.stderr.log`);
const startedAt = new Date().toISOString();
const start = performance.now();
const child = spawn('whisper-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);
process.once('SIGINT', () => child.kill('SIGINT'));
const result = await new Promise(resolve => {
  child.once('error', error => resolve({ exitCode: null, error: error.message }));
  child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
});
const metrics = { schemaVersion: 1, startedAt, elapsedSeconds: (performance.now() - start) / 1000, command: 'whisper-cli', args, ...result };
await writeFile(`${output}.metrics.json`, JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics, null, 2));
process.exitCode = result.exitCode === 0 ? 0 : 1;
