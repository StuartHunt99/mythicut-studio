const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const smoke = process.argv.includes('--smoke');
const sample = process.argv.includes('--sample');
const projectMode = process.argv.includes('--project');
app.setPath('userData', path.resolve(__dirname, smoke ? `../artifacts/electron-smoke-data-${process.pid}` : '../artifacts/electron-data'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1100, height: 800, show: !smoke, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...(smoke ? { backgroundThrottling: false } : {}), ...(projectMode ? { preload: path.join(__dirname, 'project-preload.cjs') } : {}) } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (projectMode) await require('./project-ipc.cjs')(window, process.argv.includes('--project-file') ? process.argv[process.argv.indexOf('--project-file') + 1] : null);
  await window.loadFile(path.join(__dirname, projectMode ? 'project.html' : sample ? 'sample.html' : 'preview.html'));
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
