import test from 'node:test';
import assert from 'node:assert/strict';
import { patchResolveBridge } from '../src/resolve-bridge-patch.mjs';

const source = `def api_import_media(file_paths):
    return True

def api_create_timeline(name, clips=None):
    return True

def api_append_to_timeline(clipNames, clipInfo=None):
    return True

def api_create_timeline_from_clips(name, clipNames):
    return True

ACTIONS = {
    "import_media": api_import_media,
    "append_to_timeline": api_append_to_timeline,
}
`;

test('Resolve bridge patch adds waveform sync and JSON-safe source ranges once', () => {
  const first = patchResolveBridge(source);
  assert.equal(first.changed, true);
  assert.match(first.source, /media_pool\.AutoSyncAudio\(\[video, audio\], settings\)/);
  assert.match(first.source, /"audioSyncMethod": methods\[method_key\]/);
  assert.match(first.source, /"auto_sync_audio": api_auto_sync_audio/);
  assert.match(first.source, /"append_clip_ranges": api_append_clip_ranges/);
  const second = patchResolveBridge(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

test('Resolve bridge patch rejects an unknown bridge layout', () => {
  assert.throws(() => patchResolveBridge('print("different bridge")'), /marker is missing/);
});
