const { parentPort } = process;
const controller = new AbortController();
let started = false;
parentPort.on('message', async ({ data }) => {
  if (data.type === 'cancel') { controller.abort(); return; }
  if (data.type !== 'start' || started) return;
  started = true;
  try {
    const { analyzeProject } = await import('../src/analysis.mjs');
    const result = await analyzeProject(data.project, data.directory, { model: data.model, signal: controller.signal, progress: value => parentPort.postMessage({ type: 'progress', value }) });
    parentPort.postMessage({ type: 'done', result });
  } catch (error) { parentPort.postMessage({ type: 'failed', message: error.message }); }
});
