const $ = selector => document.querySelector(selector);
let state = null;
let activeRunId = null;
let activeDetectionRunId = null;
let refreshTimer = null;
let refreshSequence = 0;
let selectedRootIds = null;
let selectedImageIds = new Set();
let showDetectionBoxes = false;
let editingImage = null;
let editingDefinition = null;
let originalDefinition = null;

const providerPresets = Object.freeze({
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  google: { name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.6-flash' },
  'openai-compatible': { name: 'OpenAI-compatible', endpoint: '', model: '' }
});

function setConfigCollapsed(collapsed) {
  document.body.classList.toggle('config-collapsed', collapsed);
  const button = $('#toggle-config');
  button.textContent = collapsed ? 'Show setup' : 'Hide setup';
  button.setAttribute('aria-expanded', String(!collapsed));
  localStorage.setItem('mythicut.imageTagging.configCollapsed', String(collapsed));
}

setConfigCollapsed(localStorage.getItem('mythicut.imageTagging.configCollapsed') === 'true');

function fileUrl(path) {
  const normalized = String(path).replaceAll('\\', '/');
  const drive = normalized.match(/^([A-Za-z]):(?:\/(.*))?$/);
  if (drive) {
    const rest = drive[2] ? drive[2].split('/').map(encodeURIComponent).join('/') : '';
    return `file:///${drive[1]}:/${rest}`;
  }
  const unc = normalized.match(/^\/\/([^/]+)(?:\/(.*))?$/);
  if (unc) {
    const rest = unc[2] ? unc[2].split('/').map(encodeURIComponent).join('/') : '';
    return `file://${unc[1]}/${rest}`;
  }
  if (normalized.startsWith('/')) return `file://${normalized.split('/').map(encodeURIComponent).join('/')}`;
  return `file:///${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

function text(value) {
  return document.createTextNode(String(value));
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function detectionRegions(image) {
  return [
    ...(image.detection?.faces ?? []).map(region => ({ ...region, kind: 'face' })),
    ...(image.detection?.objects ?? []).map(region => ({ ...region, kind: 'object' }))
  ];
}

function renderDetectionOverlay(image) {
  const overlay = document.createElementNS(SVG_NS, 'svg');
  overlay.classList.add('detection-overlay');
  overlay.setAttribute('viewBox', '0 0 1 1');
  overlay.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  for (const region of detectionRegions(image)) {
    const group = document.createElementNS(SVG_NS, 'g'); group.classList.add(`detection-${region.kind}`);
    const box = document.createElementNS(SVG_NS, 'rect');
    box.setAttribute('x', String(region.x)); box.setAttribute('y', String(region.y));
    box.setAttribute('width', String(region.width)); box.setAttribute('height', String(region.height));
    box.classList.add('detection-box'); group.append(box);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(region.x + 0.006)); label.setAttribute('y', String(Math.max(0.035, region.y + 0.032)));
    label.setAttribute('font-size', '0.028');
    label.classList.add('detection-label'); label.textContent = region.label; group.append(label);
    overlay.append(group);
  }
  return overlay;
}

function imageStatus(image) {
  if (image.reviewState === 'accepted') return { symbol: '✓', label: 'Accepted', className: 'accepted' };
  if (image.availability !== 'present' || image.runState === 'failed') {
    const detail = image.errorMessage ? `: ${image.errorMessage}` : '';
    return { symbol: '⚠', label: `Tagging error${detail}`, className: 'error' };
  }
  return { symbol: '✎', label: image.reviewState === 'needs_review' ? 'Awaiting human review' : 'Awaiting tags', className: 'awaiting' };
}

function activeSchema() {
  return state?.schemas.find(item => item.active) ?? null;
}

function imageValues(image) {
  const schema = activeSchema();
  const source = image.reviewState === 'needs_review' && image.proposal
    ? image.proposal
    : image.accepted ?? image.proposal ?? {};
  return Object.fromEntries((schema?.definition.fields ?? []).map(field => {
    if (field.type === 'free_text') return [field.key, source[field.key] ?? null];
    const value = source[field.key];
    return [field.key, Array.isArray(value) ? [...value] : value ? [value] : []];
  }));
}

function closeTagPopover() {
  const popover = $('#tag-popover');
  popover.hidden = true;
  popover.replaceChildren();
}

document.addEventListener('click', event => {
  if (!event.target.closest('#tag-popover, .tag, .tag-add')) closeTagPopover();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeTagPopover();
});

function positionTagPopover(popover, anchor) {
  const bounds = anchor.getBoundingClientRect();
  const gap = 7;
  const left = Math.min(Math.max(12, bounds.left), window.innerWidth - popover.offsetWidth - 12);
  const top = Math.min(bounds.bottom + gap, window.innerHeight - popover.offsetHeight - 12);
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(12, top)}px`;
}

async function saveImageValues(image, values, message = 'Reviewed tags saved.') {
  closeTagPopover();
  await perform(async () => {
    await window.imageTagging.command('review.accept', { imageVersionId: image.versionId, values });
    await refresh();
    setStatus(message);
  }, 'Saving reviewed tags…');
}

async function replaceImageTag(image, field, currentKey, nextKey) {
  const values = imageValues(image);
  const selected = values[field.key].filter(value => value !== currentKey);
  if (nextKey && !selected.includes(nextKey)) selected.push(nextKey);
  values[field.key] = selected;
  await saveImageValues(image, values, `${field.label} updated.`);
}

async function addImageTagOption(image, field, currentKey, label) {
  const schema = activeSchema();
  const cleanLabel = String(label ?? '').trim();
  if (!schema || !cleanLabel) return;
  closeTagPopover();
  await perform(async () => {
    const option = await window.imageTagging.command('schema.tag.add', {
      schemaVersionId: schema.versionId,
      fieldId: field.id,
      label: cleanLabel
    });
    const values = imageValues(image);
    const selected = values[field.key].filter(value => value !== currentKey);
    if (!selected.includes(option.key)) selected.push(option.key);
    values[field.key] = selected;
    await window.imageTagging.command('review.accept', { imageVersionId: image.versionId, values });
    await refresh();
    setStatus(`${field.label} updated and “${option.label}” added to the vocabulary.`);
  }, 'Adding tag value…');
}

function openTagPopover(image, field, currentKey, anchor) {
  const popover = $('#tag-popover');
  popover.replaceChildren();
  const heading = document.createElement('strong'); heading.textContent = `Change ${field.label}`; popover.append(heading);
  const options = document.createElement('div'); options.className = 'tag-popover-options';
  for (const option of field.options) {
    const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'tag-popover-option'; choice.textContent = option.label;
    choice.disabled = option.key === currentKey;
    choice.addEventListener('click', () => replaceImageTag(image, field, currentKey, option.key));
    options.append(choice);
  }
  popover.append(options);
  const addLabel = document.createElement('label'); addLabel.textContent = 'Add a new value';
  const addRow = document.createElement('div'); addRow.className = 'tag-popover-add';
  const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'New tag value'; input.maxLength = 200;
  const add = document.createElement('button'); add.type = 'button'; add.className = 'primary'; add.textContent = 'Add';
  const submit = () => addImageTagOption(image, field, currentKey, input.value);
  add.addEventListener('click', submit);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
  addRow.append(input, add); addLabel.append(addRow); popover.append(addLabel);
  popover.hidden = false;
  positionTagPopover(popover, anchor);
  input.focus();
}

function startInlineTextEdit(image, field, container) {
  const values = imageValues(image);
  const original = values[field.key] ?? '';
  container.replaceChildren();
  container.classList.add('editing');
  const input = document.createElement('textarea'); input.value = original; input.maxLength = 4096; input.rows = 3;
  const actions = document.createElement('div'); actions.className = 'inline-edit-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'quiet'; cancel.textContent = 'Cancel';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'primary'; save.textContent = 'Save';
  cancel.addEventListener('click', () => render());
  save.addEventListener('click', async () => {
    values[field.key] = input.value.trim() || null;
    await saveImageValues(image, values, `${field.label} updated.`);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); render(); }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save.click(); }
  });
  actions.append(cancel, save); container.append(input, actions); input.focus();
}

