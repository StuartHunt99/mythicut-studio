import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const rootArgument = process.argv.slice(2).find(value => !value.startsWith('--'));
const root = resolve(rootArgument ?? 'artifacts/resolve-sync');
const ffmpeg = resolve(process.env.MYTHICUT_FFMPEG ?? '.local/tools/ffmpeg/bin/ffmpeg.exe');
const force = process.argv.includes('--force');

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function run(output, args) {
  if (!force && await exists(output)) return;
  await mkdir(dirname(output), { recursive: true });
  await execute(ffmpeg, ['-v', 'error', '-nostdin', '-y', ...args, output], { maxBuffer: 8 * 1024 * 1024 });
}

const shortReference = resolve(root, 'short-reference.wav');
const shortCamera = resolve(root, 'short-clap-camera.mov');
const shortRecorder = resolve(root, 'short-clap-recorder.wav');
const longReference = resolve(root, 'long-reference.wav');
const longCamera = resolve(root, 'long-drift-camera.mov');
const longRecorder = resolve(root, 'long-drift-recorder.wav');

await run(shortReference, [
  '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.08:duration=8:sample_rate=48000:seed=1701',
  '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.9:duration=0.08:sample_rate=48000:seed=1702',
  '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9[a]',
  '-map', '[a]', '-c:a', 'pcm_s16le'
]);
await run(shortCamera, [
  '-f', 'lavfi', '-i', 'color=c=0x204060:size=640x360:rate=30:duration=12', '-i', shortReference,
  '-filter_complex', '[1:a]adelay=2000:all=1,apad,atrim=0:12[a]', '-map', '0:v', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest'
]);
await run(shortRecorder, [
  '-i', shortReference, '-filter_complex', '[0:a]adelay=500:all=1,apad,atrim=0:10[a]', '-map', '[a]', '-c:a', 'pcm_s16le'
]);

await run(longReference, ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.25:duration=600:sample_rate=48000:seed=2602', '-c:a', 'pcm_s16le']);
await run(longCamera, [
  '-f', 'lavfi', '-i', 'color=c=0x503020:size=640x360:rate=30:duration=605', '-i', longReference,
  '-filter_complex', '[1:a]adelay=2000:all=1,apad,atrim=0:605[a]', '-map', '0:v', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest'
]);
await run(longRecorder, [
  '-i', longReference, '-filter_complex', '[0:a]asetrate=48010,aresample=48000,adelay=500:all=1,apad,atrim=0:605[a]',
  '-map', '[a]', '-c:a', 'pcm_s16le'
]);

const manifest = {
  schemaVersion: 1,
  fps: 30,
  short: {
    camera: shortCamera,
    recorder: shortRecorder,
    expectedRecorderStartFrame: 45,
    expectedOffsetSeconds: 1.5,
    description: 'Identical deterministic clap-like transient and waveform start at camera 2.0s and recorder 0.5s.'
  },
  long: {
    camera: longCamera,
    recorder: longRecorder,
    expectedRecorderStartFrame: 45,
    expectedOffsetSeconds: 1.5,
    simulatedRecorderRate: 48010,
    nominalRate: 48000,
    expectedDriftAt600Seconds: Number((600 * (48010 / 48000 - 1)).toFixed(6)),
    description: 'Ten-minute recording with approximately 208 ppm simulated recorder clock error.'
  }
};
await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Resolve synchronization fixtures ready: ${root}`);
console.log(JSON.stringify(manifest, null, 2));
