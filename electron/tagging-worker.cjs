const { parentPort } = process;

let catalog = null;

async function open(payload) {
  if (catalog) {
    const state = await catalog.execute('catalog.snapshot');
    if (state.runs.some(run => ['queued', 'running', 'paused'].includes(run.status))) throw new Error('Cancel the active tag run before opening another catalog');
    catalog.close();
  }
  const { openImageCatalog } = await import('../src/image-tagging/catalog.mjs');
  catalog = await openImageCatalog(payload);
  catalog.onEvent(event => parentPort.postMessage({ type: 'event', event }));
  return catalog.execute('catalog.snapshot');
}

parentPort.on('message', async ({ data: message }) => {
  try {
    let result;
    if (message.command === 'catalog.open') result = await open(message.payload);
    else if (message.command === 'catalog.backup') result = await catalog.backupTo(message.payload.databasePath);
    else result = await catalog.execute(message.command, message.payload);
    parentPort.postMessage({ type: 'response', requestId: message.requestId, result });
  } catch (error) {
    parentPort.postMessage({ type: 'response', requestId: message.requestId, error: String(error?.message ?? error) });
  }
});

parentPort.once('close', () => catalog?.close());