function updateSelectionControls() {
  const count = selectedImageIds.size;
  const running = Boolean(state?.runs.some(run => ['queued', 'running'].includes(run.status)) || state?.detectionRuns?.some(run => ['queued', 'running'].includes(run.status)));
  const edit = $('#bulk-edit'); edit.disabled = count === 0 || running; edit.textContent = count ? `Edit selected (${count})` : 'Edit selected';
  const tag = $('#tag-selected'); tag.disabled = count === 0 || running; tag.textContent = count ? `Tag selected (${count})` : 'Tag selected';
  const detect = $('#detect-selected'); detect.disabled = count === 0 || running; detect.textContent = count ? `Detect selected (${count})` : 'Detect selected';
  const hasDetection = Boolean(state?.images?.some(image => detectionRegions(image).length));
  const toggle = $('#toggle-detection-boxes');
  toggle.disabled = !state?.images?.length;
  toggle.title = hasDetection ? 'Show or hide detected face and object boxes' : 'Run Detect selected to create boxes for the displayed images';
  toggle.textContent = showDetectionBoxes ? 'Hide boxes' : 'Show boxes';
  toggle.setAttribute('aria-pressed', String(showDetectionBoxes));
  const selectAll = $('#select-all');
  selectAll.disabled = !state?.images.length;
  selectAll.checked = Boolean(state?.images.length) && count === state.images.length;
  selectAll.indeterminate = count > 0 && count < (state?.images.length ?? 0);
}

function commonAndMixed(values) {
  const common = values.length ? new Set(values[0]) : new Set();
  const union = new Set();
  for (const value of values) {
    for (const item of value) union.add(item);
    for (const item of [...common]) if (!value.includes(item)) common.delete(item);
  }
  return { common, mixed: new Set([...union].filter(item => !common.has(item))) };
}

