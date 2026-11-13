const { parentPort } = process;
const controller = new AbortController();
let started = false;
parentPort.on('message', async ({ data }) => {
  if (data.type === 'cancel') { controller.abort(); return; }
  if (data.type !== 'start' || started) return;
  started = true;
  try {
    const { synchronizeProject } = await import('../src/sync/job.mjs');
    const result = await synchronizeProject(data.project, data.directory, {
      signal: controller.signal, progress: value => parentPort.postMessage({ type: 'progress', value })
    });
    parentPort.postMessage({ type: 'done', result });
  } catch (error) { parentPort.postMessage({ type: 'failed', message: error.message }); }
});
