(() => {
  const $ = id => document.getElementById(id);
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const kinds = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'static'];
  let review = null;
  let projectRevision = null;
  let previewQueue = Promise.resolve();

  function element(tag, className = '', content = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content;
    return node;
  }

  function field(label, options, value) {
    const wrapper = element('label');
    wrapper.append(element('span', '', label));
    const select = element('select');
    for (const option of options) {
      const item = document.createElement('option');
      item.value = option.value; item.textContent = option.label;
      item.disabled = Boolean(option.disabled);
      select.append(item);
    }
    select.value = value;
    wrapper.append(select);
    return { wrapper, select };
  }

  function svgShape(svg, tag, attributes) {
    const node = document.createElementNS(svgNamespace, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    svg.append(node);
    return node;
  }

  function cropOutline(svg, crop, color, label) {
    if (!crop) return;
    svgShape(svg, 'rect', { x: crop.x * 1000, y: crop.y * 1000, width: crop.width * 1000,
      height: crop.height * 1000, fill: 'none', stroke: color, 'stroke-width': 5 });
    const text = svgShape(svg, 'text', { x: Math.max(8, crop.x * 1000 + 8),
      y: Math.max(28, crop.y * 1000 + 30), fill: color, 'font-size': 30,
      'paint-order': 'stroke', stroke: '#000', 'stroke-width': 5 });
    text.textContent = label;
  }

  function showPicture(host, candidate, geometry) {
    host.replaceChildren();
    if (!candidate?.previewUrl) {
      host.append(element('div', 'broll-placeholder', candidate?.warning ?? 'No artwork selected for this beat.'));
      return;
    }
    const stage = element('div', 'broll-fill');
    stage.style.aspectRatio = `${review.output.width}/${review.output.height}`;
    const previewImage = element('img'); previewImage.alt = candidate.filename; previewImage.loading = 'lazy';
    previewImage.src = candidate.previewUrl;
    const layout = geometry?.previewLayout;
    if (layout) {
      previewImage.style.width = `${layout.widthPercent}%`;
      previewImage.style.height = `${layout.heightPercent}%`;
      previewImage.style.left = `${layout.leftPercent}%`;
      previewImage.style.top = `${layout.topPercent}%`;
    } else {
      Object.assign(previewImage.style, { width: '100%', height: '100%', objectFit: 'cover', left: '0', top: '0' });
    }
    stage.append(previewImage);
    const stageLabel = element('p', 'broll-meta', geometry?.kind === 'zoom_in' ? 'Fill-frame preview: final keyframe' :
      geometry?.kind === 'zoom_out' ? 'Fill-frame preview: initial keyframe' : 'Fill-frame preview: initial frame');
    const source = element('div', 'broll-source');
    source.style.width = `${Math.min(340, 240 * candidate.width / candidate.height)}px`;
    source.style.aspectRatio = `${candidate.width}/${candidate.height}`;
    const sourceImage = element('img'); sourceImage.alt = `Full source image: ${candidate.filename}`;
    sourceImage.src = candidate.previewUrl; sourceImage.loading = 'lazy'; source.append(sourceImage);
    const svg = document.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 1000');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-label', 'Detections, anchor, and keyframe crop');
    for (const [type, items] of [['face', candidate.detection?.faces], ['object', candidate.detection?.objects]]) {
      for (const item of items ?? []) {
        svgShape(svg, 'rect', { x: item.x * 1000, y: item.y * 1000, width: item.width * 1000,
          height: item.height * 1000, fill: 'none', stroke: type === 'face' ? '#f3c477' : '#dcb0f3', 'stroke-width': 3 });
      }
    }
    if (geometry?.kind === 'zoom_in') cropOutline(svg, geometry.endCrop, '#54e18a', 'Zoom-in final');
    else if (geometry?.kind === 'zoom_out') cropOutline(svg, geometry.startCrop, '#ff6c6c', 'Zoom-out initial');
    else if (geometry?.kind?.startsWith('pan_')) {
      cropOutline(svg, geometry.startCrop, '#58d8f1', 'Pan start');
      cropOutline(svg, geometry.endCrop, '#f3db77', 'Pan end');
    } else if (geometry) cropOutline(svg, geometry.startCrop, '#d6e0da', 'Static');
    if (geometry?.anchorPoint) svgShape(svg, 'circle', { cx: geometry.anchorPoint.x * 1000,
      cy: geometry.anchorPoint.y * 1000, r: 9, fill: '#fff', stroke: '#000', 'stroke-width': 3 });
    source.append(svg);
    const mapLabel = element('p', 'broll-meta', 'Full source: amber/purple detections; white dot is anchor.');
    host.append(stage, stageLabel, source, mapLabel);
    previewImage.onerror = () => { stage.replaceChildren(element('div', 'broll-placeholder', 'Artwork file could not be loaded.')); };
  }

  function beatCard(beat) {
    const card = element('article', 'broll-card');
    card.dataset.beatId = beat.id;
    const seconds = (beat.endFrame - beat.startFrame) * review.output.fps.denominator / review.output.fps.numerator;
    card.append(element('h3', '', `${(beat.startFrame * review.output.fps.denominator / review.output.fps.numerator).toFixed(1)}s · ${seconds.toFixed(1)}s beat${beat.opening ? ' · opening' : ''}${beat.closing ? ' · closing' : ''}${beat.establishing ? ' · establishing' : ''}`));
    if (beat.previousSentence) card.append(element('p', 'broll-context', `Before: ${beat.previousSentence}`));
    card.append(element('p', 'broll-text', beat.text));
    if (beat.nextSentence) card.append(element('p', 'broll-context', `After: ${beat.nextSentence}`));
    card.append(element('p', 'broll-meta', `${beat.artworkNeed} artwork · ${beat.talkingHeadPriority} talking-head priority · ${beat.searchStatus} · ${beat.manuallyOverridden ? `override layer ${beat.trackLayer}` : 'base decision'}`));
    card.append(element('p', 'broll-meta', `Decision: ${beat.decisionReason}`));
    const warning = element('p', 'broll-warning'); card.append(warning);
    const layout = element('div', 'broll-layout');
    const picture = element('div'); layout.append(picture);
    const controls = element('div', 'broll-controls'); layout.append(controls);
    const imageField = field('Artwork candidate', [{ value: '', label: 'No artwork' }, ...beat.candidates.map(item => ({
      value: item.imageId, label: `${item.filename} · ${item.width}×${item.height}${item.usable ? '' : ' · unavailable'}`,
      disabled: !item.usable && item.imageId !== beat.selectedImageId }))], beat.selectedImageId ?? '');
    const kindField = field('Motion', kinds.map(kind => ({ value: kind, label: kind.replace('_', ' ') })), beat.intent?.kind ?? 'static');
    const speedField = field('Speed', [{ value: 'slow', label: 'Slow' }, { value: 'fast', label: 'Fast' }], beat.intent?.speed ?? 'slow');
    const anchorField = field('Anchor', [], beat.intent?.anchorId ?? 'center');
    controls.append(imageField.wrapper, kindField.wrapper, speedField.wrapper, anchorField.wrapper);
    const save = element('button', '', 'Save this beat as an override'); save.type = 'button'; controls.append(save);
    const status = element('p', 'broll-meta'); controls.append(status);
    card.append(layout);
    let previewCounter = 0;
    const chosen = () => beat.candidates.find(item => item.imageId === imageField.select.value) ?? null;
    function updateAnchors() {
      const previous = anchorField.select.value || beat.intent?.anchorId || 'center';
      anchorField.select.replaceChildren();
      for (const item of chosen()?.anchors ?? [{ id: 'center', label: 'Image center' }]) {
        const option = document.createElement('option'); option.value = item.id; option.textContent = item.label;
        anchorField.select.append(option);
      }
      anchorField.select.value = [...anchorField.select.options].some(item => item.value === previous) ? previous : 'center';
    }
    function showWarnings(geometry) {
      const messages = [...(beat.searchWarnings ?? []), ...(geometry?.warnings ?? [])];
      if (!chosen() && beat.artworkNeed === 'required') messages.push('Required artwork is missing.');
      if (chosen() && !chosen().usable) messages.push(chosen().warning ?? 'Artwork unavailable.');
      warning.textContent = messages.join(' · ');
    }
    async function refreshPreview() {
      const sequence = ++previewCounter;
      const candidate = chosen();
      save.disabled = true;
      if (!candidate) { showPicture(picture, null, null); showWarnings(null); status.textContent = ''; save.disabled = false; return; }
      status.textContent = 'Calculating crop…';
      try {
        const payload = { beatId: beat.id,
          imageId: candidate.imageId, kind: kindField.select.value, speed: speedField.select.value,
          anchorId: anchorField.select.value };
        const request = previewQueue.catch(() => {}).then(() => window.projects.command('brollPreview', payload));
        previewQueue = request;
        const response = await request;
        if (sequence !== previewCounter) return;
        showPicture(picture, candidate, response.geometry);
        showWarnings(response.geometry);
        status.textContent = response.geometry?.kind !== kindField.select.value ? 'Requested motion is unsafe; preview uses static fallback.' : '';
        save.disabled = !candidate.usable;
      } catch (error) {
        if (sequence !== previewCounter) return;
        showPicture(picture, candidate, null); showWarnings(null); status.textContent = error.message;
        save.disabled = true;
      }
    }
    updateAnchors();
    imageField.select.onchange = () => { updateAnchors(); refreshPreview(); };
    for (const select of [kindField.select, speedField.select, anchorField.select]) select.onchange = refreshPreview;
    save.onclick = async () => {
      save.disabled = true; status.textContent = 'Saving this beat…';
      try {
        await previewQueue.catch(() => {});
        const result = await window.projects.command('brollOverride', { projectRevision,
          beatPlanId: review.beatPlanId, selectionId: review.selectionId, motionId: review.motionId,
          beatId: beat.id, imageId: imageField.select.value || null,
          kind: kindField.select.value, speed: speedField.select.value, anchorId: anchorField.select.value });
        projectRevision = result.projectRevision; review = result.review;
        const scroll = $('broll-beat-list').scrollTop;
        render(); $('broll-beat-list').scrollTop = scroll;
      } catch (error) { status.textContent = error.message; save.disabled = false; }
    };
    if (chosen()?.usable && beat.geometry && beat.selectedImageId === chosen().imageId) {
      showPicture(picture, chosen(), beat.geometry); showWarnings(beat.geometry);
    } else refreshPreview();
    return card;
  }

  function render() {
    const fps = review.output.fps.numerator / review.output.fps.denominator;
    const coverage = review.coverage;
    $('broll-review-summary').textContent = `${review.beats.length} beats · ${coverage.brollPercent.toFixed(1)}% B-roll · longest uncovered ${(coverage.longestUncoveredFrames / fps).toFixed(1)}s · ${coverage.warnings.length} coverage warnings · ${review.exportPreview ? `${review.exportPreview.clipCount} export stills on ${review.exportPreview.trackCount} artwork tracks` : 'export preflight not ready'}`;
    $('broll-review-warning').textContent = [review.catalogWarning, review.exportWarning, ...coverage.warnings.map(item =>
      `${item.code}${item.beatId ? ` (${item.beatId})` : ''}`)].filter(Boolean).join(' · ');
    $('export-broll').disabled = Boolean(review.exportWarning);
    $('broll-beat-list').replaceChildren(...review.beats.map(beatCard));
  }

  $('open-broll-review').onclick = async () => {
    const button = $('open-broll-review'); button.disabled = true;
    try {
      const snapshot = await window.projects.command('get');
      projectRevision = snapshot.project.revision;
      review = await window.projects.command('brollReview');
      render(); $('broll-review').classList.remove('hidden'); $('broll-review').scrollIntoView({ behavior: 'smooth' });
    } catch (error) { $('status').textContent = error.message; }
    finally { button.disabled = false; }
  };
  $('close-broll-review').onclick = () => $('broll-review').classList.add('hidden');
  $('export-broll').onclick = async () => {
    const button = $('export-broll'); button.disabled = true;
    $('broll-review-warning').textContent = 'Checking artwork and compiling the Premiere timeline…';
    try {
      await previewQueue.catch(() => {});
      const result = await window.projects.command('brollExport');
      $('broll-review-warning').textContent = result.canceled ? 'Export canceled.' :
        `Exported ${result.clipCount} still clips on ${result.trackCount} artwork tracks: ${result.path}`;
    } catch (error) { $('broll-review-warning').textContent = error.message; }
    finally { button.disabled = false; }
  };
})();
