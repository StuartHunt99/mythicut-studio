const { ipcMain, dialog, utilityProcess } = require('electron');
const { readFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

module.exports = async function registerProjects(window, initialPath) {
  const api = await import('../src/project.mjs');
  const { parseScript } = await import('../src/script.mjs');
  const { sentenceEvidence, selectLatestTakes } = await import('../src/take-selection.mjs');
  const { resolveReview, applyReviewCommand } = await import('../src/review.mjs');
  const { auditionWord, buildReviewPreview, exportReviewXml } = await import('../src/review-media.mjs');
  const { compileReview } = await import('../src/review-timeline.mjs');
  const { timedWords, timingRevision } = await import('../src/word-timing.mjs');
  let project = api.createProject();
  let location = null;
  let sourceWarnings = [];
  if (initialPath) {
    const loaded = await api.openProject(initialPath);
    project = loaded.project; location = path.resolve(initialPath); sourceWarnings = loaded.warnings;
  }
  let controller = null;
  let busy = false;
  let analysisResult = null;
  let audition = null;
  let preview = null;
  let cutIssues = [];
  async function readAnalysis() {
    analysisResult = null;
    if (project.analysis?.resultPath) {
      try {
        const result = JSON.parse(await readFile(project.analysis.resultPath, 'utf8'));
        if (result.projectId === project.id && result.inputId === project.analysis.inputId) {
          // Reuse expensive recognition while applying the current selector.
          result.takeEvidence = sentenceEvidence(project.script.sentences, result.words, project.settings);
          result.takeSelection = selectLatestTakes(result.takeEvidence);
          result.summary.selectedTakes = result.takeSelection.filter(c=>c.selected).length;
          result.summary.needsReview = result.takeSelection.filter(c=>c.flags.length).length;
          analysisResult = result;
        }
      } catch { sourceWarnings.push('Saved analysis result unavailable; resume analysis to rebuild.'); }
    }
  }
  await readAnalysis();
  const page = pathToFileURL(path.join(__dirname, 'project.html')).href;
  const snapshot = (warnings = sourceWarnings) => {
    let reviewView = null; let reviewError = null; let displayWords = null; let currentTimingId = null;
    try { if (analysisResult) reviewView = resolveReview(project.review, analysisResult); } catch (error) { reviewError = error.message; }
    try { if (analysisResult) { displayWords = timedWords(analysisResult); currentTimingId = timingRevision(analysisResult); } } catch (error) { reviewError = error.message; }
    if(analysisResult && reviewView) {
      try { compileReview(project,analysisResult);cutIssues=[]; }
      catch(error) { cutIssues=error.issues??[{message:error.message}]; }
    }
    const previewCurrent = preview && reviewView && preview.projectId === project.id && preview.analysisId === reviewView.analysisId && preview.selectionId === reviewView.selectionId && preview.timingId === currentTimingId && preview.revision === reviewView.revision;
    return { project, location, warnings, analysisResult, displayWords, reviewView, reviewError, audition, preview, previewCurrent: Boolean(previewCurrent), cutIssues };
  };
  const changed = () => { project.revision++; };
  ipcMain.handle('project-command', async (event, action, payload) => {
    const origin = new URL(event.senderFrame?.url ?? 'about:blank'); origin.search = ''; origin.hash = '';
    if (event.sender !== window.webContents || origin.href !== page) throw new Error('Invalid project command origin');
    if (action === 'cancel') { controller?.abort(); return snapshot(); }
    if (action === 'get') return snapshot();
    if (busy) throw new Error('Wait for the current operation to finish');
    busy = true;
    try {
      if (project.phase !== 'import' && ['media', 'script', 'text', 'order', 'channel', 'settings'].includes(action)) throw new Error('Analysis inputs are frozen. Create a new project to change them.');
      switch (action) {
        case 'get': return snapshot();
        case 'new': {
          if (project.media.length || project.script.original) {
            const answer = await dialog.showMessageBox(window, { message: 'Start a new project?', detail: 'Save the current project first if you want to keep it.', buttons: ['Cancel', 'New project'], defaultId: 0, cancelId: 0 });
            if (answer.response !== 1) return snapshot();
          }
          project = api.createProject(); location = null; sourceWarnings = []; analysisResult = null; audition = null; preview = null; cutIssues = []; break;
        }
        case 'media': {
          const selection = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video', extensions: ['mov', 'mp4', 'mxf', 'mkv', 'avi', 'm4v'] }] });
          if (selection.canceled) break;
          controller = new AbortController();
          const assets = await api.probeMedia(selection.filePaths, { signal: controller.signal, progress: value => window.webContents.send('project-progress', value) });
          project.media.push(...assets.filter(a => !project.media.some(m => m.path === a.path)));
          project.media.sort((a, b) => a.filename.localeCompare(b.filename, 'en', { numeric: true })); changed(); break;
        }
        case 'script': {
          const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'UTF-8 script', extensions: ['txt', 'md'] }] });
          if (selection.canceled) break;
          const bytes = await readFile(selection.filePaths[0]);
          project.script = parseScript(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); changed(); break;
        }
        case 'text': project.script = parseScript(String(payload)); changed(); break;
        case 'order': {
          if (!Array.isArray(payload) || payload.length !== project.media.length || new Set(payload).size !== payload.length || payload.some(id => !project.media.some(a => a.id === id))) throw new Error('Invalid media order');
          project.media = payload.map(id => project.media.find(a => a.id === id)); changed(); break;
        }
        case 'channel': {
          const asset = project.media.find(a => a.id === payload?.id);
          if (!asset || !asset.audio.some(a => a.index === payload.streamIndex && Number.isInteger(payload.channel) && payload.channel >= 0 && payload.channel < a.channels)) throw new Error('Invalid channel');
          asset.selectedAudio = { streamIndex: payload.streamIndex, channel: payload.channel }; changed(); break;
        }
        case 'settings': {
          const candidate = api.validateProject({ ...project, name: String(payload.name), settings: { ...project.settings, pauseMs: Number(payload.pauseMs), restartPhrase: String(payload.restartPhrase) } });
          project = candidate; changed(); break;
        }
        case 'analyze': {
          if (!location) throw new Error('Save the project before analysis');
          if (!project.media.length || !project.script.sentences.length) throw new Error('Add recordings and script first');
          const model = path.resolve(__dirname, '../.local/models/ggml-base.en.bin');
          await require('node:fs/promises').access(model);
          project.phase = 'analysis'; project.analysis = { status: 'running' }; changed();
          await api.saveProject(location, project);
          const worker = utilityProcess.fork(path.join(__dirname, 'analysis-worker.cjs'));
          controller = { abort: () => worker.postMessage({ type: 'cancel' }) };
          const onClosed = () => controller?.abort();
          window.once('closed', onClosed);
          try {
            const summary = await new Promise((resolve, reject) => {
              worker.on('message', message => {
                if (message.type === 'progress' && !window.isDestroyed()) window.webContents.send('project-progress', message.value);
                if (message.type === 'done') resolve(message.result);
                if (message.type === 'failed') reject(new Error(message.message));
              });
              worker.once('exit', code => reject(new Error(`Analysis worker stopped (${code}); completed transcripts can be resumed.`)));
              worker.postMessage({ type: 'start', project, directory: `${location}.analysis`, model });
            });
            project.analysis = { status: 'evidence-ready', ...summary };
            await api.saveProject(location, project); await readAnalysis();
          } catch (error) {
            project.analysis = { status: error.message.includes('canceled') ? 'canceled' : 'failed', error: error.message };
            await api.saveProject(location, project); throw error;
          } finally { window.removeListener('closed', onClosed); worker.kill(); }
          break;
        }
        case 'review': {
          if (!analysisResult || !location) throw new Error('Save and analyze the project before reviewing');
          const review = applyReviewCommand(project.review, analysisResult, payload);
          const next = { ...project, review, revision: project.revision + 1 };
          // Commit memory only after the atomic save succeeds.
          await api.saveProject(location, next);
          project = next;
          cutIssues = [];
          break;
        }
        case 'audition': {
          if (!analysisResult || !location) throw new Error('Analyze before source playback');
          controller = new AbortController();
          audition = await auditionWord(project, analysisResult, payload?.wordId, `${location}.cache/audition`, { signal: controller.signal });
          break;
        }
        case 'refine': {
          if(!analysisResult || !location) throw new Error('Analyze before refining word timing');
          const worker=utilityProcess.fork(path.join(__dirname,'analysis-worker.cjs'));
          controller={abort:()=>worker.postMessage({type:'cancel'})};
          const onClosed=()=>controller?.abort();window.once('closed',onClosed);
          try {
            await new Promise((resolve,reject)=>{
              worker.on('message',message=>{
                if(message.type==='progress'&&!window.isDestroyed())window.webContents.send('project-progress',message.value);
                if(message.type==='done')resolve(message.result);
                if(message.type==='failed')reject(new Error(message.message));
              });
              worker.once('exit',code=>reject(new Error(`Timing worker stopped (${code}); completed acoustic evidence can be resumed.`)));
              worker.postMessage({type:'refine',project});
            });
            await readAnalysis();cutIssues=analysisResult?.timingSummary?.issues??[];
          } finally {window.removeListener('closed',onClosed);worker.kill();}
          break;
        }
        case 'preview': {
          if (!analysisResult || !location) throw new Error('Analyze before building playback');
          cutIssues = [];
          try { compileReview(project, analysisResult); } catch (error) { cutIssues = error.issues ?? [{ message: error.message }]; throw error; }
          controller = new AbortController();
          preview = await buildReviewPreview(project, analysisResult, `${location}.cache/previews`, { signal: controller.signal, progress: value => window.webContents.send('project-progress', value) });
          break;
        }
        case 'export': {
          if (!analysisResult || !snapshot().reviewView) throw new Error('Review the suggested selection before exporting');
          compileReview(project,analysisResult);
          const selection = await dialog.showSaveDialog(window, { defaultPath: 'MythiCut-premiere.xml', filters: [{ name: 'Premiere XML', extensions: ['xml'] }] });
          if (selection.canceled) break;
          await exportReviewXml(project,analysisResult,selection.filePath);
          break;
        }
        case 'save': {
          if (!location) {
            const selection = await dialog.showSaveDialog(window, { defaultPath: 'MythiCut-project.json', filters: [{ name: 'MythiCut project', extensions: ['json'] }] });
            if (selection.canceled) break;
            await api.saveProject(selection.filePath, project); location = selection.filePath;
          } else await api.saveProject(location, project);
          break;
        }
        case 'open': {
          const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'MythiCut project or backup', extensions: ['json', 'bak'] }] });
          if (selection.canceled) break;
          const result = await api.openProject(selection.filePaths[0]); project = result.project; location = selection.filePaths[0]; sourceWarnings = result.warnings;
          audition = null; preview = null; cutIssues = [];
          await readAnalysis();
          return snapshot(result.warnings);
        }
        default: throw new Error('Unknown project command');
      }
      return snapshot();
    } finally { busy = false; controller = null; }
  });
};
