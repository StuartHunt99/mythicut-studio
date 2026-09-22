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
    svgShape(svg, 'rect', { x: crop.x, y: crop.y, width: crop.width,
      height: crop.height, fill: 'none', stroke: color, 'stroke-width': 5 });
    const text = svgShape(svg, 'text', { x: Math.max(8, crop.x + 8),
      y: Math.max(28, crop.y + 30), fill: color, 'font-size': 30,
      'paint-order': 'stroke', stroke: '#000', 'stroke-width': 5 });
    text.textContent = label;
  }

  function displayedCrop(candidate, geometry) {
    if (geometry?.previewLayout?.crop) return geometry.previewLayout.crop;
    const sourceRatio = candidate.width / candidate.height;
    const outputRatio = review.output.width / review.output.height;
    if (sourceRatio > outputRatio) {
      const width = outputRatio / sourceRatio;
      return { x: (1 - width) / 2, y: 0, width, height: 1 };
    }
    const height = sourceRatio / outputRatio;
    return { x: 0, y: (1 - height) / 2, width: 1, height };
  }

  const safetyWarnings = new Set(['zoom_exceeds_quality_scale_limit', 'pan_exceeds_quality_scale_limit',
    'subject_would_be_cropped', 'subject_outside_center_crop', 'anchor_clamped_for_frame_fill',
    'effective_detail_below_half_output']);

  function showPicture(host, candidate, geometry) {
    host.replaceChildren();
    if (!candidate?.previewUrl) {
      host.append(element('div', 'broll-placeholder', candidate?.warning ?? 'No artwork selected for this beat.'));
      return;
    }
    const stage = element('div', 'broll-fill');
    stage.style.aspectRatio = `${review.output.width}/${review.output.height}`;
    stage.classList.toggle('broll-unsafe', Boolean(geometry?.warnings?.some(item => safetyWarnings.has(item))));
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
    const crop = displayedCrop(candidate, geometry);
    const inView = (x, y, width = 0, height = 0) => ({ x: (x - crop.x) * 1000 / crop.width,
      y: (y - crop.y) * 1000 / crop.height, width: width * 1000 / crop.width,
      height: height * 1000 / crop.height });
    const svg = document.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 1000');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-label', 'Detections, anchor, and keyframe crop');
    svg.classList.add('broll-overlay');
    for (const [type, items] of [['face', candidate.detection?.faces], ['object', candidate.detection?.objects]]) {
      for (const item of items ?? []) {
        svgShape(svg, 'rect', { ...inView(item.x, item.y, item.width, item.height),
          fill: 'none', stroke: type === 'face' ? '#f3c477' : '#dcb0f3', 'stroke-width': 3 });
      }
    }
    if (geometry?.kind === 'zoom_in') cropOutline(svg, inView(geometry.endCrop.x, geometry.endCrop.y,
      geometry.endCrop.width, geometry.endCrop.height), '#54e18a', 'Zoom-in final');
    else if (geometry?.kind === 'zoom_out') cropOutline(svg, inView(geometry.startCrop.x, geometry.startCrop.y,
      geometry.startCrop.width, geometry.startCrop.height), '#ff6c6c', 'Zoom-out initial');
    else if (geometry?.kind?.startsWith('pan_')) {
      cropOutline(svg, inView(geometry.startCrop.x, geometry.startCrop.y, geometry.startCrop.width,
        geometry.startCrop.height), '#58d8f1', 'Pan start');
      cropOutline(svg, inView(geometry.endCrop.x, geometry.endCrop.y, geometry.endCrop.width,
        geometry.endCrop.height), '#f3db77', 'Pan end');
    } else if (geometry) cropOutline(svg, inView(geometry.startCrop.x, geometry.startCrop.y,
      geometry.startCrop.width, geometry.startCrop.height), '#d6e0da', 'Static');
    if (geometry?.anchorPoint) {
      const point = inView(geometry.anchorPoint.x, geometry.anchorPoint.y);
      svgShape(svg, 'circle', { cx: point.x, cy: point.y, r: 9,
        fill: '#fff', stroke: '#000', 'stroke-width': 3 });
    }
    stage.append(svg);
    const stageLabel = element('p', 'broll-meta', `${candidate.filename} · centered full frame · ${geometry?.kind === 'zoom_in' ? 'green: final zoom-in crop' : geometry?.kind === 'zoom_out' ? 'red: initial zoom-out crop' : 'keyframe crop outlines'} · amber/purple detections · white anchor${stage.classList.contains('broll-unsafe') ? ' · outside safe margin or scale' : ''}`);
    host.append(stage, stageLabel);
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
    const mainPreview = element('div'); picture.append(mainPreview);
    const thumbnails = element('div', 'broll-thumbnails'); picture.append(thumbnails);
    const controls = element('div', 'broll-controls'); layout.append(controls);
    const kindField = field('Motion', kinds.map(kind => ({ value: kind, label: kind.replace('_', ' ') })), beat.intent?.kind ?? 'static');
    const speedField = field('Speed', [{ value: 'slow', label: 'Slow' }, { value: 'fast', label: 'Fast' }], beat.intent?.speed ?? 'slow');
    const anchorField = field('Anchor', [], beat.intent?.anchorId ?? 'center');
    controls.append(kindField.wrapper, speedField.wrapper, anchorField.wrapper);
    const save = element('button', '', 'Save this beat as an override'); save.type = 'button'; controls.append(save);
    const status = element('p', 'broll-meta'); controls.append(status);
    card.append(layout);
    let previewCounter = 0;
    let selectedImageId = beat.selectedImageId;
    const chosen = () => beat.candidates.find(item => item.imageId === selectedImageId) ?? null;
    function updateThumbnails() {
      thumbnails.replaceChildren();
      for (const candidate of [{ imageId: null, filename: 'No artwork', usable: true }, ...beat.candidates]) {
        if (candidate.imageId === selectedImageId) continue;
        const button = element('button', 'broll-thumbnail'); button.type = 'button';
        button.disabled = !candidate.usable;
        button.title = candidate.filename;
        button.setAttribute('aria-label', `Select ${candidate.filename}`);
        if (candidate.previewUrl) {
          const image = element('img'); image.src = candidate.previewUrl; image.alt = ''; image.loading = 'lazy';
          button.append(image);
        } else button.append(element('span', 'broll-thumbnail-empty', candidate.imageId ? 'Unavailable' : 'No image'));
        button.append(element('span', 'broll-thumbnail-name', candidate.filename));
        button.onclick = () => { selectedImageId = candidate.imageId; anchorField.select.value = 'center';
          updateThumbnails(); updateAnchors(); refreshPreview(); };
        thumbnails.append(button);
      }
    }
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
      if (!candidate) { showPicture(mainPreview, null, null); showWarnings(null); status.textContent = ''; save.disabled = false; return; }
      status.textContent = 'Calculating crop…';
      try {
        const payload = { beatId: beat.id,
          imageId: candidate.imageId, kind: kindField.select.value, speed: speedField.select.value,
          anchorId: anchorField.select.value };
        const request = previewQueue.catch(() => {}).then(() => window.projects.command('brollPreview', payload));
        previewQueue = request;
        const response = await request;
        if (sequence !== previewCounter) return;
        showPicture(mainPreview, candidate, response.geometry);
        showWarnings(response.geometry);
        status.textContent = response.geometry?.kind !== kindField.select.value ? 'This motion cannot fill the frame at the requested rate.' : '';
        save.disabled = !candidate.usable;
      } catch (error) {
        if (sequence !== previewCounter) return;
        showPicture(mainPreview, candidate, null); showWarnings(null); status.textContent = error.message;
        save.disabled = true;
      }
    }
    updateAnchors();
    updateThumbnails();
    for (const select of [kindField.select, speedField.select, anchorField.select]) select.onchange = refreshPreview;
    save.onclick = async () => {
      save.disabled = true; status.textContent = 'Saving this beat…';
      try {
        await previewQueue.catch(() => {});
        const result = await window.projects.command('brollOverride', { projectRevision,
          beatPlanId: review.beatPlanId, selectionId: review.selectionId, motionId: review.motionId,
          beatId: beat.id, imageId: selectedImageId,
          kind: kindField.select.value, speed: speedField.select.value, anchorId: anchorField.select.value });
        projectRevision = result.projectRevision; review = result.review;
        const scroll = $('broll-beat-list').scrollTop;
        render(); $('broll-beat-list').scrollTop = scroll;
      } catch (error) { status.textContent = error.message; save.disabled = false; }
    };
    if (chosen()?.usable && beat.geometry && beat.selectedImageId === chosen().imageId) {
      showPicture(mainPreview, chosen(), beat.geometry); showWarnings(beat.geometry);
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
  window.addEventListener('broll-motion-updated', () => {
    review = null;
    $('broll-review').classList.add('hidden');
  });
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