function renderBulkEditor() {
  const selected = state.images.filter(image => selectedImageIds.has(image.id));
  const schema = activeSchema();
  $('#bulk-count').textContent = `${selected.length} image${selected.length === 1 ? '' : 's'} selected`;
  const fields = $('#bulk-fields'); fields.replaceChildren();
  if (!schema || !selected.length) return;
  for (const field of schema.definition.fields) {
    const fieldset = document.createElement('fieldset'); fieldset.className = `bulk-field ${field.type}`; fieldset.dataset.fieldKey = field.key; fieldset.dataset.fieldType = field.type;
    const legend = document.createElement('legend'); legend.textContent = field.label; fieldset.append(legend);
    const values = selected.map(image => imageValues(image)[field.key]);
    if (field.type === 'tags') {
      const { common, mixed } = commonAndMixed(values);
      const choices = document.createElement('div'); choices.className = 'bulk-choices';
      for (const option of field.options) {
        const choice = document.createElement('div'); choice.className = `bulk-choice ${common.has(option.key) ? 'common' : mixed.has(option.key) ? 'mixed' : ''}`;
        const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.optionKey = option.key;
        input.checked = common.has(option.key); input.indeterminate = mixed.has(option.key); input.dataset.touched = 'false';
        choice.addEventListener('click', event => {
          if (event.target.closest('.bulk-remove')) return;
          event.preventDefault();
          const wasSelected = input.checked || input.indeterminate;
          input.checked = !wasSelected; input.indeterminate = false; input.dataset.touched = 'true';
          choice.classList.remove('common', 'mixed'); choice.classList.toggle('common', input.checked);
        });
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'bulk-remove'; remove.textContent = '×'; remove.title = `Remove ${option.label} from all selected images`;
        remove.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          input.checked = false; input.indeterminate = false; input.dataset.touched = 'true';
          choice.classList.remove('common', 'mixed');
        });
        choice.append(input, text(option.label), remove); choices.append(choice);
      }
      fieldset.append(choices);
    } else {
      const same = values.every(value => value === values[0]);
      const input = document.createElement('textarea'); input.rows = 3; input.maxLength = 4096; input.dataset.touched = 'false';
      input.value = same ? values[0] ?? '' : ''; input.placeholder = same ? `Edit ${field.label} for all selected images` : 'Mixed values — type here to replace all';
      input.className = same ? 'bulk-text common' : 'bulk-text mixed';
      input.addEventListener('input', () => { input.dataset.touched = 'true'; input.classList.remove('mixed'); input.classList.add('common'); });
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'quiet bulk-clear'; clear.textContent = 'Clear for all';
      clear.addEventListener('click', () => { input.value = ''; input.dataset.touched = 'true'; input.classList.remove('mixed'); input.classList.add('common'); input.focus(); });
      fieldset.append(input, clear);
    }
    fields.append(fieldset);
  }
}

function openBulkEditor() {
  if (!selectedImageIds.size) return;
  renderBulkEditor(); $('#bulk-dialog').showModal();
}

function renderTags(image) {
  const wrapper = document.createElement('div'); wrapper.className = 'tags';
  const schema = activeSchema();
  const values = imageValues(image);
  if (!schema) { wrapper.append(text('No active tag schema')); return wrapper; }
  for (const field of schema.definition.fields) {
    const group = document.createElement('div'); group.className = 'tag-field';
    const label = document.createElement('span'); label.className = 'tag-field-label'; label.textContent = `${field.label}:`;
    group.append(label);
    if (field.type === 'free_text') {
      const value = document.createElement('button'); value.type = 'button'; value.className = 'free-text-value';
      value.textContent = values[field.key] || 'Add description';
      value.title = `Edit ${field.label}`;
      value.addEventListener('click', () => startInlineTextEdit(image, field, group));
      group.append(value);
    } else {
      const selected = values[field.key];
      for (const key of selected) {
        const option = field.options.find(item => item.key === key);
        const tag = document.createElement('button'); tag.type = 'button'; tag.className = 'tag'; tag.title = `Change ${field.label}`;
        tag.append(text(option?.label ?? key));
        const remove = document.createElement('span'); remove.className = 'tag-remove'; remove.setAttribute('aria-hidden', 'true'); remove.textContent = '×';
        tag.append(remove);
        tag.addEventListener('click', event => {
          if (event.target === remove) {
            event.stopPropagation();
            replaceImageTag(image, field, key, null);
            return;
          }
          openTagPopover(image, field, key, tag);
        });
        group.append(tag);
      }
      const add = document.createElement('button'); add.type = 'button'; add.className = 'tag-add'; add.textContent = '+ tag'; add.title = `Add ${field.label}`;
      add.addEventListener('click', () => openTagPopover(image, field, null, add)); group.append(add);
    }
    wrapper.append(group);
  }
  return wrapper;
}

function setStatus(message, error = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
}

