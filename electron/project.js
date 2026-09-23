let state;
let sourceWordId = null;
let playbackMode = null;
let reviewNavigator = null;
let reviewQueue = Promise.resolve();
const $ = id => document.getElementById(id);
const workspace = new URLSearchParams(location.search).get('workspace') === 'broll' ? 'broll' : 'edit';
let openBrollOnLoad = workspace === 'broll';
document.querySelector(`[data-studio-tab="${workspace}"]`)?.classList.add('active');
document.querySelector(`[data-studio-tab="${workspace === 'broll' ? 'edit' : 'broll'}"]`)?.classList.remove('active');
$('edit-workspace').classList.toggle('hidden', workspace !== 'edit');
$('broll-workspace').classList.toggle('hidden', workspace !== 'broll');
function sourceSelected(word) { sourceWordId = word.id; $('audition').disabled = false; $('audition').textContent = `Play source at ${(word.startMs/1000).toFixed(2)}s`; }
function reviewCommand(command) {
  reviewQueue=reviewQueue.catch(()=>{}).then(()=>run('review',{...command,analysisId:state.reviewView.analysisId,revision:state.reviewView.revision}));
  return reviewQueue;
}
function updatePlayback(value) {
  $('review-playback').classList.toggle('hidden', !value.analysisResult);
  $('export').disabled = !value.reviewView;
  $('preview').disabled = !value.reviewView;
  $('refine').disabled = !value.analysisResult;
  $('lock-handoff').disabled = !value.reviewView || !!value.cutIssues?.length;
  $('plan-broll-beats').disabled = !value.handoffCurrent;
  $('select-broll-images').disabled = !value.brollPlanCurrent || value.brollBeatPlan?.status !== 'proposed';
  $('plan-broll-motion').disabled = !value.brollSelectionCurrent;
  $('open-broll-review').disabled = !value.brollMotionCurrent;
  $('handoff-status').textContent = value.lockedHandoff ?
    `${value.lockedHandoff.wordCount} words · ${value.handoffCurrent ? 'Current' : 'Older selection · lock edit again'}` : 'Not locked';
  $('broll-beat-status').textContent = value.brollBeatPlan ?
    `${value.brollBeatPlan.beatCount} beats · ${value.brollPlanCurrent ? 'Current' : 'Older locked edit · plan again'}` : 'Not planned';
  $('broll-selection-status').textContent = value.brollSelection ?
    `${value.brollSelection.selectedCount} images · ${value.brollSelection.brollPercent.toFixed(1)}% coverage · ${value.brollSelectionCurrent ? 'Current' : 'Older beat plan'}` : 'Not selected';
  $('broll-motion-status').textContent = value.brollMotion ?
    `${value.brollMotion.motionCount} clips · ${value.brollMotion.warningCount} warnings · ${value.brollMotionCurrent ? 'Current' : 'Older selection'}` : 'Not planned';
  $('broll-empty').textContent = !value.lockedHandoff ? 'Lock an edit to begin B-Roll planning.' :
    !value.brollBeatPlan ? 'Plan visual beats to begin.' :
    !value.brollSelection ? 'Select images for the current beat plan.' :
    !value.brollMotion ? 'Plan motion, then review the decisions.' : 'Open Review decisions to inspect images and motion.';
  const issues = value.cutIssues ?? [];
  $('cut-issues').classList.toggle('hidden', !issues.length);
  $('cut-issues').querySelector('ul').replaceChildren(...issues.map(issue => {
    const item=document.createElement('li');item.textContent=`${issue.message}${issue.text?' — '+issue.text.slice(0,90):''} `;
    if(issue.firstWordId) {
      const button=document.createElement('button');button.textContent='Review this passage';
      const wordId=issue.reviewWordId??issue.firstWordId;
      button.onclick=()=>{reviewNavigator?.selectWord(wordId);run('audition',{wordId});};
      item.append(button);
    }
    return item;
  }));
  const media = playbackMode === 'source' ? value.audition : value.preview;
  const video = $('review-video');
  if(!media) {video.pause();video.removeAttribute('src');video.classList.add('hidden');return;}
  video.classList.remove('hidden');
  if(video.getAttribute('src')!==media.url) {
    video.src=media.url;
    video.onloadedmetadata=()=>{video.currentTime=playbackMode==='source'?Math.max(0,media.wordSeconds-.4):0;};
  }
  $('playback-status').textContent=playbackMode==='source'?`Source audition · ${media.filename} · starts at ${media.startSeconds.toFixed(2)}s · includes kept and removed speech.`:value.previewCurrent?`Edited playback · selection revision ${media.revision} · ${media.durationSeconds.toFixed(2)} seconds`:'Outdated playback — rebuild to hear the current selection. XML export uses your current selection.';
  if(playbackMode!=='source' && !value.previewCurrent)video.pause();
}
function show(value) {
  if(state?.project.id!==value.project.id) {sourceWordId=null;playbackMode=null;$('audition').disabled=true;}
  state = value;
  const p = value.project;
  $('name').value = p.name; $('script-text').value = p.script.original;
  for (const task of ['beatPlanning', 'imageSelection', 'allocation', 'motion']) {
    for (const part of ['systemText', 'userText']) $(task + '-' + part).value = p.brollPromptTemplates?.[task]?.[part] ?? value.brollPromptDefaults[task][part];
  }
  $('save-broll-prompts').disabled = !value.location;
  $('save-broll-motion-config').disabled = !value.location;
  $('save-broll-artwork-config').disabled = !value.location;
  $('update-broll-motion').disabled = !value.brollMotionCurrent;
  for (const key of ['slowZoomRate', 'fastZoomRate', 'slowPanRate', 'fastPanRate', 'subjectMargin']) $(key).value = 100 * p.brollMotionConfig[key];
  $('maxRelativeScale').value = p.brollMotionConfig.maxRelativeScale;
  $('minimumClipSeconds').value = p.brollArtworkConfig.minimumClipSeconds;
  $('pause').value = p.settings.pauseMs / 1000; $('restart').value = p.settings.restartPhrase;
  $('script-summary').textContent = `${p.script.sentences.length} spoken sentences · ${p.script.annotations.length} nonspoken notes`;
  $('warnings').textContent = [...value.warnings, ...p.media.filter(a => !a.selectedAudio).map(a => `${a.filename}: no audio stream; select another recording before analysis.`)].join('\n');
  $('media-list').replaceChildren();
  p.media.forEach((asset, i) => {
    const row = document.createElement('tr');
    const order = document.createElement('td'); order.textContent = String(i + 1);
    for (const [label, delta] of [['↑', -1], ['↓', 1]]) {
      const button = document.createElement('button'); button.textContent = label;
      button.setAttribute('aria-label', `Move ${asset.filename} ${delta < 0 ? 'up' : 'down'}`);
      button.disabled = i + delta < 0 || i + delta >= p.media.length;
      button.onclick = () => { const ids = p.media.map(a => a.id); [ids[i], ids[i + delta]] = [ids[i + delta], ids[i]]; run('order', ids); };
      order.append(button);
    }
    const name = document.createElement('td'); name.textContent = asset.filename;
    const format = document.createElement('td'); format.textContent = `${asset.video.width}×${asset.video.height} · ${asset.duration.toFixed(1)}s · ${asset.video.frameRate} fps`;
    const audio = document.createElement('td'); const select = document.createElement('select'); select.setAttribute('aria-label', `Audio channel for ${asset.filename}`);
    asset.audio.forEach(stream => { for (let channel = 0; channel < stream.channels; channel++) {
      const option = document.createElement('option'); option.value = `${stream.index}:${channel}`; option.textContent = `Stream ${stream.index} · Channel ${channel + 1}`;
      option.selected = stream.index === asset.selectedAudio?.streamIndex && channel === asset.selectedAudio?.channel; select.append(option);
    } });
    select.disabled = !asset.audio.length;
    select.onchange = () => { const [streamIndex, channel] = select.value.split(':').map(Number); run('channel', { id: asset.id, streamIndex, channel }); };
    audio.append(select); row.append(order, name, format, audio); $('media-list').append(row);
  });
  const frozen = p.phase !== 'import';
  for (const id of ['media', 'script', 'text', 'settings', 'name', 'script-text', 'pause', 'restart']) $(id).disabled = frozen;
  if (frozen) $('media-list').querySelectorAll('button, select').forEach(e => { e.disabled = true; });
  $('analyze').disabled = !value.location || !p.media.length || !p.script.sentences.length;
  $('analysis-summary').textContent = p.analysis ? `Analysis: ${p.analysis.status}. Inputs frozen.` : 'Save your inputs, then start analysis.';
  $('analysis-results').replaceChildren();
  if (!value.analysisResult) { disposeReview(); $('review-diff').replaceChildren(); $('review-diff').classList.add('hidden'); }
  if (value.analysisResult) {
    const result = value.analysisResult;
    reviewNavigator = renderTranscriptReview({ project: p, result: {...result, words: value.displayWords ?? result.words}, review: value.reviewView, error: value.reviewError, onCommand: reviewCommand, onSeek: sourceSelected });
    $('analysis-results').classList.add('hidden');
    $('analysis-summary').textContent += ` ${result.summary.wordCount} words · ${result.summary.selectedTakes} suggested takes · ${result.summary.needsReview} flagged for review.`;
    $('warnings').textContent += '\n' + result.warnings.map(w => w.message).join('\n');
    if(result.timingSummary) {
      const timing=result.timingSummary;
      $('analysis-summary').textContent += ' Word timings are approximate; your text selection determines the edit.';
      $('warnings').textContent = value.warnings.concat(result.warnings.filter(w=>w.kind!=='invalid-word-timing').map(w=>w.message), `${(value.displayWords??result.words).filter(w=>!w.valid).length} words still have invalid timing estimates.`).join('\n');
    }
  }
  $('edit-empty').classList.toggle('hidden', Boolean(value.analysisResult));
  updatePlayback(value);
  if (openBrollOnLoad && value.brollMotion && !$('open-broll-review').disabled) {
    openBrollOnLoad = false;
    queueMicrotask(() => $('open-broll-review').click());
  }
}
async function run(action, payload) {
  const controls = [...document.querySelectorAll('button, input, select, textarea')].filter(e => e.id !== 'cancel');
  const previous = controls.map(e => e.disabled);
  controls.forEach(e => { e.disabled = true; });
  $('status').textContent = 'Working…';
  try {
    const value = await window.projects.command(action, payload);
    if(action==='audition')playbackMode='source';
    if(action==='preview')playbackMode='edit';
    controls.forEach((e, i) => { e.disabled = previous[i]; });
    show(value);
    if (action === 'recalculateBrollMotion') window.dispatchEvent(new Event('broll-motion-updated'));
    if(action==='audition') {
      const video=$('review-video');
      const play=()=>{video.currentTime=Math.max(0,value.audition.wordSeconds-.4);video.play().catch(()=>{$('playback-status').textContent+=' Press play to start.';});};
      if(video.readyState>=1)play();else video.addEventListener('loadedmetadata',play,{once:true});
    }
    $('status').textContent = action === 'recalculateBrollMotion' ?
      'Motion crops updated locally. Reopen B-roll review before exporting.' :
      `${action === 'save' ? 'Saved. ' : ''}${value.location ?? 'Not saved yet'} · Revision ${value.project.revision}`;
  } catch (error) {
    controls.forEach((e, i) => { e.disabled = previous[i]; });
    try { show(await window.projects.command('get')); } catch {}
    $('status').textContent = error.message.includes('abort') ? 'Import canceled. Previous inputs retained.' : error.message;
  }
}
if (!window.projects || typeof window.projects.command !== 'function') {
  $('status').textContent = 'This project screen must be opened from MythiCut Studio (Electron). Run `npm run project` in the project folder.';
  $('warnings').textContent = 'The browser preview cannot access local media, project files, or the analysis worker.';
  document.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = true; });
} else {
  document.querySelectorAll('[data-studio-tab]').forEach(button => {
    button.onclick = () => window.studio.selectTab(button.dataset.studioTab).catch(error => { $('status').textContent = error.message; });
  });
  const configuration = $('configuration-dialog');
  const showConfigurationPanel = panel => {
    document.querySelectorAll('[data-config-panel]').forEach(button => button.classList.toggle('active', button.dataset.configPanel === panel));
    document.querySelectorAll('[data-config-content]').forEach(section => { section.hidden = section.dataset.configContent !== panel; });
  };
  document.querySelectorAll('[data-config-panel]').forEach(button => button.onclick = () => showConfigurationPanel(button.dataset.configPanel));
  $('open-configuration').onclick = () => { showConfigurationPanel(workspace === 'broll' ? 'motion' : 'edit'); configuration.showModal(); };
  $('close-configuration').onclick = () => configuration.close();
  for (const action of ['new', 'open', 'save', 'media', 'script', 'analyze']) $(action).onclick = () => run(action);
  $('text').onclick = () => run('text', $('script-text').value);
  $('settings').onclick = () => run('settings', { name: $('name').value, pauseMs: Number($('pause').value) * 1000, restartPhrase: $('restart').value });
  $('cancel').onclick = () => window.projects.command('cancel').catch(error => { $('status').textContent = error.message; });
  $('audition').onclick = () => run('audition', { wordId: sourceWordId });
  $('preview').onclick = () => run('preview');
  $('refine').onclick = () => run('refine');
  $('export').onclick = () => run('export');
  $('lock-handoff').onclick = () => run('lockHandoff');
  $('plan-broll-beats').onclick = () => run('planBrollBeats');
  $('select-broll-images').onclick = () => run('selectBrollImages');
  $('plan-broll-motion').onclick = () => run('planBrollMotion');
  const motionSettings = () => ({
    slowZoomRate: Number($('slowZoomRate').value) / 100,
    fastZoomRate: Number($('fastZoomRate').value) / 100,
    slowPanRate: Number($('slowPanRate').value) / 100,
    fastPanRate: Number($('fastPanRate').value) / 100,
    maxRelativeScale: Number($('maxRelativeScale').value),
    subjectMargin: Number($('subjectMargin').value) / 100
  });
  $('save-broll-motion-config').onclick = () => run('brollMotionConfig', motionSettings());
  $('save-broll-artwork-config').onclick = () => run('brollArtworkConfig', {
    minimumClipSeconds: Number($('minimumClipSeconds').value)
  });
  $('update-broll-motion').onclick = () => run('recalculateBrollMotion', motionSettings());
  $('reset-broll-prompts').onclick = () => {
    for (const task of ['beatPlanning', 'imageSelection', 'allocation', 'motion'])
      for (const part of ['systemText', 'userText']) $(task + '-' + part).value = state.brollPromptDefaults[task][part];
    $('status').textContent = 'B-roll prompt defaults restored in the form. Save to apply them to future runs.';
  };
  $('save-broll-prompts').onclick = () => run('brollPromptTemplates', Object.fromEntries(
    ['beatPlanning', 'imageSelection', 'allocation', 'motion'].map(task => [task, {
      systemText: $(task + '-systemText').value, userText: $(task + '-userText').value
    }])
  ));
  window.projects.onProgress(p => { $('status').textContent = `${p.stage}${p.filename ? ': ' + p.filename : ''}${p.percent !== undefined ? ' · ' + p.percent + '%' : ''}${p.total ? ' · file ' + (p.completed + 1) + '/' + p.total : ''}`; });
  run('get');
}
