const { ipcMain, dialog, utilityProcess } = require('electron');
const { readFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

module.exports = async function registerProjects(window, initialPath) {
  const api = await import('../src/project.mjs');
  const { parseScript } = await import('../src/script.mjs');
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
  async function readAnalysis() {
    analysisResult = null;
    if (project.analysis?.resultPath) {
      try {
        const result = JSON.parse(await readFile(project.analysis.resultPath, 'utf8'));
        if (result.projectId === project.id && result.inputId === project.analysis.inputId) analysisResult = result;
      } catch { sourceWarnings.push('Saved analysis result unavailable; resume analysis to rebuild.'); }
    }
  }
  await readAnalysis();
  const page = pathToFileURL(path.join(__dirname, 'project.html')).href;
  const snapshot = (warnings = sourceWarnings) => ({ project, location, warnings, analysisResult });
  const changed = () => { project.revision++; };
  ipcMain.handle('project-command', async (event, action, payload) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== page) throw new Error('Invalid project command origin');
    if (action === 'cancel') { controller?.abort(); return snapshot(); }
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
          project = api.createProject(); location = null; sourceWarnings = []; analysisResult = null; break;
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
        case 'decision': {
          if (!analysisResult || !['approve', 'reject', 'clear'].includes(payload?.action) || typeof payload?.sentenceId !== 'string') throw new Error('Invalid review decision');
          const choice = analysisResult.takeSelection.find(item => item.sentence.id === payload.sentenceId);
          if (!choice) throw new Error('Unknown sentence');
          if (payload.action !== 'clear' && !choice.candidates?.length && !choice.selected) throw new Error('No candidate evidence for sentence');
          if (payload.action === 'approve') {
            const candidate = [...(choice.candidates ?? []), ...(choice.selected ? [choice.selected] : [])].find(item => item.id === payload.candidateId);
            if (!candidate) throw new Error('Unknown candidate');
            project.review.decisions[payload.sentenceId] = { action: 'approve', candidateId: payload.candidateId, revision: project.revision + 1 };
          } else if (payload.action === 'reject') project.review.decisions[payload.sentenceId] = { action: 'reject', candidateId: null, revision: project.revision + 1 };
          else delete project.review.decisions[payload.sentenceId];
          changed();
          if (location) await api.saveProject(location, project);
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
          await readAnalysis();
          return snapshot(result.warnings);
        }
        default: throw new Error('Unknown project command');
      }
      return snapshot();
    } finally { busy = false; controller = null; }
  });
};