function openEditor(image) {
  const schema = state.schemas.find(item => item.active);
  if (!schema) return;
  editingImage = image;
  $('#review-title').textContent = image.filename;
  const values = image.accepted ?? image.proposal ?? {};
  const fields = $('#review-fields'); fields.replaceChildren();
  for (const field of schema.definition.fields) {
    const wrapper = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = field.label; wrapper.append(legend);
    if (field.type === 'free_text') {
      const input = document.createElement('textarea'); input.name = field.key; input.value = values[field.key] ?? ''; wrapper.append(input);
    } else {
      const choices = document.createElement('div'); choices.className = 'choices';
      for (const option of field.options) {
        const label = document.createElement('label'); label.className = 'choice';
        const input = document.createElement('input'); input.type = 'checkbox'; input.name = field.key; input.value = option.key; input.checked = (values[field.key] ?? []).includes(option.key);
        label.append(input, text(option.label)); choices.append(label);
      }
      wrapper.append(choices);
    }
    fields.append(wrapper);
  }
  $('#review-dialog').showModal();
}

function editorValues() {
  const schema = state.schemas.find(item => item.active);
  const data = new FormData($('#review-form')); const values = {};
  for (const field of schema.definition.fields) {
    if (field.type === 'tags') values[field.key] = data.getAll(field.key);
    else if (field.type === 'free_text') values[field.key] = String(data.get(field.key) ?? '').trim() || null;
    else values[field.key] = data.get(field.key) || null;
  }
  return values;
}

function syncSchemaEditor() {
  if (!editingDefinition || !document.querySelector('.schema-row')) return;
  editingDefinition = collectSchemaDefinition();
}

function addOptionToField(field, rawValue) {
  const labels = String(rawValue).split(',').map(value => value.trim()).filter(Boolean);
  const existing = new Set(field.options.map(option => option.label.toLocaleLowerCase()));
  for (const label of labels) {
    if (existing.has(label.toLocaleLowerCase())) continue;
    field.options.push({ id: crypto.randomUUID(), label });
    existing.add(label.toLocaleLowerCase());
  }
}

