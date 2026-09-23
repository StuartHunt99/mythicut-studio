const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
require('../src/local-tools.cjs').prepareLocalTools();
const smoke = process.argv.includes('--smoke');
const sample = process.argv.includes('--sample');
const projectMode = process.argv.includes('--project');
const taggingMode = process.argv.includes('--tagging');
const studioMode = projectMode || taggingMode || (!smoke && !sample);
app.setPath('userData', path.resolve(__dirname, smoke ? `../artifacts/electron-smoke-data-${process.pid}` : '../artifacts/electron-data'));
app.whenReady().then(async () => {
  const preload = studioMode ? 'studio-preload.cjs' : null;
  const window = new BrowserWindow({ width: 1440, height: 900, minWidth: 1000, minHeight: 650, show: !smoke, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...(smoke ? { backgroundThrottling: false } : {}), ...(preload ? { preload: path.join(__dirname, preload) } : {}) } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (studioMode) {
    await require('./project-ipc.cjs')(window, process.argv.includes('--project-file') ? process.argv[process.argv.indexOf('--project-file') + 1] : null);
    await require('./tagging-ipc.cjs')(window, process.argv.includes('--tagging-file') ? process.argv[process.argv.indexOf('--tagging-file') + 1] : null);
  }
  const studioPages = { edit: 'project.html', tag: 'tagging.html', broll: 'project.html' };
  let activeTab = taggingMode ? 'tag' : 'edit';
  if (studioMode) {
    ipcMain.handle('studio-select-tab', async (event, tab) => {
      const source = new URL(event.senderFrame?.url ?? 'about:blank'); source.search = ''; source.hash = '';
      const allowed = ['project.html', 'tagging.html'].some(file => source.href === pathToFileURL(path.join(__dirname, file)).href);
      if (event.sender !== window.webContents || !allowed || !Object.hasOwn(studioPages, tab)) throw new Error('Invalid workspace navigation');
      if (tab !== activeTab) { activeTab = tab; await window.loadFile(path.join(__dirname, studioPages[tab]), { query: { workspace: tab } }); }
      return tab;
    });
    window.once('closed', () => ipcMain.removeHandler('studio-select-tab'));
  }
  await window.loadFile(path.join(__dirname, studioMode ? studioPages[activeTab] : sample ? 'sample.html' : 'preview.html'), studioMode ? { query: { workspace: activeTab } } : undefined);
  if (process.argv.includes('--workspace-smoke')) {
    try {
      window.setMinimumSize(800, 600);
      window.setSize(820, 700);
      const inspect = () => window.webContents.executeJavaScript(`({ tab:document.querySelector('.workspace-tabs .active')?.dataset.studioTab, noPageScroll:document.documentElement.scrollHeight <= innerHeight + 1, noHorizontalOverflow:document.querySelector('.workspace-tabs .active')?.dataset.studioTab !== 'broll' || (document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('#broll-workspace .stage-toolbar button')].every(button => button.getBoundingClientRect().right <= innerWidth + 1)), config:Boolean(document.querySelector('#configuration-dialog, #tag-configuration-dialog')), content:Boolean(document.querySelector('#edit-workspace, #broll-workspace, .table-wrap')) })`);
      const visit = async tab => {
        const loaded = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Timed out switching to ${tab}`)), 10000);
          window.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
        });
        window.webContents.executeJavaScript(`document.querySelector('[data-studio-tab="${tab}"]').click()`).catch(() => {});
        await loaded;
        return inspect();
      };
      const edit = await inspect();
      const editConfiguration = await window.webContents.executeJavaScript(`(() => { document.getElementById('open-configuration').click(); document.querySelector('[data-config-panel="motion"]').click(); const ready = document.getElementById('configuration-dialog').open && !document.querySelector('[data-config-content="motion"]').hidden && Boolean(document.getElementById('fastZoomRate')); document.getElementById('close-configuration').click(); return ready; })()`);
      const editScreenshot = path.join(app.getPath('temp'), `mythicut-edit-workspace-${process.pid}.png`);
      await fs.writeFile(editScreenshot, (await window.webContents.capturePage()).toPNG());
      const tag = await visit('tag');
      const tagConfiguration = await window.webContents.executeJavaScript(`(() => { document.getElementById('toggle-config').click(); return document.getElementById('tag-configuration-dialog').open && document.getElementById('provider-form').closest('dialog')?.id === 'tag-configuration-dialog'; })()`);
      const broll = await visit('broll');
      const brollReviewLayout = await window.webContents.executeJavaScript(`(() => {
        const review = document.getElementById('broll-review'), list = document.getElementById('broll-beat-list');
        document.getElementById('broll-empty').classList.add('hidden'); review.classList.remove('hidden');
        const card = document.createElement('article'); card.className = 'broll-card';
        const layout = document.createElement('div'); layout.className = 'broll-layout';
        const preview = document.createElement('div'); preview.className = 'broll-fill';
        const controls = document.createElement('div'); controls.className = 'broll-controls';
        const select = document.createElement('select'); select.innerHTML = '<option>Zoom out</option>';
        const save = document.createElement('button'); save.textContent = 'Save this beat as an override';
        controls.append(select, save); layout.append(preview, controls); card.append(layout); list.append(card);
        const buttons = [...document.querySelectorAll('#broll-review-header button'), save];
        return { buttonsFit: buttons.every(button => button.getBoundingClientRect().right <= innerWidth - 2), noCardOverflow: list.scrollWidth <= list.clientWidth + 1 };
      })()`);
      const brollSearchLayout = await window.webContents.executeJavaScript(`(() => {
        const dialog = document.getElementById('broll-search-dialog');
        const results = document.getElementById('broll-search-results');
        const form = document.getElementById('broll-search-form');
        const filters = document.getElementById('broll-search-filters');
        for (let index = 0; index < 5; index++) {
          const fieldset = document.createElement('fieldset'); fieldset.className = 'broll-search-filter';
          for (let choice = 0; choice < 10; choice++) {
            const label = document.createElement('label'); label.textContent = 'Tag choice'; fieldset.append(label);
          }
          filters.append(fieldset);
        }
        for (let index = 0; index < 12; index++) {
          const card = document.createElement('article'); card.className = 'broll-search-result';
          card.textContent = 'Artwork result ' + index; results.append(card);
        }
        dialog.showModal();
        const closed = { footerHeight: document.querySelector('.statusbar').getBoundingClientRect().height,
          formHeight: form.getBoundingClientRect().height, resultsHeight: results.getBoundingClientRect().height,
          noPageScroll: document.documentElement.scrollHeight <= innerHeight + 1,
          resultsScrollable: results.scrollHeight > results.clientHeight,
          limitAvailable: document.getElementById('broll-search-limit').max === '50' };
        document.getElementById('broll-search-filter-panel').open = true;
        const expanded = { resultsHeight: results.getBoundingClientRect().height,
          filtersScrollable: filters.scrollHeight > filters.clientHeight,
          noPageScroll: document.documentElement.scrollHeight <= innerHeight + 1 };
        dialog.close(); return { closed, expanded };
      })()`);
      const screenshot = path.join(app.getPath('temp'), `mythicut-broll-workspace-${process.pid}.png`);
      await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
      const result = { edit, editConfiguration, tag, tagConfiguration, broll, brollReviewLayout, brollSearchLayout, editScreenshot, screenshot };
      await fs.writeFile(path.join(app.getPath('temp'), `mythicut-workspace-smoke-${process.pid}.json`), JSON.stringify(result, null, 2));
      if (edit.tab !== 'edit' || tag.tab !== 'tag' || broll.tab !== 'broll' || !broll.noHorizontalOverflow || !brollReviewLayout.buttonsFit || !brollReviewLayout.noCardOverflow ||
          brollSearchLayout.closed.footerHeight > 40 || brollSearchLayout.closed.resultsHeight < 300 ||
          brollSearchLayout.expanded.resultsHeight < 180 || !brollSearchLayout.closed.noPageScroll ||
          !brollSearchLayout.expanded.noPageScroll || !brollSearchLayout.closed.limitAvailable ||
          !editConfiguration || !tagConfiguration || [edit, tag, broll].some(view => !view.noPageScroll || !view.config || !view.content)) throw new Error(JSON.stringify(result));
      console.log(JSON.stringify(result)); app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
    return;
  }
  if (process.argv.includes('--review-smoke')) {
    try {
      const nativeClick = await require('./project-native-click-smoke.cjs')(window);
      const result = await require('./project-review-smoke.cjs')(window);
      await fs.mkdir(path.resolve(__dirname, '../artifacts/review'), { recursive: true });
      await fs.writeFile(path.resolve(__dirname, '../artifacts/review/smoke.json'), JSON.stringify({ ...result, nativeClick }, null, 2));
      await fs.writeFile(path.resolve(__dirname, '../artifacts/review/screen.png'), (await window.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ...result, nativeClick })); app.exit(0);
    } catch(error) { console.error(error); app.exit(1); }
    return;
  }
  if (smoke && taggingMode) {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const state = await window.imageTagging.command('get');
        const started = Date.now();
        while ((!document.querySelector('#provider-form [name="name"]')?.value || document.getElementById('status')?.textContent !== 'Catalog ready.') && Date.now() - started < 5000) await new Promise(resolve => setTimeout(resolve, 25));
        const toggle = document.getElementById('toggle-config');
        const initiallyClosed = document.body.classList.contains('config-collapsed');
        toggle.click(); const configRestored = !document.body.classList.contains('config-collapsed') && toggle.getAttribute('aria-label') === 'Close configuration' && document.getElementById('tag-configuration-dialog').open;
        document.querySelector('[data-tag-config="schema"]').click();
        document.getElementById('edit-schema').click();
        await new Promise(resolve => setTimeout(resolve, 40));
        const schemaEditorContract = !document.querySelector('#schema-dialog [name="key"]') && document.querySelector('#schema-dialog').textContent.includes('Category and Tags') && document.querySelectorAll('#schema-dialog .option-chip').length > 0;
        document.getElementById('close-schema').click();
        toggle.click(); const configCollapsed = initiallyClosed && document.body.classList.contains('config-collapsed') && toggle.getAttribute('aria-label') === 'Open configuration';
        const overlayHost = document.createElement('div');
        Object.assign(overlayHost.style, { position: 'fixed', left: '0', top: '0', width: '300px', height: '300px', opacity: '0', pointerEvents: 'none' });
        const overlay = renderDetectionOverlay({ width: 600, height: 776, detection: { faces: [{ label: 'face', x: 0.2, y: 0.1, width: 0.5, height: 0.4 }], objects: [] } });
        overlayHost.append(overlay); document.body.append(overlayHost);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const detectionBox = overlay.querySelector('.detection-box');
        const detectionBounds = detectionBox.getBoundingClientRect();
        const detectionOverlayContract = overlay.getAttribute('viewBox') === '0 0 600 776' && detectionBox.getAttribute('stroke-width') === '2.5' && detectionBounds.width > 50 && detectionBounds.height > 30;
        overlayHost.remove();
        const previousBoxVisibility = showDetectionBoxes;
        showDetectionBoxes = true;
        openImagePreview({ filename: 'fixture.png', path: 'C:/missing/fixture.png', width: 600, height: 776, availability: 'present', detection: { faces: [{ label: 'face', x: 0.2, y: 0.1, width: 0.5, height: 0.4 }], objects: [] } });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const previewDialog = document.getElementById('image-preview-dialog');
        const imagePreviewContract = previewDialog.open && document.querySelector('#image-preview-frame > img')?.alt === 'fixture.png' && Boolean(document.querySelector('#image-preview-frame > .detection-overlay')) && document.getElementById('preview-toggle-boxes')?.textContent === 'Hide boxes';
        previewDialog.close(); showDetectionBoxes = previousBoxVisibility;
        return {
          title: document.title,
          bridgeExposed: typeof window.imageTagging.command === 'function',
          nodeHidden: typeof require === 'undefined',
          schemaCount: state.schemas.length,
          providerCount: state.providers.length,
          providerHasSecretValue: Object.hasOwn(state.providers[0], 'credentialRef'),
          providerRendered: document.querySelector('#provider-form [name="name"]')?.value === 'OpenAI',
          statusRendered: document.getElementById('status')?.textContent === 'Catalog ready.',
          configCollapsed,
          configRestored,
          schemaEditorContract,
          detectionOverlayContract,
          imagePreviewContract,
          portableControls: document.getElementById('open-catalog')?.getAttribute('aria-label') === 'Open catalog' && Boolean(document.getElementById('save-catalog-as')) && Boolean(document.getElementById('action-selector')) && Boolean(document.getElementById('search-demo')) && Boolean(document.getElementById('search-dialog')) && document.querySelector('.statusbar')?.contains(document.getElementById('status'))
        };
      })()`);
      if (!result.bridgeExposed || !result.nodeHidden || result.schemaCount !== 1 || result.providerCount !== 1 || result.providerHasSecretValue || !result.providerRendered || !result.statusRendered || !result.configCollapsed || !result.configRestored || !result.schemaEditorContract || !result.detectionOverlayContract || !result.imagePreviewContract || !result.portableControls) throw new Error(JSON.stringify(result));
      const outputDir = path.resolve(__dirname, '../artifacts/image-tagging');
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, 'electron-smoke.json'), JSON.stringify(result, null, 2));
      await fs.writeFile(path.join(outputDir, 'screen.png'), (await window.webContents.capturePage()).toPNG());
      console.log(JSON.stringify(result)); app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
    return;
  }
  if (!smoke) return;
  if (projectMode) {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const initial = await window.projects.command('get');
        if (initial.project.phase === 'analysis') {
          let inputFrozen = false;
          try { await window.projects.command('text', 'Should not replace frozen input'); } catch { inputFrozen = true; }
          const resumed = await window.projects.command('analyze');
          return { title: document.title, mode: 'analysis', inputFrozen, evidenceReady: resumed.project.analysis.status === 'evidence-ready', sentenceCount: resumed.analysisResult?.summary.sentenceCount, nodeHidden: typeof require === 'undefined' };
        }
        const edited = await window.projects.command('text', 'Hello. [Not spoken] Goodbye.');
        let malformedRejected = false;
        try { await window.projects.command('text', '[broken'); } catch { malformedRejected = true; }
        const retained = await window.projects.command('get');
        return { title: document.title, sentenceCount: edited.project.script.sentences.length, malformedRejected, retained: retained.project.script.original === edited.project.script.original, bridgeExposed: typeof window.projects.command === 'function', nodeHidden: typeof require === 'undefined' };
      })()`);
      if (!result.nodeHidden || (result.mode === 'analysis' ? !result.inputFrozen || !result.evidenceReady || result.sentenceCount < 1 : result.sentenceCount !== 2 || !result.malformedRejected || !result.retained)) throw new Error(JSON.stringify(result));
      await fs.mkdir(path.resolve(__dirname, '../artifacts/m1'), { recursive: true });
      await fs.writeFile(path.resolve(__dirname, '../artifacts/m1/electron-smoke.json'), JSON.stringify(result, null, 2));
      if (result.mode === 'analysis') await window.webContents.executeJavaScript("document.getElementById('analysis-summary').scrollIntoView(); document.querySelectorAll('#analysis-results details')[1].open = true");
      await fs.writeFile(path.resolve(__dirname, '../artifacts/m1/project-screen.png'), (await window.webContents.capturePage()).toPNG());
      console.log(JSON.stringify(result)); app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
    return;
  }

  try {
    const manifest = sample ? JSON.parse(await fs.readFile(path.resolve(__dirname, '../artifacts/sample/edit/edit.json'), 'utf8')) : null;
    const seekTimes = sample ? [0.5, ...manifest.joins.flatMap(join => [join.sequenceSeconds - 0.25, join.sequenceSeconds + 0.25])] : [0.5, 2.5];
    const result = await window.webContents.executeJavaScript(`(async () => {
      const video = document.querySelector('video');
      const ready = event => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout: ' + event)), 10000);
        video.addEventListener(event, () => { clearTimeout(timeout); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Media error ' + video.error?.code)); }, { once: true });
      });
      if (video.error) throw new Error('Media failed to load');
      if (video.readyState < 2) await ready('loadeddata');
      const samples = [];
      for (const time of ${JSON.stringify(seekTimes)}) {
        const seek = ready('seeked'); video.currentTime = time; await seek;
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
        samples.push([...context.getImageData(0, 0, 1, 1).data]);
      }
      video.muted = true; await video.play();
      await new Promise(resolve => setTimeout(resolve, 150));
      const advanced = video.currentTime > ${seekTimes.at(-1)}; video.pause();
      let textSeekVerified = null;
      const firstWord = document.querySelector('.word');
      if (firstWord) {
        const seek = ready('seeked'); firstWord.click(); await seek;
        const expected = window.sampleEdit.sections[0].words[0].startMs / 1000 - window.sampleEdit.timeline.intervals[0].inFrame * 1001 / 24000 - 0.1;
        textSeekVerified = Math.abs(video.currentTime - Math.max(0, expected)) < 0.02;
      }
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, samples, playbackAdvanced: advanced, textSeekVerified };
    })()`);
    if (Math.abs(result.duration - (manifest?.expectedDuration ?? 3.5)) > 0.04 || !result.playbackAdvanced || (sample && !result.textSeekVerified) || (!sample && (result.samples[0][2] < 200 || result.samples[1][1] < 90))) throw new Error('Unexpected playback result: ' + JSON.stringify(result));
    const outputDir = path.resolve(__dirname, sample ? '../artifacts/sample/edit' : '../artifacts/m0');
    await fs.writeFile(path.join(outputDir, 'electron-smoke.json'), JSON.stringify({ ...result, electron: process.versions.electron, verified: true }, null, 2));
    if (sample) await fs.writeFile(path.join(outputDir, 'review-window.png'), (await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
