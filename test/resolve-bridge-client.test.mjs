import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolveBridgeClient, requireBridgeSuccess } from '../src/resolve-bridge-client.mjs';

test('Resolve bridge client sends action parameters to the local bridge', async () => {
  let request;
  const client = new ResolveBridgeClient({ fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return { status: 'ok', synced: true }; } };
  } });
  const result = await client.call('auto_sync_audio', { videoClipName: 'camera.mov', audioClipName: 'sound.wav' });
  assert.equal(result.synced, true);
  assert.equal(request.url, 'http://127.0.0.1:8787/action');
  assert.deepEqual(JSON.parse(request.options.body), {
    action: 'auto_sync_audio', params: { videoClipName: 'camera.mov', audioClipName: 'sound.wav' }
  });
});

test('Resolve bridge client rejects HTTP and action failures', async () => {
  const client = new ResolveBridgeClient({ fetchImpl: async () => ({ ok: false, status: 500, async json() { return { error: 'boom' }; } }) });
  await assert.rejects(client.call('status'), /boom/);
  assert.throws(() => requireBridgeSuccess('sync', { status: 'error', message: 'no match' }), /no match/);
});
