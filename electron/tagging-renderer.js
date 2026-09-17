const $ = selector => document.querySelector(selector);
let state = null;
let activeRunId = null;
let refreshTimer = null;
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
  return `file://${encodeURI(path).replaceAll('#', '%23')}`;
}

function text(value) {
  return document.createTextNode(String(value));
}

function setStatus(message, error = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
}

function renderTags(values) {
  const wrapper = document.createElement('div'); wrapper.className = 'tags';
  if (!values) { wrapper.append(text('No tags yet')); return wrapper; }
  for (const [key, value] of Object.entries(values)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values.filter(Boolean)) {
      const tag = document.createElement('span');
      tag.className = `tag${key.includes('description') ? ' description' : ''}`;
      tag.textContent = `${key.replaceAll('_', ' ')}: ${item}`;
      wrapper.append(tag);
    }
  }
  return wrapper;
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
  $('#catalog-location').textContent = state.location;
  $('#image-count').textContent = state.imageCount;
  $('#review-count').textContent = state.images.filter(image => image.reviewState === 'needs_review').length;
  $('#accepted-count').textContent = state.images.filter(image => image.reviewState === 'accepted').length;
  const roots = $('#roots'); roots.replaceChildren(); roots.classList.toggle('empty', !state.roots.length);
  if (!state.roots.length) roots.append(text('No folders selected.'));
  for (const root of state.roots) { const item = document.createElement('div'); item.className = 'root'; item.textContent = root.path; roots.append(item); }

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
    const assetCell = document.createElement('td');
    const asset = document.createElement('div'); asset.className = 'asset';
    const preview = document.createElement('img'); preview.src = fileUrl(image.path); preview.alt = '';
    const names = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = image.filename;
    const dimensions = document.createElement('small'); dimensions.textContent = image.width && image.height ? `${image.width} × ${image.height}` : image.availability;
    names.append(name, dimensions); asset.append(preview, names); assetCell.append(asset);
    const tagsCell = document.createElement('td'); tagsCell.append(renderTags(image.accepted ?? image.proposal));
    const stateCell = document.createElement('td'); const badge = document.createElement('span'); badge.className = `state ${image.reviewState}`; badge.textContent = image.reviewState.replace('_', ' '); stateCell.append(badge);
    const actionCell = document.createElement('td'); const actions = document.createElement('div'); actions.className = 'row-actions';
    if (image.proposal && image.reviewState !== 'accepted') {
      const accept = document.createElement('button'); accept.className = 'accept quiet'; accept.textContent = 'Accept';
      accept.addEventListener('click', () => perform(async () => { await window.imageTagging.command('review.accept', { imageVersionId: image.versionId }); await refresh(); }, 'Accepting tags…'));
      actions.append(accept);
    }
    if (image.proposal || image.accepted) { const edit = document.createElement('button'); edit.className = 'quiet'; edit.textContent = 'Edit'; edit.addEventListener('click', () => openEditor(image)); actions.append(edit); }
    if (image.reviewState === 'accepted') { const undo = document.createElement('button'); undo.className = 'quiet'; undo.textContent = 'Undo'; undo.addEventListener('click', () => perform(async () => { await window.imageTagging.command('review.undo', { imageVersionId: image.versionId }); await refresh(); }, 'Undoing acceptance…')); actions.append(undo); }
    actionCell.append(actions);
    row.append(assetCell, tagsCell, stateCell, actionCell); body.append(row);
  }
  const running = state.runs.find(run => ['queued', 'running'].includes(run.status));
  activeRunId = running?.id ?? activeRunId;
  $('#cancel-run').hidden = !running;
  $('#start-run').disabled = Boolean(running) || !state.imageCount;
  if (running) setStatus(`Tagging ${running.completedItems} of ${running.totalItems} · ${running.failedItems} failed`);
}

async function refresh() {
  state = await window.imageTagging.command('get'); render();
}

async function perform(operation, pendingMessage) {
  setStatus(pendingMessage);
  try { await operation(); }
  catch (error) { setStatus(error.message, true); }
}

$('#open-catalog').addEventListener('click', () => perform(async () => { state = await window.imageTagging.command('catalog.open'); render(); setStatus('Catalog opened.'); }, 'Opening catalog…'));
$('#toggle-config').addEventListener('click', () => setConfigCollapsed(!document.body.classList.contains('config-collapsed')));
$('#new-catalog').addEventListener('click', () => perform(async () => { state = await window.imageTagging.command('catalog.new'); render(); setStatus('Catalog ready.'); }, 'Creating catalog…'));
$('#add-roots').addEventListener('click', () => perform(async () => { state = await window.imageTagging.command('roots.choose'); render(); setStatus('Folders added. Scan when ready.'); }, 'Choosing folders…'));
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
  clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(error => setStatus(error.message, true)), 180);
});

refresh().then(() => setStatus('Catalog ready.')).catch(error => setStatus(error.message, true));
