let state;
const $ = id => document.getElementById(id);
function renderReview(result) {
  const shell = $('review-diff');
  shell.classList.remove('hidden');
  $('analysis-results').classList.add('hidden');
  const params = new URLSearchParams(location.search);
  const variant = ['A', 'B', 'C'].includes(params.get('variant')) ? params.get('variant') : 'A';
  const choices = new Map((result.takeSelection ?? []).map(choice => [choice.sentence.id, choice]));
  const selectedRange = choice => {
    const decision = state.project.review.decisions[choice.sentence.id];
    if (decision?.action === 'reject') return null;
    if (decision?.action === 'approve') return choice.candidates.find(c => c.id === decision.candidateId) ?? null;
    return choice.selected;
  };
  const scriptPane = document.createElement('div'); scriptPane.className = 'pane script';
  const scriptTitle = document.createElement('div'); scriptTitle.className = 'pane-title'; scriptTitle.textContent = 'Original script'; scriptPane.append(scriptTitle);
  const transcriptPane = document.createElement('div'); transcriptPane.className = 'pane recording';
  const transcriptTitle = document.createElement('div'); transcriptTitle.className = 'pane-title'; transcriptTitle.textContent = 'Recording transcript · green = provisional keeper'; transcriptPane.append(transcriptTitle);
  const scriptElements = new Map(); const transcriptElements = [];
  for (const sentence of state.project.script.sentences) {
    const line = document.createElement('div'); line.className = 'line'; line.dataset.sentenceId = sentence.id;
    const number = document.createElement('span'); number.className = 'line-number'; number.textContent = sentence.id.replace('s', '') + ' '; line.append(number);
    const text = document.createElement('span'); text.textContent = sentence.text; line.append(text);
    const choice = choices.get(sentence.id); const range = choice && selectedRange(choice);
    if (range) { const tag = document.createElement('span'); tag.className = 'snippet'; tag.textContent = `  ↳ ${range.id} · ${(range.startMs / 1000).toFixed(2)}s`; line.append(tag); line.dataset.targetMs = range.startMs; }
    line.onclick = () => focusSentence(sentence.id, true); scriptPane.append(line); scriptElements.set(sentence.id, line);
  }
  let lastEnd = null;
  for (const word of result.words) {
    if (lastEnd !== null && word.startMs - lastEnd > 1000) { const gap = document.createElement('div'); gap.className = 'record-gap'; transcriptPane.append(gap); }
    const span = document.createElement('span'); span.className = 'record-word'; span.textContent = word.text; span.dataset.ms = word.startMs; span.dataset.wordId = word.id;
    const owner = [...choices.values()].find(choice => { const range = selectedRange(choice); return range && range.mediaId === word.mediaId && word.startMs >= range.startMs - 150 && word.endMs <= range.endMs + 150; });
    if (owner) { span.classList.add('keeper'); span.dataset.sentenceId = owner.sentence.id; }
    if (!word.valid || word.needsReview) span.classList.add('uncertain');
    span.title = `${(word.startMs / 1000).toFixed(2)}–${(word.endMs / 1000).toFixed(2)}s${owner ? ` · ${owner.sentence.id}` : ''}`;
    span.onclick = () => owner ? focusSentence(owner.sentence.id, true) : focusWord(span, false); transcriptPane.append(span); transcriptElements.push(span); lastEnd = word.endMs;
  }
  const focusWord = (word, moveScript) => { transcriptElements.forEach(e => e.classList.remove('focused')); word.classList.add('focused'); word.scrollIntoView({ block: 'center' }); if (moveScript && word.dataset.sentenceId) scriptElements.get(word.dataset.sentenceId)?.scrollIntoView({ block: 'center' }); };
  const focusSentence = (sentenceId, scrollTranscript) => { scriptElements.forEach(e => e.classList.remove('focused')); const line = scriptElements.get(sentenceId); line?.classList.add('focused'); if (scrollTranscript) { const target = transcriptElements.find(e => e.dataset.sentenceId === sentenceId); if (target) focusWord(target, false); } };
  // Scrolling either pane re-identifies the item at its visual center and
  // resynchronizes the other pane. Neither pane is locked to the other.
  let syncing = false;
  scriptPane.onscroll = () => { if (syncing) return; const box = scriptPane.getBoundingClientRect(); const line = [...scriptElements.values()].find(e => { const r = e.getBoundingClientRect(); return r.top <= box.top + box.height / 2 && r.bottom >= box.top + box.height / 2; }); if (line) { syncing = true; focusSentence(line.dataset.sentenceId, true); setTimeout(() => { syncing = false; }, 30); } };
  transcriptPane.onscroll = () => { if (syncing) return; const box = transcriptPane.getBoundingClientRect(); const word = transcriptElements.find(e => { const r = e.getBoundingClientRect(); return r.top <= box.top + box.height / 2 && r.bottom >= box.top + box.height / 2; }); if (word?.dataset.sentenceId) { syncing = true; focusSentence(word.dataset.sentenceId, false); setTimeout(() => { syncing = false; }, 30); } };
  const toolbar = document.createElement('div'); toolbar.className = 'review-toolbar'; const heading = document.createElement('strong'); heading.textContent = 'Synchronized script ↔ recording review'; const help = document.createElement('span'); help.textContent = 'Click a script sentence to jump to its keeper take. Scroll either pane independently.'; toolbar.append(heading, help);
  const switcher = document.createElement('div'); switcher.className = 'variant-switcher'; [['A', 'IDE diff'], ['B', 'Navigator'], ['C', 'Stacked']].forEach(([key, label]) => { const button = document.createElement('button'); button.textContent = `${key} · ${label}`; button.className = key === variant ? 'active' : ''; button.onclick = () => { params.set('variant', key); history.replaceState(null, '', `${location.pathname}?${params}`); renderReview(result); }; switcher.append(button); });
  const content = document.createElement('div'); content.className = variant === 'A' ? 'diff' : variant === 'B' ? 'variant-b' : 'variant-c';
  if (variant === 'B') { scriptPane.querySelectorAll('.line').forEach(line => { const snippet = line.querySelector('.snippet'); if (snippet) snippet.className = 'snippet'; }); }
  content.append(scriptPane, transcriptPane); shell.replaceChildren(toolbar, content, switcher); shell.scrollIntoView({ block: 'start' });
}
function show(value) {
  state = value;
  const p = value.project;
  $('name').value = p.name; $('script-text').value = p.script.original;
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
  if (value.analysisResult) {
    const result = value.analysisResult;
    renderReview(result);
    $('analysis-summary').textContent += ` ${result.summary.wordCount} words · ${result.summary.withCandidates}/${result.summary.sentenceCount} sentences have candidates · ${result.summary.selectedTakes} provisional takes · ${result.summary.needsReview} need review · ${result.summary.invalidIntervals} word timings need refinement.`;
    $('warnings').textContent += '\n' + result.warnings.map(w => w.message).join('\n');
    state.project.media.forEach(asset => {
      const details = document.createElement('details'); const summary = document.createElement('summary');
      summary.textContent = `Word transcript — ${asset.filename} (estimated timestamps)`;
      details.append(summary);
      let populated = false;
      details.ontoggle = () => {
        if (!details.open || populated) return;
        populated = true; const text = document.createElement('pre'); text.style.whiteSpace = 'pre-wrap';
        text.textContent = result.words.filter(w => w.mediaId === asset.id).map(w => `${(w.startMs / 1000).toFixed(2)}–${(w.endMs / 1000).toFixed(2)}s ${w.valid ? '' : '[timing review] '}${w.text}`).join('\n');
        details.append(text);
      };
      $('analysis-results').append(details);
    });
    const selectionHeading = document.createElement('h3'); selectionHeading.textContent = 'Provisional take selection'; $('analysis-results').append(selectionHeading);
    result.takeSelection?.forEach(choice => {
      const details = document.createElement('details'); const summary = document.createElement('summary');
      const decision = state.project.review.decisions[choice.sentence.id];
      summary.textContent = `${decision?.action === 'approve' ? 'Approved' : decision?.action === 'reject' ? 'Rejected' : choice.selected ? 'Provisional' : 'Review needed'} — ${choice.sentence.id} — ${choice.sentence.text}`;
      details.append(summary);
      const p = document.createElement('p'); p.textContent = choice.selected ? `${choice.selected.id} · ${(choice.selected.startMs / 1000).toFixed(2)}–${(choice.selected.endMs / 1000).toFixed(2)}s · ${Math.round(choice.selected.score * 100)}% similarity · ${choice.flags.join(', ') || 'no automatic flag'}` : choice.flags.join(', '); details.append(p);
      const options = [...(choice.candidates ?? [])];
      options.forEach(candidate => {
        const button = document.createElement('button'); button.textContent = `${decision?.candidateId === candidate.id ? 'Approved · ' : 'Approve · '}${candidate.id} · ${(candidate.startMs / 1000).toFixed(2)}s`;
        button.disabled = Boolean(decision?.action === 'approve' && decision.candidateId === candidate.id); button.onclick = () => run('decision', { action: 'approve', sentenceId: choice.sentence.id, candidateId: candidate.id }); details.append(button);
      });
      const reject = document.createElement('button'); reject.textContent = decision?.action === 'reject' ? 'Rejected' : 'Reject all'; reject.disabled = decision?.action === 'reject'; reject.onclick = () => run('decision', { action: 'reject', sentenceId: choice.sentence.id }); details.append(reject);
      if (decision) { const clear = document.createElement('button'); clear.textContent = 'Clear decision'; clear.onclick = () => run('decision', { action: 'clear', sentenceId: choice.sentence.id }); details.append(clear); }
      $('analysis-results').append(details);
    });
    const evidenceHeading = document.createElement('h3'); evidenceHeading.textContent = 'Sentence candidate evidence'; $('analysis-results').append(evidenceHeading);
    result.matches.forEach(match => {
      const details = document.createElement('details'); const summary = document.createElement('summary');
      summary.textContent = `${match.candidates.length} candidate(s) — ${match.text}`;
      details.append(summary);
      const explanation = document.createElement('p'); explanation.textContent = match.reason; details.append(explanation);
      match.candidates.forEach(candidate => {
        const p = document.createElement('p');
        const media = state.project.media.find(m => m.id === candidate.mediaId);
        p.textContent = `${candidate.id === match.latestCandidateId ? 'Latest candidate — requires review · ' : ''}${media?.filename} · ${(candidate.startMs / 1000).toFixed(2)}–${(candidate.endMs / 1000).toFixed(2)}s · ${Math.round(candidate.score * 100)}% text similarity · ${candidate.text}`;
        details.append(p);
      });
      $('analysis-results').append(details);
    });
  }
}
async function run(action, payload) {
  const controls = [...document.querySelectorAll('button, input, select, textarea')].filter(e => e.id !== 'cancel');
  const previous = controls.map(e => e.disabled);
  controls.forEach(e => { e.disabled = true; });
  $('status').textContent = 'Working…';
  try {
    const value = await window.projects.command(action, payload);
    controls.forEach((e, i) => { e.disabled = previous[i]; });
    show(value);
    $('status').textContent = `${action === 'save' ? 'Saved. ' : ''}${value.location ?? 'Not saved yet'} · Revision ${value.project.revision}`;
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
  for (const action of ['new', 'open', 'save', 'media', 'script', 'analyze']) $(action).onclick = () => run(action);
  $('text').onclick = () => run('text', $('script-text').value);
  $('settings').onclick = () => run('settings', { name: $('name').value, pauseMs: Number($('pause').value) * 1000, restartPhrase: $('restart').value });
  $('cancel').onclick = () => window.projects.command('cancel').catch(error => { $('status').textContent = error.message; });
  window.projects.onProgress(p => { $('status').textContent = `${p.stage}${p.filename ? ': ' + p.filename : ''}${p.percent !== undefined ? ' · ' + p.percent + '%' : ''}${p.total ? ' · file ' + (p.completed + 1) + '/' + p.total : ''}`; });
  run('get');
}
