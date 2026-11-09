import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { patchResolveBridge } from '../src/resolve-bridge-patch.mjs';

const argument = process.argv.slice(2).find(value => !value.startsWith('--'));
if (!argument) throw new Error('Usage: node scripts/patch-resolve-bridge.mjs <Bridge-Connection-Script.py>');

const path = resolve(argument);
const original = await readFile(path, 'utf8');
const patched = patchResolveBridge(original);
if (!patched.changed) {
  console.log(`Resolve bridge already contains MythiCut sync actions: ${path}`);
  process.exit(0);
}

const temporary = `${path}.${randomUUID()}.tmp`;
await writeFile(temporary, patched.source, { flag: 'wx' });
await rename(temporary, path);
console.log(`Added auto_sync_audio and append_clip_ranges to: ${path}`);
