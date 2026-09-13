const { parentPort } = process;
const controller = new AbortController();
let started = false;
parentPort.on('message', async ({ data }) => {
  if (data.type === 'cancel') { controller.abort(); return; }
  if (!['start','refine'].includes(data.type) || started) return;
  started = true;
  try {
    if(data.type === 'refine') {
      const {readFile} = require('node:fs/promises');
      const {refineProjectTiming,saveTimingResult} = await import('../src/timing-job.mjs');
      const {sentenceEvidence,selectLatestTakes} = await import('../src/take-selection.mjs');
      const evidence=JSON.parse(await readFile(data.project.analysis.resultPath,'utf8'));
      evidence.takeSelection=selectLatestTakes(sentenceEvidence(data.project.script.sentences,evidence.words,data.project.settings));
      const refined=await refineProjectTiming(data.project,evidence,{signal:controller.signal,progress:value=>parentPort.postMessage({type:'progress',value})});
      await saveTimingResult(data.project.analysis.resultPath,refined);
      parentPort.postMessage({type:'done',result:refined.timingSummary});return;
    }
    const { analyzeProject } = await import('../src/analysis.mjs');
    const result = await analyzeProject(data.project, data.directory, { model: data.model, signal: controller.signal, progress: value => parentPort.postMessage({ type: 'progress', value }) });
    parentPort.postMessage({ type: 'done', result });
  } catch (error) { parentPort.postMessage({ type: 'failed', message: error.message }); }
});
