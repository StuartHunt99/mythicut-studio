const { ipcMain, dialog, utilityProcess, safeStorage, app } = require('electron');
const { access, readFile, stat } = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');
const path = require('node:path');

module.exports = async function registerProjects(window, initialPath) {
  const api = await import('../src/project.mjs');
  const { parseScript } = await import('../src/script.mjs');
  const { sentenceEvidence, selectLatestTakes } = await import('../src/take-selection.mjs');
  const { resolveReview, applyReviewCommand } = await import('../src/review.mjs');
  const { auditionWord, buildReviewPreview, exportReviewXml, exportBrollXml } = await import('../src/review-media.mjs');
  const { compileReview } = await import('../src/review-timeline.mjs');
  const { buildEditHandoff, saveEditHandoff, readEditHandoff } = await import('../src/edit-handoff.mjs');
  const { readBrollBeatPlan } = await import('../src/broll-beats.mjs');
  const { readBrollSelection } = await import('../src/broll-selection.mjs');
  const { readBrollMotion, recalculateBrollMotion, saveBrollMotion } = await import('../src/broll-motion.mjs');
  const { appendBrollOverride, previewBrollOverride, rebaseBrollOverrides } = await import('../src/broll-overrides.mjs');
  const { buildBrollReviewData } = await import('../src/broll-review.mjs');
  const { compileBrollTimeline } = await import('../src/broll-timeline.mjs');
  const { brollPreviewLayout } = await import('../src/broll-preview-layout.mjs');
  const { DEFAULT_PROMPTS } = await import('../src/prompt-templates.mjs');
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
  let lockedHandoff = null;
  let brollBeatPlan = null;
  let brollSelection = null;
  let brollMotion = null;
  async function readHandoff() {
    lockedHandoff = null;
    if (!location || !project.lockedHandoffId) return;
    try { lockedHandoff = await readEditHandoff(location, project.lockedHandoffId); }
    catch { sourceWarnings.push('Locked edit handoff unavailable or changed; restore its adjacent .handoffs folder.'); }
  }
  async function readPlan() {
    brollBeatPlan = null;
    if (!location || !project.brollBeatPlanId) return;
    try { brollBeatPlan = await readBrollBeatPlan(location, project.brollBeatPlanId); }
    catch { sourceWarnings.push('B-roll beat plan unavailable or changed; restore its adjacent .broll-plans folder.'); }
  }
  async function readSelection() {
    brollSelection = null;
    if (!location || !project.brollSelectionId) return;
    try { brollSelection = await readBrollSelection(location, project.brollSelectionId); }
    catch { sourceWarnings.push('B-roll image selection unavailable or changed; restore its adjacent .broll-selections folder.'); }
  }
  async function readMotion() {
    brollMotion = null;
    if (!location || !project.brollMotionId) return;
    try { brollMotion = await readBrollMotion(location, project.brollMotionId); }
    catch { sourceWarnings.push('B-roll motion plan unavailable or changed; restore its adjacent .broll-motions folder.'); }
  }
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
  await readHandoff();
  await readPlan();
  await readSelection();
  await readMotion();
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
    const handoffCurrent = Boolean(lockedHandoff && reviewView && analysisResult && (() => {
      try { return buildEditHandoff(project, analysisResult).id === lockedHandoff.id; } catch { return false; }
    })());
    return { project, location, warnings, analysisResult, displayWords, reviewView, reviewError, audition, preview, previewCurrent: Boolean(previewCurrent), cutIssues,
      brollPromptDefaults: Object.fromEntries(['beatPlanning', 'imageSelection', 'allocation', 'motion'].map(task => [task, DEFAULT_PROMPTS[task]])),
      lockedHandoff: lockedHandoff ? { id: lockedHandoff.id, wordCount: lockedHandoff.words.length, durationFrames: lockedHandoff.timeline.duration } : null, handoffCurrent,
      brollBeatPlan: brollBeatPlan ? { id: brollBeatPlan.id, handoffId: brollBeatPlan.handoffId, catalogId: brollBeatPlan.catalogId,
        status: brollBeatPlan.status, beatCount: brollBeatPlan.beats.length } : null,
      brollPlanCurrent: Boolean(brollBeatPlan && lockedHandoff && brollBeatPlan.handoffId === lockedHandoff.id && handoffCurrent),
      brollSelection: brollSelection ? { id: brollSelection.id, beatPlanId: brollSelection.beatPlanId,
        selectedCount: brollSelection.finalDecisions.filter(item => item.selectedImageId).length,
        brollPercent: brollSelection.coverage.brollPercent, warningCount: brollSelection.coverage.warnings.length } : null,
      brollSelectionCurrent: Boolean(brollSelection && brollBeatPlan && brollSelection.beatPlanId === brollBeatPlan.id && handoffCurrent),
      brollMotion: brollMotion ? { id: brollMotion.id, selectionId: brollMotion.selectionId,
        motionCount: brollMotion.motions.length, warningCount: brollMotion.motions.reduce((n, item) => n + item.geometry.warnings.length, 0) } : null,
      brollMotionCurrent: Boolean(brollMotion && brollSelection && brollBeatPlan && brollMotion.selectionId === brollSelection.id &&
        brollSelection.beatPlanId === brollBeatPlan.id && handoffCurrent) };
  };
  async function brollReviewData() {
    if (!snapshot().brollMotionCurrent) throw new Error('Finish the current beat, image, and motion plans before reviewing B-roll');
    const imageIds = [...new Set(brollBeatPlan.beats.flatMap(beat => (beat.search?.response?.results ?? []).map(item => item.imageId)))];
    let catalogImages = [], catalogWarning = null;
    try {
      const preference = JSON.parse(await readFile(path.join(app.getPath('userData'), 'image-tagging.json'), 'utf8'));
      if (typeof preference.catalogPath !== 'string') throw new Error('No remembered image catalog');
      const { openImageCatalog } = await import('../src/image-tagging/catalog.mjs');
      const catalog = await openImageCatalog({ databasePath: path.resolve(preference.catalogPath),
        modelCachePath: path.join(app.getPath('userData'), 'embedding-models') });
      try {
        const state = await catalog.execute('catalog.snapshot', { limit: 1 });
        if (state.catalog.id !== brollBeatPlan.catalogId) throw new Error('The active image catalog differs from this B-roll plan');
        for (let index = 0; index < imageIds.length; index += 1000) {
          catalogImages.push(...await catalog.execute('images.resolve', { imageIds: imageIds.slice(index, index + 1000) }));
        }
        // Catalog availability is a scan-time observation; artwork may have moved since then.
        for (let index = 0; index < catalogImages.length; index += 64) {
          const checked = await Promise.all(catalogImages.slice(index, index + 64).map(async image => {
            if (!image.path || image.availability !== 'present') return image;
            try { if ((await stat(image.path)).isFile()) return image; }
            catch { return { ...image, availability: 'missing' }; }
            return { ...image, availability: 'missing' };
          }));
          catalogImages.splice(index, checked.length, ...checked);
        }
      } finally { catalog.close(); }
    } catch (error) { catalogWarning = String(error?.message ?? error); }
    const review = buildBrollReviewData({ beatPlan: brollBeatPlan, selection: brollSelection, motion: brollMotion,
      overrides: project.brollOverrides, catalogImages, catalogWarning });
    try {
      if (catalogWarning) throw new Error(catalogWarning);
      const broll = compileBrollTimeline({ compiled: compileReview(project, analysisResult),
        beatPlan: brollBeatPlan, selection: brollSelection, motion: brollMotion,
        overrides: project.brollOverrides, review });
      review.exportPreview = { projectRevision: project.revision, trackCount: broll.tracks.length,
        clipCount: broll.tracks.reduce((count, track) => count + track.length, 0),
        tracks: broll.tracks.map(track => track.map(clip => ({ beatId: clip.beatId,
          start: clip.start, end: clip.end, filename: clip.filename, layer: clip.layer }))) };
    } catch (error) { review.exportWarning = error.message; }
    return review;
  }
  async function requireAvailableBrollCandidate(reviewData, beatId, imageId) {
    if (imageId === null) return;
    const beat = reviewData.beats.find(item => item.id === beatId);
    const candidate = beat?.candidates.find(item => item.imageId === imageId);
    if (!candidate?.usable || !candidate.previewUrl) throw new Error('This candidate is no longer an available accepted image');
    try { if ((await stat(fileURLToPath(candidate.previewUrl))).isFile()) return; }
    catch { throw new Error(`Artwork file is missing: ${candidate.filename}. Rescan or relocate its catalog root.`); }
    throw new Error(`Artwork file is missing: ${candidate.filename}. Rescan or relocate its catalog root.`);
  }
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
        case 'brollReview': return brollReviewData();
        case 'brollPreview': {
          const reviewData = await brollReviewData();
          await requireAvailableBrollCandidate(reviewData, payload?.beatId, payload?.imageId);
          const preview = previewBrollOverride({ beatPlan: brollBeatPlan, selection: brollSelection,
            motion: brollMotion, beatId: payload.beatId, imageId: payload.imageId,
            kind: payload.kind, speed: payload.speed, anchorId: payload.anchorId });
          return { geometry: preview.geometry ? { ...preview.geometry, previewLayout: brollPreviewLayout(preview.geometry) } : null,
            intent: preview.intent };
        }
        case 'brollOverride': {
          if (payload?.projectRevision !== project.revision || payload?.beatPlanId !== brollBeatPlan?.id ||
              payload?.selectionId !== brollSelection?.id || payload?.motionId !== brollMotion?.id) throw new Error('B-roll review changed; reload before editing');
          const reviewData = await brollReviewData();
          await requireAvailableBrollCandidate(reviewData, payload?.beatId, payload?.imageId);
          const overrides = appendBrollOverride({ beatPlan: brollBeatPlan, selection: brollSelection,
            motion: brollMotion, overrides: project.brollOverrides, beatId: payload.beatId,
            imageId: payload.imageId, kind: payload.kind, speed: payload.speed, anchorId: payload.anchorId });
          const next = { ...project, brollOverrides: overrides, revision: project.revision + 1 };
          await api.saveProject(location, next);
          project = next;
          return { projectRevision: project.revision, review: await brollReviewData() };
        }
        case 'brollExport': {
          const review = await brollReviewData();
          if (review.exportWarning) throw new Error(review.exportWarning);
          const destination = await dialog.showSaveDialog(window, { defaultPath: 'MythiCut-broll-premiere.xml',
            filters: [{ name: 'Premiere XML', extensions: ['xml'] }] });
          if (destination.canceled) return { canceled: true };
          const result = await exportBrollXml(project, analysisResult, destination.filePath, {
            beatPlan: brollBeatPlan, selection: brollSelection, motion: brollMotion,
            overrides: project.brollOverrides, review, lockedHandoff });
          return { ...result, path: destination.filePath };
        }
        case 'new': {
          if (project.media.length || project.script.original) {
            const answer = await dialog.showMessageBox(window, { message: 'Start a new project?', detail: 'Save the current project first if you want to keep it.', buttons: ['Cancel', 'New project'], defaultId: 0, cancelId: 0 });
            if (answer.response !== 1) return snapshot();
          }
          project = api.createProject(); location = null; sourceWarnings = []; analysisResult = null; audition = null; preview = null; cutIssues = []; lockedHandoff = null; brollBeatPlan = null; brollSelection = null; brollMotion = null; break;
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
        case 'brollPromptTemplates': {
          if (!location) throw new Error('Save the project before editing B-roll prompts');
          const candidate = api.validateProject({ ...project, brollPromptTemplates: payload });
          const next = { ...candidate, revision: project.revision + 1 };
          await api.saveProject(location, next);
          project = next;
          break;
        }
        case 'brollMotionConfig': {
          if (!location) throw new Error('Save the project before editing motion rates');
          const candidate = api.validateProject({ ...project, brollMotionConfig: payload });
          const next = { ...candidate, revision: project.revision + 1 };
          await api.saveProject(location, next);
          project = next;
          break;
        }
        case 'recalculateBrollMotion': {
          if (!location || !snapshot().brollMotionCurrent) throw new Error('A current B-roll motion plan is required');
          const settings = api.validateProject({ ...project, brollMotionConfig: payload }).brollMotionConfig;
          const updatedMotion = recalculateBrollMotion({ beatPlan: brollBeatPlan,
            selection: brollSelection, motion: brollMotion, config: settings });
          const updatedOverrides = rebaseBrollOverrides({ beatPlan: brollBeatPlan,
            selection: brollSelection, motion: brollMotion, updatedMotion,
            overrides: project.brollOverrides });
          const next = api.validateProject({ ...project, brollMotionConfig: settings,
            brollMotionId: updatedMotion.id, brollOverrides: updatedOverrides,
            revision: project.revision + 1 });
          if (updatedMotion.id !== brollMotion.id) await saveBrollMotion(location, updatedMotion);
          await api.saveProject(location, next);
          project = next; brollMotion = updatedMotion;
          break;
        }
        case 'lockHandoff': {
          if (!analysisResult || !location) throw new Error('Save and analyze the project before locking its edit');
          const handoff = buildEditHandoff(project, analysisResult);
          await saveEditHandoff(location, handoff);
          const next = { ...project, lockedHandoffId: handoff.id, revision: project.revision + 1 };
          await api.saveProject(location, next);
          project = next; lockedHandoff = handoff;
          break;
        }
        case 'planBrollBeats':
        case 'selectBrollImages':
        case 'planBrollMotion': {
          const stage = action === 'planBrollBeats' ? 'beats' : action === 'selectBrollImages' ? 'selection' : 'motion';
          if (!location || !lockedHandoff || !snapshot().handoffCurrent) throw new Error('Lock the current reviewed edit before planning B-roll');
          if (stage !== 'beats' && (!brollBeatPlan || brollBeatPlan.handoffId !== lockedHandoff.id)) throw new Error('Plan B-roll beats for this locked edit first');
          if (stage === 'motion' && (!brollSelection || brollSelection.beatPlanId !== brollBeatPlan.id)) throw new Error('Select images for this beat plan before planning motion');
          const userData = app.getPath('userData');
          let catalogPath;
          try { catalogPath = path.resolve(JSON.parse(await readFile(path.join(userData, 'image-tagging.json'), 'utf8')).catalogPath); }
          catch { throw new Error('Open the image catalog first so this project can find the accepted artwork'); }
          await access(catalogPath);
          const { openImageCatalog } = await import('../src/image-tagging/catalog.mjs');
          const catalog = await openImageCatalog({ databasePath: catalogPath, modelCachePath: path.join(userData, 'embedding-models') });
          let profile;
          try {
            const state = await catalog.execute('catalog.snapshot', { limit: 1 });
            profile = state.providers.find(item => item.id === state.catalog.activeProviderProfileId);
          } finally { catalog.close(); }
          if (!profile?.hasCredential) throw new Error('Configure an active image-catalog provider and API key before B-roll planning');
          if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer');
          const encrypted = await readFile(path.join(userData, 'image-tagging-credentials', `${profile.id}.bin`));
          const credential = (await safeStorage.decryptStringAsync(encrypted)).result;
          const worker = utilityProcess.fork(path.join(__dirname, 'broll-worker.cjs'));
          controller = { abort: () => worker.postMessage({ type: 'cancel' }) };
          const onClosed = () => controller?.abort(); window.once('closed', onClosed);
          try {
            const result = await new Promise((resolve, reject) => {
              worker.on('message', message => {
                if (message.type === 'done' || message.type === 'not_ready') resolve(message);
                if (message.type === 'failed') reject(new Error(`${message.message}${message.logPath ? ` See provider log: ${message.logPath}` : ''}`));
              });
              worker.once('exit', code => reject(new Error(`B-roll planning worker stopped (${code})`)));
              worker.postMessage({ type: 'start', catalogPath, modelCachePath: path.join(userData, 'embedding-models'),
                credential, profile, handoff: lockedHandoff, projectPath: location, stage, beatPlanId: brollBeatPlan?.id,
                selectionId: brollSelection?.id, motionConfig: project.brollMotionConfig,
                promptOverride: project.brollPromptTemplates });
            });
            if (result.type === 'not_ready') throw new Error(`${result.result.message} ${result.result.action === 'embeddings.update' ? 'Run Update Embeddings in the image catalog.' : ''}`.trim());
            const pointer = stage === 'beats' ? 'brollBeatPlanId' : stage === 'selection' ? 'brollSelectionId' : 'brollMotionId';
            const next = { ...project, [pointer]: result.result.id, revision: project.revision + 1 };
            await api.saveProject(location, next);
            project = next;
            if (stage === 'beats') await readPlan(); else if (stage === 'selection') await readSelection(); else await readMotion();
          } finally { window.removeListener('closed', onClosed); worker.kill(); }
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
          await readHandoff();
          await readPlan();
          await readSelection();
          await readMotion();
          return snapshot(result.warnings);
        }
        default: throw new Error('Unknown project command');
      }
      return snapshot();
    } finally { busy = false; controller = null; }
  });
};