function renderSchemaEditor() {
  const container = $('#schema-fields'); container.replaceChildren();
  editingDefinition.fields.forEach((field, index) => {
    const row = document.createElement('div'); row.className = `schema-row ${field.type}`; row.dataset.id = field.id;
    const control = (caption, name, value) => { const label = document.createElement('label'); label.append(text(caption)); const input = document.createElement('input'); input.name = name; input.value = value; label.append(input); return label; };
    const label = control('Label', 'label', field.label);
    const typeLabel = document.createElement('label'); typeLabel.className = 'free-text-toggle'; const freeText = document.createElement('input'); freeText.type = 'checkbox'; freeText.name = 'freeText'; freeText.checked = field.type === 'free_text';
    freeText.addEventListener('change', () => { editingDefinition = collectSchemaDefinition(); renderSchemaEditor(); }); typeLabel.append(freeText, text('Free text'));
    const options = document.createElement('label'); options.className = 'options-control'; options.append(text('Category and Tags'));
    const chipEditor = document.createElement('div'); chipEditor.className = 'chip-editor';
    const chips = document.createElement('div'); chips.className = 'option-chips';
    for (const option of field.options) {
      const chip = document.createElement('span'); chip.className = 'option-chip'; chip.dataset.optionId = option.id; chip.dataset.label = option.label;
      const chipLabel = document.createElement('span'); chipLabel.textContent = option.label;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'chip-remove'; remove.setAttribute('aria-label', `Remove ${option.label}`); remove.textContent = '×';
      remove.addEventListener('click', () => { syncSchemaEditor(); const current = editingDefinition.fields.find(item => item.id === row.dataset.id); current.options = current.options.filter(item => item.id !== option.id); renderSchemaEditor(); });
      chip.append(chipLabel, remove); chips.append(chip);
    }
    const optionInput = document.createElement('input'); optionInput.type = 'text'; optionInput.name = 'optionInput'; optionInput.placeholder = 'Type a tag, then press comma or Enter';
    optionInput.addEventListener('keydown', event => {
      if (event.key !== ',' && event.key !== 'Enter') return;
      event.preventDefault(); syncSchemaEditor(); const current = editingDefinition.fields.find(item => item.id === row.dataset.id); addOptionToField(current, optionInput.value); renderSchemaEditor();
      document.querySelector(`.schema-row[data-id="${CSS.escape(row.dataset.id)}"] [name="optionInput"]`)?.focus();
    });
    optionInput.addEventListener('blur', () => { if (!optionInput.value.trim()) return; syncSchemaEditor(); const current = editingDefinition.fields.find(item => item.id === row.dataset.id); addOptionToField(current, optionInput.value); renderSchemaEditor(); });
    chipEditor.append(chips, optionInput); options.append(chipEditor);
    const actions = document.createElement('div'); actions.className = 'field-actions';
    const up = document.createElement('button'); up.type = 'button'; up.className = 'quiet'; up.textContent = '↑'; up.disabled = index === 0; up.addEventListener('click', () => { editingDefinition = collectSchemaDefinition(); [editingDefinition.fields[index - 1], editingDefinition.fields[index]] = [editingDefinition.fields[index], editingDefinition.fields[index - 1]]; renderSchemaEditor(); });
    const down = document.createElement('button'); down.type = 'button'; down.className = 'quiet'; down.textContent = '↓'; down.disabled = index === editingDefinition.fields.length - 1; down.addEventListener('click', () => { editingDefinition = collectSchemaDefinition(); [editingDefinition.fields[index + 1], editingDefinition.fields[index]] = [editingDefinition.fields[index], editingDefinition.fields[index + 1]]; renderSchemaEditor(); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = '×'; remove.disabled = editingDefinition.fields.length === 1; remove.addEventListener('click', () => { editingDefinition = collectSchemaDefinition(); editingDefinition.fields.splice(index, 1); renderSchemaEditor(); });
    actions.append(up, down, remove); row.append(label, typeLabel, options, actions); container.append(row);
  });
}

function openSchemaEditor() {
  const schema = state.schemas.find(item => item.active);
  if (!schema) return;
  editingDefinition = structuredClone(schema.definition);
  originalDefinition = structuredClone(schema.definition);
  renderSchemaEditor(); $('#schema-dialog').showModal();
}

function collectSchemaDefinition() {
  const oldFields = new Map(editingDefinition.fields.map(field => [field.id, field]));
  const fields = [...document.querySelectorAll('.schema-row')].map(row => {
    const previous = oldFields.get(row.dataset.id); const type = row.querySelector('[name="freeText"]').checked ? 'free_text' : 'tags';
    const options = type === 'free_text' ? [] : [...row.querySelectorAll('.option-chip')].map(chip => ({ id: chip.dataset.optionId, label: chip.dataset.label }));
    return { id: row.dataset.id, label: row.querySelector('[name="label"]').value.trim(), type, options, includeInRetrievalText: previous?.includeInRetrievalText ?? true };
  });
  return { schemaVersion: 1, fields };
}

function render() {
  if (!state) return;
  closeTagPopover();
  const visibleIds = new Set(state.images.map(image => image.id));
  selectedImageIds = new Set([...selectedImageIds].filter(id => visibleIds.has(id)));
  $('#catalog-location').textContent = state.location;
  $('#image-count').textContent = state.imageCount;
  $('#review-count').textContent = state.images.filter(image => image.reviewState === 'needs_review').length;
  $('#accepted-count').textContent = state.images.filter(image => image.reviewState === 'accepted').length;
  const roots = $('#roots'); roots.replaceChildren(); roots.classList.toggle('empty', !state.roots.length);
  if (!state.roots.length) roots.append(text('No folders selected.'));
  if (selectedRootIds === null) selectedRootIds = new Set(state.roots.map(root => root.id));
  else selectedRootIds = new Set([...selectedRootIds].filter(id => state.roots.some(root => root.id === id)));
  for (const root of state.roots) {
    const item = document.createElement('div'); item.className = 'root';
    const location = document.createElement('label'); location.className = 'root-filter';
    const select = document.createElement('input'); select.type = 'checkbox'; select.checked = selectedRootIds.has(root.id); select.setAttribute('aria-label', `Display ${root.path} and subfolders`);
    select.addEventListener('change', () => {
      if (select.checked) selectedRootIds.add(root.id); else selectedRootIds.delete(root.id);
      refresh().catch(error => setStatus(error.message, true));
    });
    location.append(select, text(root.path));
    const relocate = document.createElement('button'); relocate.type = 'button'; relocate.className = 'quiet'; relocate.textContent = 'Relocate';
    relocate.addEventListener('click', () => perform(async () => {
      await window.imageTagging.command('roots.relocate', { rootId: root.id }); await refresh(); setStatus('Image folder reconnected.');
    }, 'Finding the image folder…'));
    item.append(location, relocate); roots.append(item);
  }

  const provider = state.providers.find(item => item.id === state.catalog.activeProviderProfileId) ?? state.providers[0];
  if (provider) {
    const form = $('#provider-form');
    for (const key of ['name', 'dialect', 'endpoint', 'model']) form.elements[key].value = provider[key];
    form.elements.imagePreset.value = provider.settings.imagePreset;
    form.dataset.id = provider.id;
    $('#credential-state').textContent = provider.hasCredential ? 'Key saved' : 'Key needed';
    $('#credential-state').classList.toggle('ready', provider.hasCredential);
  }
  const schema = state.schemas.find(item => item.active);
  const schemaSummary = $('#schema-summary'); schemaSummary.replaceChildren();
  for (const field of schema?.definition.fields ?? []) {
    const item = document.createElement('div'); item.className = 'schema-field';
    const type = document.createElement('em'); type.textContent = field.type.replace('_', ' ');
    item.append(text(field.label), type); schemaSummary.append(item);
  }

  const body = $('#images'); body.replaceChildren();
  for (const image of state.images) {
    const row = document.createElement('tr');
    const selectCell = document.createElement('td'); selectCell.className = 'select-cell';
    const select = document.createElement('input'); select.type = 'checkbox'; select.checked = selectedImageIds.has(image.id); select.setAttribute('aria-label', `Select ${image.filename}`);
    select.addEventListener('change', () => { if (select.checked) selectedImageIds.add(image.id); else selectedImageIds.delete(image.id); updateSelectionControls(); });
    selectCell.append(select);
    const assetCell = document.createElement('td');
    const asset = document.createElement('div'); asset.className = 'asset';
    const indicator = imageStatus(image);
    const statusIcon = document.createElement('span'); statusIcon.className = `asset-status ${indicator.className}`; statusIcon.textContent = indicator.symbol; statusIcon.title = indicator.label; statusIcon.setAttribute('aria-label', indicator.label); statusIcon.setAttribute('role', 'img');
    const preview = document.createElement('img'); preview.src = fileUrl(image.path); preview.alt = '';
    const previewFrame = document.createElement('div'); previewFrame.className = 'preview-frame'; previewFrame.append(preview);
    if (showDetectionBoxes && detectionRegions(image).length) previewFrame.append(renderDetectionOverlay(image));
    const content = document.createElement('div'); content.className = 'asset-content';
    const names = document.createElement('div'); names.className = 'asset-meta';
    const name = document.createElement('strong'); name.textContent = image.filename;
    const dimensions = document.createElement('small'); dimensions.textContent = image.width && image.height ? `${image.width} × ${image.height}` : image.availability;
    names.append(name, dimensions); content.append(previewFrame, names); asset.append(statusIcon, content); assetCell.append(asset);
    const tagsCell = document.createElement('td'); tagsCell.append(renderTags(image));
    const actionCell = document.createElement('td'); actionCell.className = 'action-cell'; const actions = document.createElement('div'); actions.className = 'row-actions';
    if (image.proposal && image.reviewState !== 'accepted') {
      const accept = document.createElement('button'); accept.className = 'accept quiet'; accept.textContent = 'Accept';
      accept.addEventListener('click', () => perform(async () => { await window.imageTagging.command('review.accept', { imageVersionId: image.versionId }); await refresh(); }, 'Accepting tags…'));
      actions.append(accept);
    }
    if (image.proposal || image.accepted) { const edit = document.createElement('button'); edit.className = 'quiet'; edit.textContent = 'Edit'; edit.addEventListener('click', () => openEditor(image)); actions.append(edit); }
    if (image.reviewState === 'accepted') { const undo = document.createElement('button'); undo.className = 'quiet'; undo.textContent = 'Undo'; undo.addEventListener('click', () => perform(async () => { await window.imageTagging.command('review.undo', { imageVersionId: image.versionId }); await refresh(); }, 'Undoing acceptance…')); actions.append(undo); }
    actionCell.append(actions);
    row.append(selectCell, assetCell, tagsCell, actionCell); body.append(row);
  }
  updateSelectionControls();
  const running = state.runs.find(run => ['queued', 'running'].includes(run.status));
  const detectionRunning = state.detectionRuns?.find(run => ['queued', 'running'].includes(run.status));
  activeRunId = running?.id ?? activeRunId;
  activeDetectionRunId = detectionRunning?.id ?? activeDetectionRunId;
  $('#cancel-run').hidden = !running;
  $('#cancel-detection').hidden = !detectionRunning;
  $('#start-run').disabled = Boolean(running || detectionRunning) || !state.imageCount;
  if (running) setStatus(`Tagging ${running.completedItems} of ${running.totalItems} · ${running.failedItems} failed`);
  else if (detectionRunning) setStatus(`Detecting ${detectionRunning.completedItems} of ${detectionRunning.totalItems} · ${detectionRunning.failedItems} failed`);
}

async function refresh() {
  const sequence = ++refreshSequence;
  const next = await window.imageTagging.command('get', { rootIds: selectedRootIds === null ? null : [...selectedRootIds] });
  if (sequence !== refreshSequence) return;
  state = next; render();
}

async function perform(operation, pendingMessage) {
  setStatus(pendingMessage);
  try { await operation(); }
  catch (error) { setStatus(error.message, true); }
}

$('#select-all').addEventListener('change', event => {
  selectedImageIds = event.target.checked ? new Set(state.images.map(image => image.id)) : new Set();
  render();
});
$('#bulk-edit').addEventListener('click', openBulkEditor);
$('#toggle-detection-boxes').addEventListener('click', () => {
  if (!state?.images?.some(image => detectionRegions(image).length)) {
    setStatus('No detection boxes are available for the displayed images. Run Detect selected first.');
    return;
  }
  showDetectionBoxes = !showDetectionBoxes;
  render();
});
$('#detect-selected').addEventListener('click', () => perform(async () => {
  const imageVersionIds = state.images.filter(image => selectedImageIds.has(image.id)).map(image => image.versionId);
  const result = await window.imageTagging.command('detection.start', { imageVersionIds });
  activeDetectionRunId = result.runId; await refresh(); setStatus(`Queued ${result.totalItems} image${result.totalItems === 1 ? '' : 's'} for face and object detection.`);
}, 'Starting object detection…'));
$('#tag-selected').addEventListener('click', () => perform(async () => {
  const imageVersionIds = state.images.filter(image => selectedImageIds.has(image.id)).map(image => image.versionId);
  const result = await window.imageTagging.command('run.start', { selectionPolicy: 'force_all', imageVersionIds });
  activeRunId = result.runId; await refresh(); setStatus(`Queued ${result.totalItems} selected image${result.totalItems === 1 ? '' : 's'} for tagging.`);
}, 'Starting selected tagging…'));
$('#close-bulk').addEventListener('click', () => $('#bulk-dialog').close());
$('#cancel-bulk').addEventListener('click', () => $('#bulk-dialog').close());
$('#bulk-form').addEventListener('submit', event => {
  event.preventDefault();
  const changes = {};
  for (const field of document.querySelectorAll('.bulk-field')) {
    if (field.dataset.fieldType === 'tags') {
      const add = []; const remove = [];
      for (const input of field.querySelectorAll('input[data-option-key]')) {
        if (input.dataset.touched !== 'true') continue;
        (input.checked ? add : remove).push(input.dataset.optionKey);
      }
      if (add.length || remove.length) changes[field.dataset.fieldKey] = { add, remove };
    } else {
      const input = field.querySelector('textarea');
      if (input?.dataset.touched === 'true') changes[field.dataset.fieldKey] = { set: input.value.trim() || null };
    }
  }
  if (!Object.keys(changes).length) { $('#bulk-dialog').close(); setStatus('No group changes made.'); return; }
  const imageVersionIds = state.images.filter(image => selectedImageIds.has(image.id)).map(image => image.versionId);
  perform(async () => {
    const result = await window.imageTagging.command('review.bulk.accept', { imageVersionIds, changes });
    $('#bulk-dialog').close(); selectedImageIds.clear(); await refresh(); setStatus(`Saved group changes for ${result.count} image${result.count === 1 ? '' : 's'}.`);
  }, 'Saving group changes…');
});

$('#open-catalog').addEventListener('click', () => perform(async () => { state = await window.imageTagging.command('catalog.open'); selectedRootIds = null; render(); setStatus('Catalog opened.'); }, 'Opening catalog…'));
$('#save-catalog-as').addEventListener('click', () => perform(async () => { await window.imageTagging.command('catalog.saveAs'); await refresh(); setStatus('Catalog saved and now in use.'); }, 'Saving catalog…'));
$('#toggle-config').addEventListener('click', () => setConfigCollapsed(!document.body.classList.contains('config-collapsed')));
$('#new-catalog').addEventListener('click', () => perform(async () => { state = await window.imageTagging.command('catalog.new'); selectedRootIds = null; render(); setStatus('Catalog ready.'); }, 'Creating catalog…'));
$('#add-roots').addEventListener('click', () => perform(async () => { await window.imageTagging.command('roots.choose'); selectedRootIds = null; await refresh(); setStatus('Folders added. Scan when ready.'); }, 'Choosing folders…'));
$('#scan').addEventListener('click', () => perform(async () => { await window.imageTagging.command('roots.scan'); await refresh(); setStatus(`Scan complete · ${state.imageCount} images.`); }, 'Scanning folders…'));
$('#provider-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget; const values = Object.fromEntries(new FormData(form));
  if (values.dialect === 'google' && values.model && !['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'].includes(values.model.trim())) {
    setStatus('Google model names are version-specific; use a stable value such as gemini-3.6-flash.', true);
    return;
  }
  perform(async () => {
    await window.imageTagging.command('provider.save', { id: form.dataset.id, name: values.name, dialect: values.dialect, endpoint: values.endpoint, model: values.model, apiKey: values.apiKey, settings: { imagePreset: values.imagePreset, timeoutMs: 60000, extraInstructions: '' } });
    form.elements.apiKey.value = ''; await refresh(); setStatus('Provider settings saved securely.');
  }, 'Saving provider…');
});
$('#provider-form').elements.dialect.addEventListener('change', event => {
  const form = event.currentTarget.form;
  const preset = providerPresets[event.currentTarget.value];
  const knownNames = new Set(Object.values(providerPresets).map(item => item.name));
  const knownEndpoints = new Set(Object.values(providerPresets).map(item => item.endpoint).filter(Boolean));
  const knownModels = new Set(Object.values(providerPresets).map(item => item.model).filter(Boolean));
  if (!form.elements.name.value.trim() || knownNames.has(form.elements.name.value.trim())) form.elements.name.value = preset.name;
  if (!form.elements.endpoint.value.trim() || knownEndpoints.has(form.elements.endpoint.value.trim())) form.elements.endpoint.value = preset.endpoint;
  if (!form.elements.model.value.trim() || knownModels.has(form.elements.model.value.trim())) form.elements.model.value = preset.model;
});
$('#start-run').addEventListener('click', () => perform(async () => {
  const result = await window.imageTagging.command('run.start', { selectionPolicy: $('#selection-policy').value });
  activeRunId = result.runId; setStatus(result.totalItems ? `Queued ${result.totalItems} images.` : 'No images match this run.'); await refresh();
}, 'Starting tag run…'));
$('#cancel-run').addEventListener('click', () => perform(async () => { await window.imageTagging.command('run.cancel', { runId: activeRunId }); setStatus('Cancel requested…'); }, 'Canceling run…'));
$('#cancel-detection').addEventListener('click', () => perform(async () => { await window.imageTagging.command('detection.cancel', { runId: activeDetectionRunId }); setStatus('Detection cancel requested…'); }, 'Canceling detection…'));
$('#close-review').addEventListener('click', () => $('#review-dialog').close());
$('#cancel-review').addEventListener('click', () => $('#review-dialog').close());
$('#review-form').addEventListener('submit', event => {
  event.preventDefault();
  perform(async () => {
    await window.imageTagging.command('review.accept', { imageVersionId: editingImage.versionId, values: editorValues() });
    $('#review-dialog').close(); await refresh(); setStatus('Edited tags accepted.');
  }, 'Saving reviewed tags…');
});
$('#edit-schema').addEventListener('click', openSchemaEditor);
$('#close-schema').addEventListener('click', () => $('#schema-dialog').close());
$('#cancel-schema').addEventListener('click', () => $('#schema-dialog').close());
$('#add-field').addEventListener('click', () => {
  editingDefinition = collectSchemaDefinition();
  editingDefinition.fields.push({ id: crypto.randomUUID(), label: 'New Field', type: 'free_text', options: [], includeInRetrievalText: true });
  renderSchemaEditor();
});
$('#schema-form').addEventListener('submit', event => {
  event.preventDefault();
  perform(async () => {
    const schema = state.schemas.find(item => item.active);
    const definition = collectSchemaDefinition();
    const structureChanged = definition.fields.some((field, index) => {
      const original = originalDefinition.fields[index];
      return !original || field.id !== original.id || field.label !== original.label || field.type !== original.type;
    }) || definition.fields.length !== originalDefinition.fields.length;
    const removals = originalDefinition.fields.some(original => {
      const current = definition.fields.find(field => field.id === original.id);
      return current && original.options.some(option => !current.options.some(candidate => candidate.label.toLocaleLowerCase() === option.label.toLocaleLowerCase()));
    });
    if (!structureChanged && !removals) {
      let added = 0;
      for (const field of definition.fields) {
        const original = originalDefinition.fields.find(candidate => candidate.id === field.id);
        const known = new Set(original.options.map(option => option.label.toLocaleLowerCase()));
        for (const option of field.options) if (!known.has(option.label.toLocaleLowerCase())) {
          await window.imageTagging.command('schema.tag.add', { schemaVersionId: schema.versionId, fieldId: field.id, label: option.label }); added++;
        }
      }
      $('#schema-dialog').close(); await refresh(); setStatus(added ? `${added} tag value${added === 1 ? '' : 's'} added.` : 'No schema changes.'); return;
    }
    const draft = await window.imageTagging.command('schema.saveDraft', { schemaId: schema.id, definition });
    await window.imageTagging.command('schema.publish', { schemaVersionId: draft.versionId });
    $('#schema-dialog').close(); await refresh(); setStatus('New schema version published.');
  }, 'Publishing schema…');
});

window.imageTagging.onEvent(event => {
  if (event.type === 'scan.progress') setStatus(event.stage === 'scan.complete' ? `Scan complete · ${event.visited} visited.` : `Scanning · ${event.completed ?? event.visited ?? 0}${event.total ? ` of ${event.total}` : ''}`);
  if (event.type === 'run.progress') setStatus(`Tagging ${event.completed_items ?? event.completedItems ?? 0} of ${event.total_items ?? event.totalItems ?? 0} · ${event.failed_items ?? event.failedItems ?? 0} failed`);
  if (event.type === 'run.complete') setStatus(`Tag run ${event.status}${event.failedItems ? ` · ${event.failedItems} failed` : ''}.`);
  if (event.type === 'detection.progress') setStatus(`Detecting ${event.completed_items ?? event.completedItems ?? 0} of ${event.total_items ?? event.totalItems ?? 0} · ${event.failed_items ?? event.failedItems ?? 0} failed`);
  if (event.type === 'detection.complete') setStatus(`Object detection ${event.status}${event.failedItems ? ` · ${event.failedItems} failed` : ''}.`);
  clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(error => setStatus(error.message, true)), 180);
});

refresh().then(() => {
  if (state.unavailableLocation) setStatus(`The last catalog is unavailable: ${state.unavailableLocation}. Open it after connecting the drive, or choose another catalog.`, true);
  else setStatus('Catalog ready.');
}).catch(error => setStatus(error.message, true));
