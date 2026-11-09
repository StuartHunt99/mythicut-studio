import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { ResolveBridgeClient, requireBridgeSuccess } from '../src/resolve-bridge-client.mjs';

const root = resolve(process.argv[2] ?? 'artifacts/resolve-sync');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const client = new ResolveBridgeClient();
const projectName = `MythiCut Resolve Sync Spike ${new Date().toISOString().replace(/[:.]/g, '-')}`;
const events = [];

async function call(action, params = {}) {
  const result = await client.call(action, params);
  events.push({ action, params, result });
  return requireBridgeSuccess(action, result);
}

await client.health();
const available = await client.actions();
for (const required of ['create_project', 'import_media', 'auto_sync_audio', 'create_timeline', 'append_clip_ranges', 'save_project']) {
  if (!available.actions?.includes(required)) throw new Error(`Resolve bridge is missing required action: ${required}`);
}

await call('create_project', { name: projectName, width: 1920, height: 1080, fps: manifest.fps });
await call('import_media', { file_paths: [manifest.short.camera, manifest.short.recorder, manifest.long.camera, manifest.long.recorder] });
await call('auto_sync_audio', {
  videoClipName: basename(manifest.short.camera), audioClipName: basename(manifest.short.recorder),
  method: 'waveform', channelNumber: -1, retainEmbeddedAudio: false, retainVideoMetadata: true
});
await call('auto_sync_audio', {
  videoClipName: basename(manifest.long.camera), audioClipName: basename(manifest.long.recorder),
  method: 'waveform', channelNumber: -1, retainEmbeddedAudio: false, retainVideoMetadata: true
});

await call('create_timeline', { name: 'Short Sync Edited' });
await call('append_clip_ranges', {
  clipName: basename(manifest.short.camera),
  ranges: [{ startFrame: 60, endFrame: 150 }, { startFrame: 210, endFrame: 330 }]
});
const shortTracks = {
  video: await call('get_items_in_track', { trackType: 'video', index: 1 }),
  audio: await call('get_items_in_track', { trackType: 'audio', index: 1 })
};

await call('create_timeline', { name: 'Long Drift Check' });
await call('append_clip_ranges', {
  clipName: basename(manifest.long.camera),
  ranges: [{ startFrame: 60, endFrame: 210 }, { startFrame: 17_700, endFrame: 17_850 }]
});
const longTracks = {
  video: await call('get_items_in_track', { trackType: 'video', index: 1 }),
  audio: await call('get_items_in_track', { trackType: 'audio', index: 1 })
};
await call('save_project');

const result = {
  schemaVersion: 1,
  status: 'provisional-awaiting-human-review',
  createdAt: new Date().toISOString(),
  projectName,
  manifest,
  shortTracks,
  longTracks,
  events
};
await writeFile(resolve(root, 'resolve-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
