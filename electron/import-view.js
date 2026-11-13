// Import stays separate from the word editor so the normal path is simply
// files + script -> Synchronize -> Continue. Review is optional.
let importProjectId = null;
let syncPlayback = null;
const importElement = id => document.getElementById(id);

function importDraft() {
  return { name: importElement('name').value, scriptText: importElement('script-text').value };
}

function showImport(value, command) {
  const project = value.project, sync = project.synchronization;
  for (const [id, text] of [['name', project.name], ['script-text', project.script.original]]) {
    const field = importElement(id);
    if (importProjectId !== project.id || field.dataset.saved !== text) field.value = text;
    field.dataset.saved = text;
  }
  importProjectId = project.id;
  const videos = project.media.filter(asset => asset.video), audio = project.media.filter(asset => !asset.video);
  const ready = Boolean(sync && !sync.issues.length);
  const frozen = project.phase !== 'import';
  importElement('sync-summary').textContent = sync ? ready ?
    `${videos.length} video files and ${audio.length} audio files synchronized.` : 'Synchronization needs attention. Open Review sync for details.' :
    audio.length ? 'Ready to synchronize.' : videos.length ? 'Camera audio will be used. Import external audio if needed.' : 'Import your camera and audio recordings.';
  importElement('sync-issues').textContent = [...new Set(sync?.issues.map(issue => issue.message) ?? [])].join(' ');
  importElement('synchronize').disabled = frozen || !videos.length || !audio.length;
  importElement('sync-review').disabled = !sync;
  const updateContinue = () => {
    importElement('continue-edit').disabled = frozen || !videos.length || !importElement('script-text').value.trim() || (audio.length > 0 && !ready);
  };
  updateContinue();
  importElement('script-text').oninput = updateContinue;
  importElement('sync-export').disabled = !ready;
  importElement('edit-source-summary').textContent = `${project.name} · ${videos.length} videos · ${audio.length} external audio files`;
  importElement('sync-review').onclick = () => importElement('sync-dialog').showModal();
  importElement('sync-close').onclick = () => { importElement('sync-dialog').close(); stopSyncPlayback(); };
  importElement('sync-dialog').onclose = stopSyncPlayback;
  importElement('synchronize').onclick = () => command('synchronize');
  importElement('sync-cancel').onclick = () => window.projects.command('cancel');
  importElement('continue-edit').onclick = async () => {
    const result = await command('continue');
    if (result?.analysisResult) window.studio.selectTab('edit');
  };
  importElement('sync-export').onclick = () => command('syncExport');
  importElement('sync-details').textContent = sync ? JSON.stringify(sync.matches.map(match => ({
    video: project.media.find(asset => asset.id === match.a)?.filename,
    audio: project.media.find(asset => asset.id === match.b)?.filename,
    offsetSeconds: match.offset, correlation: match.confidence, anchors: match.anchors.length, driftPpm: match.driftPpm
  })), null, 2) : '';
  renderSyncRecordings(project, command);
}

function renderSyncRecordings(project, command) {
  const list = importElement('sync-recordings'), timeline = importElement('sync-timeline');
  list.replaceChildren(); timeline.replaceChildren();
  const sync = project.synchronization;
  if (!sync) return;
  const length = Math.max(...sync.placements.map(p => p.startSeconds + project.media.find(asset => asset.id === p.mediaId).duration));
  for (const asset of project.media) {
    const placement = sync.placements.find(p => p.mediaId === asset.id);
    const issue = sync.issues.find(item => item.mediaId === asset.id);
    const lane = document.createElement('div'); lane.className = 'sync-lane';
    const bar = document.createElement('span'); bar.className = asset.video ? 'sync-video-bar' : 'sync-audio-bar';
    bar.style.marginLeft = `${100 * placement.startSeconds / length}%`;
    bar.style.width = `${100 * asset.duration / length}%`; bar.textContent = asset.filename; lane.append(bar); timeline.append(lane);
    const row = document.createElement('div'); row.className = 'sync-recording';
    const label = document.createElement('label'); label.textContent = `${asset.filename} · session start (seconds)`;
    const start = document.createElement('input'); start.type = 'number'; start.min = '0'; start.step = '.01'; start.value = placement.startSeconds.toFixed(3);
    start.disabled = project.phase !== 'import'; label.append(start);
    const apply = document.createElement('button'); apply.textContent = 'Set start'; apply.disabled = start.disabled;
    apply.onclick = () => command('syncOffset', { id: asset.id, startSeconds: Number(start.value) });
    row.append(label, apply);
    if (asset.video) {
      const position = document.createElement('input'); position.type = 'range'; position.min = '0'; position.max = String(Math.max(0, asset.duration - 12)); position.value = String(Math.max(0, asset.duration / 2 - 6)); position.setAttribute('aria-label', `Review position in ${asset.filename}`);
      const play = document.createElement('button'); play.textContent = 'Play sample'; play.disabled = sync.issues.length > 0;
      play.onclick = async () => {
        stopSyncPlayback();
        play.disabled = true;
        try { playSyncSample(await window.projects.command('syncAudition', { id: asset.id, start: Number(position.value) })); }
        catch (error) { importElement('status').textContent = error.message; }
        finally { play.disabled = false; }
      };
      row.append(position, play);
    }
    const status = document.createElement('small'); status.textContent = issue?.message ?? 'Aligned'; row.append(status); list.append(row);
  }
}

function stopSyncPlayback() {
  importElement('sync-video').pause(); importElement('sync-audio').pause();
}

function playSyncSample(sample) {
  syncPlayback = sample;
  const video = importElement('sync-video'), audio = importElement('sync-audio');
  importElement('sync-player').hidden = false;
  audio.onloadedmetadata = null;
  video.src = sample.videoUrl; audio.src = sample.dialogueUrl;
  importElement('sync-listen').value = 'dialogue';
  importElement('sync-listen').querySelector('[value="guide"]').disabled = !sample.guideUrl;
  const note = importElement('sync-playback-note'); note.textContent = `${sample.filename} · ${sample.start.toFixed(1)}s–${sample.end.toFixed(1)}s`;
  video.onloadedmetadata = () => { video.currentTime = sample.start; };
  video.onerror = () => { note.textContent += ' · Picture cannot play in this viewer. Use Export sync XML to check it in Premiere.'; };
  audio.onplay = () => { if (video.readyState) { video.currentTime = sample.start + audio.currentTime; video.play().catch(() => {}); } };
  audio.onpause = () => video.pause();
  audio.onseeked = () => { if (video.readyState) video.currentTime = sample.start + audio.currentTime; };
  video.onseeking = () => {
    const time = Math.max(0, Math.min(sample.end - sample.start, video.currentTime - sample.start));
    if (Math.abs(time - audio.currentTime) > 0.08) audio.currentTime = time;
  };
  video.onplay = () => { if (audio.paused) audio.play().catch(() => {}); };
  video.onpause = () => { if (!audio.paused) audio.pause(); };
  audio.onended = () => video.pause();
  importElement('sync-listen').onchange = event => {
    const time = audio.currentTime, playing = !audio.paused;
    audio.src = event.target.value === 'guide' ? syncPlayback.guideUrl : syncPlayback.dialogueUrl;
    audio.onloadedmetadata = () => { audio.currentTime = time; if (playing) audio.play().catch(() => {}); };
  };
  audio.play().catch(() => {});
}
