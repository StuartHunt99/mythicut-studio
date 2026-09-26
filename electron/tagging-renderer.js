const $ = selector => document.querySelector(selector);
let state = null;
let activeRunId = null;
let activeDetectionRunId = null;
let activeEmbeddingRunId = null;
let refreshTimer = null;
let refreshSequence = 0;
let selectedRootIds = null;
let selectedImageIds = new Set();
let viewInactive = false;
let showDetectionBoxes = false;
let previewingImage = null;
let editingImage = null;
let editingDefinition = null;
let originalDefinition = null;
let lastSelectionPacket = null;
let quickReviewImageIds = [];
let quickReviewIndex = 0;
let quickReviewFieldKey = null;
let quickReviewSelectedTagKey = null;
let quickReviewAddFieldKey = null;
let quickReviewAddSelected = new Set();
let quickReviewSaving = false;
const QUICK_REVIEW_KEY_DEFAULTS = Object.freeze({ previous: 'ArrowLeft', next: 'ArrowRight', approve: 'Enter', edit: 'e', add: '+', remove: 'Backspace' });
const QUICK_REVIEW_KEY_STORAGE = 'mythicut.tag.quickReviewKeys.v1';
let quickReviewKeys = loadQuickReviewKeys();

function loadQuickReviewKeys() {
  try { return { ...QUICK_REVIEW_KEY_DEFAULTS, ...JSON.parse(localStorage.getItem(QUICK_REVIEW_KEY_STORAGE) ?? '{}') }; }
  catch { return { ...QUICK_REVIEW_KEY_DEFAULTS }; }
}

const providerPresets = Object.freeze({
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  google: { name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.6-flash' },
  'openai-compatible': { name: 'OpenAI-compatible', endpoint: '', model: '' }
});

function setConfigCollapsed(collapsed) {
  document.body.classList.toggle('config-collapsed', collapsed);
  const button = $('#toggle-config');
  const label = collapsed ? 'Open configuration' : 'Close configuration';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.setAttribute('aria-expanded', String(!collapsed));
  const dialog = $('#tag-configuration-dialog');
  if (collapsed && dialog.open) dialog.close();
  if (!collapsed && !dialog.open) dialog.showModal();
}

const tagProviderSection = $('#provider-form').closest('section');
const tagSchemaSection = $('#edit-schema').closest('section');
const quickReviewKeyConfig = $('#quick-review-key-config');
$('#tag-configuration-content').append(tagProviderSection, tagSchemaSection, quickReviewKeyConfig);
function showTagConfiguration(category) {
  document.querySelectorAll('[data-tag-config]').forEach(button => button.classList.toggle('active', button.dataset.tagConfig === category));
  tagProviderSection.hidden = !['provider', 'prompts'].includes(category);
  tagSchemaSection.hidden = category !== 'schema';
  quickReviewKeyConfig.hidden = category !== 'quick-review';
  tagProviderSection.classList.toggle('prompts-only', category === 'prompts');
  $('#provider-prompts').open = category === 'prompts';
  if (category === 'quick-review') renderQuickReviewKeyConfig();
  $('#tag-configuration-content').scrollTop = 0;
}
document.querySelectorAll('[data-tag-config]').forEach(button => button.onclick = () => showTagConfiguration(button.dataset.tagConfig));
$('#close-tag-configuration').onclick = () => setConfigCollapsed(true);
$('#tag-configuration-dialog').addEventListener('close', () => setConfigCollapsed(true));
document.querySelectorAll('[data-studio-tab]').forEach(button => button.onclick = () => window.studio.selectTab(button.dataset.studioTab).catch(error => setStatus(error.message)));
showTagConfiguration('provider');
setConfigCollapsed(true);

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
  const sourceWidth = Number(image.width) > 0 ? Number(image.width) : 1000;
  const sourceHeight = Number(image.height) > 0 ? Number(image.height) : 1000;
  const labelSize = Math.max(16, Math.min(sourceWidth, sourceHeight) * 0.04);
  const overlay = document.createElementNS(SVG_NS, 'svg');
  overlay.classList.add('detection-overlay');
  overlay.setAttribute('viewBox', `0 0 ${sourceWidth} ${sourceHeight}`);
  overlay.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  overlay.setAttribute('aria-hidden', 'true');
  for (const region of detectionRegions(image)) {
    const x = region.x * sourceWidth;
    const y = region.y * sourceHeight;
    const width = region.width * sourceWidth;
    const height = region.height * sourceHeight;
    const color = region.kind === 'face' ? '#65c68a' : '#d8aa55';
    const group = document.createElementNS(SVG_NS, 'g'); group.classList.add(`detection-${region.kind}`);
    const box = document.createElementNS(SVG_NS, 'rect');
    box.setAttribute('x', String(x)); box.setAttribute('y', String(y));
    box.setAttribute('width', String(width)); box.setAttribute('height', String(height));
    box.setAttribute('fill', color);
    box.setAttribute('fill-opacity', '0.08');
    box.setAttribute('stroke', color);
    box.setAttribute('stroke-width', '2.5');
    box.setAttribute('stroke-opacity', '1');
    box.setAttribute('stroke-linejoin', 'round');
    box.setAttribute('vector-effect', 'non-scaling-stroke');
    box.classList.add('detection-box'); group.append(box);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(x + labelSize * 0.22));
    label.setAttribute('y', String(Math.max(labelSize, y + labelSize)));
    label.setAttribute('font-size', String(labelSize));
    label.setAttribute('stroke-width', String(labelSize * 0.16));
    label.classList.add('detection-label'); label.textContent = region.label; group.append(label);
    overlay.append(group);
  }
  return overlay;
}

function renderImagePreview() {
  if (!previewingImage) return;
  const image = previewingImage;
  $('#image-preview-title').textContent = image.filename;
  $('#image-preview-meta').textContent = image.width && image.height ? `${image.width} × ${image.height}` : image.availability;
  const frame = $('#image-preview-frame');
  const preview = document.createElement('img'); preview.src = fileUrl(image.path); preview.alt = image.filename;
  frame.replaceChildren(preview);
  const regions = detectionRegions(image);
  if (showDetectionBoxes && regions.length) frame.append(renderDetectionOverlay(image));
  const toggle = $('#preview-toggle-boxes');
  toggle.disabled = !regions.length;
  toggle.textContent = showDetectionBoxes ? 'Hide boxes' : 'Show boxes';
  toggle.setAttribute('aria-pressed', String(showDetectionBoxes));
  toggle.title = regions.length ? 'Show or hide detected face and object boxes' : 'No detection boxes are available for this image';
}

function openImagePreview(image) {
  closeTagPopover();
  previewingImage = image;
  renderImagePreview();
  const dialog = $('#image-preview-dialog');
  if (!dialog.open) dialog.showModal();
}

function toggleDetectionBoxes() {
  if (!state?.images?.some(image => detectionRegions(image).length) && !detectionRegions(previewingImage ?? {}).length) {
    setStatus('No detection boxes are available for the displayed images. Run Detect selected first.');
    return;
  }
  showDetectionBoxes = !showDetectionBoxes;
  render();
  if ($('#image-preview-dialog').open) renderImagePreview();
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
  if (!$('#quick-review-dialog').open || $('#quick-review-add-dialog').open || event.target.closest?.('.quick-review-key-capture')) return;
  if (event.target.matches?.('input, textarea, select, [contenteditable="true"]')) return;
  const fields = activeSchema()?.definition.fields.filter(field => field.type === 'tags') ?? [];
  const match = key => String(quickReviewKeys[key] ?? defaultQuickReviewKey(key, fields)).toLocaleLowerCase() === event.key.toLocaleLowerCase();
  if (match('previous')) { event.preventDefault(); moveQuickReview(-1); return; }
  if (match('next')) { event.preventDefault(); moveQuickReview(1); return; }
  if (match('approve')) {
    if (event.key === 'Enter' && event.target.closest?.('button') && event.target.id !== 'quick-review-accept') return;
    event.preventDefault(); approveQuickReview(); return;
  }
  if (match('edit')) { event.preventDefault(); focusQuickReviewEditor(); return; }
  if (match('add')) { event.preventDefault(); focusQuickReviewAdd(); return; }
  if (match('remove')) { event.preventDefault(); removeQuickReviewTag(); return; }
  const category = fields.find((field, index) => match(`category_${field.key}`) || (!quickReviewKeys[`category_${field.key}`] && index < 9 && String(index + 1).toLocaleLowerCase() === event.key.toLocaleLowerCase()));
  if (category) { event.preventDefault(); focusQuickReviewCategory(category.key); }
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
  for (const option of field.options.filter(item => !item.archived)) {
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

const ACTION_LABELS = Object.freeze({ tag: 'Tag', detect: 'Detect', edit: 'Edit' });

function hasTagValues(values) {
  if (!values || typeof values !== 'object') return false;
  return Object.values(values).some(value => Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? Boolean(value.trim()) : value != null);
}

function actionTargets(action, scope) {
  const images = state?.images ?? [];
  if (scope === 'selected') return images.filter(image => selectedImageIds.has(image.id));
  if (scope === 'all') return images;
  return images.filter(image => {
    if (scope === 'failed') return action === 'detect' ? image.detectionRunState === 'failed' : image.runState === 'failed';
    if (action === 'detect') {
      const hasDetection = detectionRegions(image).length > 0;
      return scope === 'empty' ? !hasDetection : !hasDetection && image.detectionRunState !== 'failed';
    }
    const hasTags = hasTagValues(image.accepted) || hasTagValues(image.proposal);
    if (scope === 'empty') return !hasTags;
    return !hasTags && image.runState !== 'failed';
  });
}

function selectedAction() {
  const [action, scope] = $('#action-selector').value.split(':');
  return { action, scope };
}

function updateSelectionControls() {
  const { action, scope } = selectedAction();
  const count = actionTargets(action, scope).length;
  const selectedCount = selectedImageIds.size;
  const running = Boolean(state?.runs.some(run => ['queued', 'running'].includes(run.status)) || state?.detectionRuns?.some(run => ['queued', 'running'].includes(run.status)) || state?.embeddingRuns?.some(run => ['queued', 'running'].includes(run.status)));
  const run = $('#run-action');
  run.disabled = viewInactive || count === 0 || running;
  run.textContent = `${ACTION_LABELS[action]}${count ? ` (${count})` : ''}`;
  run.title = running ? 'Finish or cancel the active run first' : count === 0 ? 'No images match this action' : `${ACTION_LABELS[action]} ${count} image${count === 1 ? '' : 's'}`;
  const hasDetection = Boolean(state?.images?.some(image => detectionRegions(image).length));
  const toggle = $('#toggle-detection-boxes');
  toggle.disabled = !state?.images?.length;
  toggle.title = hasDetection ? (showDetectionBoxes ? 'Hide detection boxes' : 'Show detection boxes') : 'Run Detect to create boxes for the displayed images';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-pressed', String(showDetectionBoxes));
  const selectAll = $('#select-all');
  selectAll.disabled = !state?.images.length;
  selectAll.checked = Boolean(state?.images.length) && selectedCount === state.images.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < (state?.images.length ?? 0);
  const setActive = $('#set-selected-active');
  setActive.disabled = selectedCount === 0 || running;
  setActive.textContent = viewInactive ? `Reactivate selected${selectedCount ? ` (${selectedCount})` : ''}` : `Deactivate selected${selectedCount ? ` (${selectedCount})` : ''}`;
  const selectedProposals = (state?.images ?? []).filter(image => selectedImageIds.has(image.id) && image.proposal && image.reviewState !== 'accepted');
  const acceptSelected = $('#accept-selected');
  acceptSelected.disabled = viewInactive || running || selectedProposals.length === 0;
  acceptSelected.textContent = `Accept selected${selectedProposals.length ? ` (${selectedProposals.length})` : ''}`;
  acceptSelected.title = selectedProposals.length ? `Accept ${selectedProposals.length} selected proposal${selectedProposals.length === 1 ? '' : 's'} unchanged` : 'Select images with proposals awaiting review';
  $('#update-embeddings').disabled = viewInactive || running || !(state?.embedding?.acceptedItems > 0);
  const embeddingRunning = Boolean(state?.embeddingRuns?.some(run => ['queued', 'running'].includes(run.status)));
  $('#search-demo').disabled = embeddingRunning;
  $('#search-demo').title = embeddingRunning ? 'Wait for the embedding update to finish' : state?.embedding?.profile ? 'Test hybrid retrieval against the current index' : 'Open the search demo, then run Update embeddings to create the index';
  $('#toggle-inactive').textContent = viewInactive ? `Active images (${state?.activeImageCount ?? 0})` : `Deactivated (${state?.inactiveImageCount ?? 0})`;
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
      for (const option of field.options.filter(item => !item.archived)) {
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

const SEARCH_FIELD_CONFIG = Object.freeze([
  { key: 'book', queryKey: 'bookKeys', note: 'Required hard filter' },
  { key: 'characters', queryKey: 'centralCharacterKeys', note: 'Optional hard match · any selected' },
  { key: 'setting', queryKey: 'settingKeys', note: 'Soft ranking boost' },
  { key: 'mood', queryKey: 'moodKeys', note: 'Soft ranking boost' },
  { key: 'image_type', queryKey: 'imageTypeKeys', note: 'Soft ranking boost' }
]);
const GENERIC_SEARCH_CHARACTERS = new Set(['person', 'animal', 'object', 'landscape']);

function searchInputName(fieldKey) {
  return `search-${fieldKey}`;
}

function selectedSearchKeys(fieldKey) {
  return [...document.querySelectorAll(`input[name="${searchInputName(fieldKey)}"]:checked`)].map(input => input.value);
}

function renderSearchFilters() {
  const schema = activeSchema();
  const container = $('#search-filters'); container.replaceChildren();
  for (const config of SEARCH_FIELD_CONFIG) {
    const field = schema?.definition.fields.find(item => item.key === config.key && item.type === 'tags');
    if (!field) continue;
    const group = document.createElement('fieldset'); group.className = 'search-filter';
    const legend = document.createElement('legend'); legend.textContent = field.label;
    const note = document.createElement('small'); note.textContent = config.note;
    const options = document.createElement('div'); options.className = 'search-options';
    const activeOptions = field.options.filter(option => !option.archived);
    const availableOptions = config.key === 'characters' ? activeOptions.filter(option => !GENERIC_SEARCH_CHARACTERS.has(option.key)) : activeOptions;
    for (const option of availableOptions) {
      const choice = document.createElement('label'); choice.className = 'search-option'; choice.title = option.label;
      const input = document.createElement('input'); input.type = 'checkbox'; input.name = searchInputName(field.key); input.value = option.key;
      const label = document.createElement('span'); label.textContent = option.label;
      choice.append(input, label); options.append(choice);
    }
    group.append(legend, note, options); container.append(group);
  }
  const hasBook = Boolean(schema?.definition.fields.some(field => field.key === 'book' && field.type === 'tags'));
  const indexed = state?.embedding?.indexedItems ?? 0;
  const accepted = state?.embedding?.acceptedItems ?? 0;
  const ready = Boolean(state?.embedding?.profile && hasBook);
  $('#run-search').disabled = !ready;
  $('#search-readiness').textContent = !state?.embedding?.profile
    ? 'Run Update embeddings before searching.'
    : !hasBook
      ? 'The active schema needs a Book tag field before hybrid retrieval can run.'
      : `${indexed} of ${accepted} accepted active images are indexed with ${state.embedding.profile.name}.`;
  return ready;
}

function humanSearchValues(values) {
  const schema = activeSchema();
  const rows = [];
  for (const field of schema?.definition.fields ?? []) {
    const value = values?.[field.key];
    if (field.type === 'free_text') {
      if (typeof value === 'string' && value.trim()) rows.push([field.label, value.trim()]);
      continue;
    }
    if (!Array.isArray(value) || !value.length) continue;
    const labels = value.map(key => field.options.find(option => option.key === key)?.label ?? key);
    rows.push([field.label, labels.join(', ')]);
  }
  return rows;
}

function renderSearchResults(response) {
  const results = response?.results ?? [];
  lastSelectionPacket = response?.selectionPacket ?? null;
  $('#copy-selection-packet').hidden = !lastSelectionPacket;
  $('#selection-packet-panel').hidden = !lastSelectionPacket;
  $('#selection-packet-json').textContent = lastSelectionPacket ? JSON.stringify(lastSelectionPacket, null, 2) : '';
  const container = $('#search-results'); container.replaceChildren();
  const summary = $('#search-summary'); summary.classList.remove('error');
  summary.textContent = results.length
    ? `${results.length} ranked candidate${results.length === 1 ? '' : 's'} returned. Click an image for a larger preview.`
    : 'No indexed image satisfied the hard book and character constraints.';
  const score = value => Number.isFinite(value) ? Number(value).toFixed(4) : '—';
  results.forEach((result, index) => {
    const card = document.createElement('article'); card.className = 'search-result';
    const preview = document.createElement('img'); preview.className = 'search-result-image'; preview.src = fileUrl(result.path); preview.alt = result.filename; preview.loading = 'lazy'; preview.decoding = 'async';
    preview.addEventListener('click', () => openImagePreview({ ...result, availability: result.availability ?? 'present' }));
    const body = document.createElement('div'); body.className = 'search-result-body';
    const heading = document.createElement('div'); heading.className = 'search-result-heading';
    const name = document.createElement('strong'); name.textContent = result.filename; name.title = result.path;
    const rank = document.createElement('span'); rank.className = 'search-rank'; rank.textContent = `#${index + 1}`;
    heading.append(name, rank);
    const tags = document.createElement('div'); tags.className = 'search-result-tags';
    for (const [label, value] of humanSearchValues(result.values)) {
      const row = document.createElement('div'); const key = document.createElement('b'); key.textContent = `${label}: `; row.append(key, text(value)); tags.append(row);
    }
    const scores = document.createElement('div'); scores.className = 'search-scores';
    const scoreRows = [
      ['Final', score(result.scores?.final)],
      ['Semantic', score(result.scores?.semantic)],
      ['Semantic rank', result.scores?.semanticRank ?? '—'],
      ['Lexical rank', result.scores?.lexicalRank ?? '—'],
      ['RRF', score(result.scores?.reciprocalRankFusion)],
      ['Structured boost', score(result.scores?.structuredBoost)]
    ];
    for (const [label, value] of scoreRows) { const item = document.createElement('span'); item.textContent = `${label}: ${value}`; scores.append(item); }
    body.append(heading, tags, scores); card.append(preview, body); container.append(card);
  });
}

function openSearchDemo() {
  closeTagPopover();
  renderSearchFilters();
  lastSelectionPacket = null;
  $('#copy-selection-packet').hidden = true;
  $('#selection-packet-panel').hidden = true;
  $('#selection-packet-panel').open = false;
  $('#selection-packet-json').textContent = '';
  $('#search-results').replaceChildren();
  const summary = $('#search-summary'); summary.classList.remove('error'); summary.textContent = 'Choose at least one book and enter a visual query.';
  const dialog = $('#search-dialog');
  if (!dialog.open) dialog.showModal();
  $('#search-query').focus();
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

function quickReviewImage() {
  const id = quickReviewImageIds[quickReviewIndex];
  return state?.images.find(image => image.id === id) ?? null;
}

function openQuickReview() {
  const images = (state?.images ?? []).filter(image => image.active !== false);
  if (!images.length) { setStatus('There are no images in the current catalog view.', true); return; }
  quickReviewImageIds = images.map(image => image.id);
  const firstPending = images.findIndex(image => image.reviewState === 'needs_review' || (image.proposal && image.reviewState !== 'accepted'));
  quickReviewIndex = firstPending >= 0 ? firstPending : 0;
  quickReviewFieldKey = activeSchema()?.definition.fields.find(field => field.type === 'tags')?.key ?? null;
  quickReviewSelectedTagKey = null;
  $('#quick-review-dialog').showModal();
  renderQuickReview();
  $('#quick-review-dialog').focus();
}

function quickSetStatus(message, error = false) {
  const status = $('#quick-review-status');
  status.textContent = message;
  status.classList.toggle('error', error);
}

function renderQuickReview() {
  if (!$('#quick-review-dialog').open) return;
  if ($('#quick-review-descriptions').contains(document.activeElement) && document.activeElement.matches('textarea')) return;
  const image = quickReviewImage();
  const schema = activeSchema();
  if (!image || !schema) {
    $('#quick-review-title').textContent = 'No image available';
    $('#quick-review-position').textContent = 'The current gallery view is empty.';
    $('#quick-review-image-frame').replaceChildren();
    $('#quick-review-category-content').replaceChildren();
    $('#quick-review-descriptions').replaceChildren();
    $('#quick-review-accept').disabled = true;
    return;
  }
  $('#quick-review-title').textContent = image.filename;
  $('#quick-review-position').textContent = `${quickReviewIndex + 1} of ${quickReviewImageIds.length} · ${image.reviewState === 'accepted' ? 'Accepted' : image.reviewState === 'needs_review' ? 'Needs review' : 'Not yet reviewed'}`;
  const descriptions = $('#quick-review-descriptions'); descriptions.replaceChildren();
  for (const field of schema.definition.fields.filter(item => item.type === 'free_text')) {
    const group = document.createElement('label'); group.className = 'quick-review-description-field';
    const heading = document.createElement('span'); heading.textContent = field.key === 'scene_description' ? 'Description' : field.label;
    const input = document.createElement('textarea'); input.className = 'quick-review-text'; input.value = imageValues(image)[field.key] ?? ''; input.placeholder = `Add ${field.label.toLocaleLowerCase()}…`; input.maxLength = 4096;
    let savedText = input.value;
    const save = async () => {
      const nextText = input.value.trim() || null;
      if (nextText === (savedText.trim() || null)) return;
      const nextValues = imageValues(quickReviewImage()); nextValues[field.key] = nextText; savedText = input.value;
      await saveQuickReviewValues(quickReviewImage(), nextValues, `${field.label} saved.`);
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); } });
    group.append(heading, input); descriptions.append(group);
  }
  if (!descriptions.childElementCount) { const empty = document.createElement('span'); empty.textContent = 'This schema has no description field.'; descriptions.append(empty); }
  const frame = $('#quick-review-image-frame'); frame.replaceChildren();
  if (image.path) {
    const preview = document.createElement('img'); preview.src = fileUrl(image.path); preview.alt = image.filename;
    frame.append(preview);
    if (showDetectionBoxes && detectionRegions(image).length) frame.append(renderDetectionOverlay(image));
  } else {
    const unavailable = document.createElement('span'); unavailable.textContent = image.availability === 'present' ? 'Image path unavailable' : image.availability;
    frame.append(unavailable);
  }
  const previous = $('#quick-review-previous'); previous.disabled = quickReviewSaving || quickReviewIndex <= 0;
  const next = $('#quick-review-next'); next.disabled = quickReviewSaving || quickReviewIndex >= quickReviewImageIds.length - 1;
  const tagPanel = $('#quick-review-category-content'); tagPanel.replaceChildren();
  const values = imageValues(image);
  const tagFields = schema.definition.fields.filter(field => field.type === 'tags');
  for (const [index, field] of tagFields.entries()) {
    const panel = document.createElement('section'); panel.className = 'quick-review-category-panel'; panel.dataset.fieldKey = field.key;
    const heading = document.createElement('div'); heading.className = 'quick-review-category-heading';
    const title = document.createElement('strong'); title.textContent = field.label;
    const shortcut = quickReviewKeys[`category_${field.key}`] || (index < 9 ? String(index + 1) : '');
    const add = document.createElement('button'); add.type = 'button'; add.className = 'quick-review-category-add'; add.textContent = '+'; add.title = `Add ${field.label} tags${shortcut ? ` · ${shortcut}` : ''}`; add.setAttribute('aria-label', `Add tags to ${field.label}${shortcut ? ` (${shortcut})` : ''}`); add.disabled = quickReviewSaving;
    add.addEventListener('focus', () => { quickReviewFieldKey = field.key; });
    add.addEventListener('click', () => { quickReviewFieldKey = field.key; openQuickReviewAdd(field.key); });
    heading.append(title, add); panel.append(heading);
    const selected = values[field.key];
    if (!selected.length) { const empty = document.createElement('span'); empty.className = 'quick-review-no-tags'; empty.textContent = 'No tags'; panel.append(empty); }
    else {
      const chips = document.createElement('div'); chips.className = 'quick-review-current-tags';
      for (const key of selected) {
        const option = field.options.find(item => item.key === key);
        const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'quick-review-current-tag'; chip.setAttribute('aria-label', `Remove ${option?.label ?? key} from ${field.label}`); chip.title = 'Click to remove';
        chip.disabled = quickReviewSaving;
        const name = document.createElement('span'); name.textContent = option?.label ?? key;
        const minus = document.createElement('span'); minus.className = 'quick-review-current-tag-minus'; minus.setAttribute('aria-hidden', 'true'); minus.textContent = '−';
        chip.append(name, minus);
        chip.addEventListener('focus', () => { quickReviewFieldKey = field.key; quickReviewSelectedTagKey = key; });
        chip.addEventListener('click', () => removeQuickReviewTag(field.key, key));
        chips.append(chip);
      }
      panel.append(chips);
    }
    panel.addEventListener('focusin', () => { quickReviewFieldKey = field.key; });
    tagPanel.append(panel);
  }
  if (!tagFields.length) { const empty = document.createElement('span'); empty.className = 'quick-review-no-tags'; empty.textContent = 'No tag categories in this schema.'; tagPanel.append(empty); }
  $('#quick-review-accept').disabled = !image.proposal && image.reviewState !== 'accepted';
  $('#quick-review-accept').disabled ||= quickReviewSaving;
  $('#quick-review-accept').textContent = image.reviewState === 'accepted' ? 'Next image' : 'Approve & next';
  const keyHint = $('#quick-review-key-hint');
  const categoryKeys = tagFields.map((item, index) => `${quickReviewKeys[`category_${item.key}`] || (index < 9 ? index + 1 : '—')} ${item.label}`).join(' · ');
  keyHint.textContent = `${quickReviewKeys.previous} / ${quickReviewKeys.next} previous/next · ${quickReviewKeys.approve} approve & next · ${quickReviewKeys.edit} edit description · ${quickReviewKeys.add} add to focused category · ${quickReviewKeys.remove} remove focused tag · ${categoryKeys}`;
}

async function saveQuickReviewValues(image, values, message) {
  if (!image || quickReviewSaving) return false;
  quickReviewSaving = true;
  quickSetStatus('Saving…');
  try {
    const currentId = image.id;
    await window.imageTagging.command('review.accept', { imageVersionId: image.versionId, values });
    await refresh();
    quickSetStatus(message);
    if (!quickReviewImageIds.includes(currentId)) quickReviewImageIds.splice(quickReviewIndex, 0, currentId);
    return true;
  } catch (error) { quickSetStatus(error.message, true); return false; }
  finally { quickReviewSaving = false; if ($('#quick-review-dialog').open) renderQuickReview(); }
}

function moveQuickReview(step) {
  const nextIndex = quickReviewIndex + step;
  if (nextIndex < 0 || nextIndex >= quickReviewImageIds.length) return;
  quickReviewIndex = nextIndex; quickReviewSelectedTagKey = null; quickSetStatus(''); renderQuickReview();
}

async function approveQuickReview() {
  const image = quickReviewImage();
  if (!image) return;
  if (image.reviewState === 'accepted') { moveQuickReview(1); return; }
  if (!image.proposal) { quickSetStatus('No proposal is available yet. Add or edit a tag value to accept this image.', true); return; }
  const oldIndex = quickReviewIndex;
  const values = imageValues(image);
  if (!await saveQuickReviewValues(image, values, 'Tags approved.')) return;
  quickReviewIndex = Math.min(oldIndex + 1, quickReviewImageIds.length - 1);
  renderQuickReview();
}

function focusQuickReviewEditor() {
  $('#quick-review-descriptions textarea')?.focus();
}

function focusQuickReviewAdd() {
  const tagFields = activeSchema()?.definition.fields.filter(field => field.type === 'tags') ?? [];
  const fieldKey = tagFields.some(field => field.key === quickReviewFieldKey) ? quickReviewFieldKey : tagFields[0]?.key;
  if (fieldKey) openQuickReviewAdd(fieldKey);
}

function focusQuickReviewCategory(fieldKey) {
  quickReviewFieldKey = fieldKey;
  quickReviewSelectedTagKey = null;
  renderQuickReview();
  const panel = [...document.querySelectorAll('.quick-review-category-panel')].find(item => item.dataset.fieldKey === fieldKey);
  panel?.scrollIntoView({ block: 'nearest' });
  panel?.querySelector('.quick-review-category-add')?.focus();
}

function openQuickReviewAdd(fieldKey) {
  const field = activeSchema()?.definition.fields.find(item => item.key === fieldKey && item.type === 'tags');
  if (!field) return;
  quickReviewFieldKey = field.key;
  quickReviewAddFieldKey = field.key;
  quickReviewAddSelected = new Set();
  $('#quick-review-new-tag').value = '';
  renderQuickReviewAddOptions();
  $('#quick-review-add-dialog').showModal();
  ($('#quick-review-add-options .quick-review-add-option') ?? $('#quick-review-new-tag')).focus();
}

function renderQuickReviewAddOptions() {
  const field = activeSchema()?.definition.fields.find(item => item.key === quickReviewAddFieldKey);
  const image = quickReviewImage();
  const container = $('#quick-review-add-options'); container.replaceChildren();
  if (!field || !image) return;
  const existing = imageValues(image)[field.key];
  $('#quick-review-add-title').textContent = `Add ${field.label} tags`;
  const remaining = field.options.filter(option => !option.archived && !existing.includes(option.key));
  $('#quick-review-add-summary').textContent = remaining.length ? `${remaining.length} available · choose any that fit` : 'No unused values. Add a new value below.';
  if (!remaining.length) { const empty = document.createElement('span'); empty.className = 'quick-review-no-tags'; empty.textContent = 'All existing values are already on this image.'; container.append(empty); }
  for (const option of remaining) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `quick-review-add-option${quickReviewAddSelected.has(option.key) ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(quickReviewAddSelected.has(option.key)));
    button.textContent = `${quickReviewAddSelected.has(option.key) ? '✓ ' : '+ '}${option.label}`;
    button.addEventListener('click', () => {
      if (quickReviewAddSelected.has(option.key)) quickReviewAddSelected.delete(option.key); else quickReviewAddSelected.add(option.key);
      renderQuickReviewAddOptions();
    });
    container.append(button);
  }
  const hasInput = Boolean($('#quick-review-new-tag').value.trim());
  $('#quick-review-add-apply').disabled = quickReviewAddSelected.size === 0 && !hasInput;
  $('#quick-review-add-apply').textContent = hasInput ? 'Add and apply' : `Add selected${quickReviewAddSelected.size ? ` (${quickReviewAddSelected.size})` : ''}`;
}

async function applyQuickReviewAdd() {
  const field = activeSchema()?.definition.fields.find(item => item.key === quickReviewAddFieldKey && item.type === 'tags');
  const image = quickReviewImage(); const schema = activeSchema();
  const newLabel = $('#quick-review-new-tag').value.trim();
  if (!field || !image || !schema) return;
  const addButton = $('#quick-review-add-apply');
  addButton.disabled = true;
  let errorMessage = '';
  try {
    const values = imageValues(image);
    for (const key of quickReviewAddSelected) if (!values[field.key].includes(key)) values[field.key].push(key);
    if (newLabel) {
      const option = await window.imageTagging.command('schema.tag.add', { schemaVersionId: schema.versionId, fieldId: field.id, label: newLabel });
      if (!values[field.key].includes(option.key)) values[field.key].push(option.key);
      quickReviewSelectedTagKey = option.key;
    }
    if (!quickReviewAddSelected.size && !newLabel) return;
    quickReviewSetAddStatus('');
    if (await saveQuickReviewValues(image, values, `${field.label} tags saved.`)) $('#quick-review-add-dialog').close();
    else errorMessage = $('#quick-review-status').textContent;
  } catch (error) { errorMessage = error.message; }
  finally {
    if ($('#quick-review-add-dialog').open) {
      renderQuickReviewAddOptions();
      if (errorMessage) quickReviewSetAddStatus(errorMessage, true);
    }
  }
}

function quickReviewSetAddStatus(message, error = false) {
  $('#quick-review-add-summary').textContent = message || `Choose tags for ${activeSchema()?.definition.fields.find(item => item.key === quickReviewAddFieldKey)?.label ?? 'this category'}.`;
  $('#quick-review-add-summary').classList.toggle('error', error);
}

async function removeQuickReviewTag(fieldKey = quickReviewFieldKey, optionKey = quickReviewSelectedTagKey) {
  const image = quickReviewImage();
  const field = activeSchema()?.definition.fields.find(item => item.key === fieldKey && item.type === 'tags');
  if (!image || field?.type !== 'tags') return;
  const values = imageValues(image);
  const selected = values[field.key];
  const key = selected.includes(optionKey) ? optionKey : selected.at(-1);
  if (!key) { quickSetStatus('No selected tag to remove.'); return; }
  values[field.key] = selected.filter(item => item !== key);
  quickReviewSelectedTagKey = null;
  await saveQuickReviewValues(image, values, `Removed ${field.options.find(item => item.key === key)?.label ?? key}.`);
}

function renderQuickReviewKeyConfig() {
  const container = $('#quick-review-key-bindings'); container.replaceChildren();
  const actions = [
    ['previous', 'Previous image'], ['next', 'Next image'], ['approve', 'Approve & next'],
    ['edit', 'Edit description'], ['add', 'Open add-tags dialog'], ['remove', 'Remove focused or last selected tag']
  ];
  const fields = activeSchema()?.definition.fields.filter(field => field.type === 'tags') ?? [];
  const bindings = [...actions, ...fields.map(field => [`category_${field.key}`, `Focus category: ${field.label}`])];
  for (const [key, label] of bindings) {
    const row = document.createElement('label'); row.className = 'quick-review-key-row'; row.append(text(label));
    const input = document.createElement('button'); input.type = 'button'; input.className = 'quick-review-key-capture'; input.textContent = quickReviewKeys[key] ?? (key.startsWith('category_') && fields.findIndex(field => `category_${field.key}` === key) < 9 ? String(fields.findIndex(field => `category_${field.key}` === key) + 1) : 'Unassigned');
    input.setAttribute('aria-label', `${label} shortcut`);
    input.addEventListener('click', () => { input.textContent = 'Press a key…'; input.dataset.capturing = 'true'; input.focus(); });
    input.addEventListener('keydown', event => {
      if (input.dataset.capturing !== 'true') return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { delete input.dataset.capturing; renderQuickReviewKeyConfig(); return; }
      if (event.key === 'Tab' || event.key.length !== 1 && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(event.key)) return;
      const normalized = event.key === ' ' ? 'Space' : event.key;
      const duplicate = bindings.find(([otherKey]) => otherKey !== key && (quickReviewKeys[otherKey] ?? defaultQuickReviewKey(otherKey, fields))?.toLocaleLowerCase() === normalized.toLocaleLowerCase());
      if (duplicate) { input.textContent = 'Already used'; setTimeout(() => renderQuickReviewKeyConfig(), 900); return; }
      quickReviewKeys[key] = normalized;
      localStorage.setItem(QUICK_REVIEW_KEY_STORAGE, JSON.stringify(quickReviewKeys));
      renderQuickReviewKeyConfig();
      if ($('#quick-review-dialog').open) renderQuickReview();
    });
    row.append(input); container.append(row);
  }
}

function defaultQuickReviewKey(key, fields = activeSchema()?.definition.fields ?? []) {
  if (Object.hasOwn(QUICK_REVIEW_KEY_DEFAULTS, key)) return QUICK_REVIEW_KEY_DEFAULTS[key];
  if (key.startsWith('category_')) { const tagFields = fields.filter(field => field.type === 'tags'); const index = tagFields.findIndex(field => `category_${field.key}` === key); return index >= 0 && index < 9 ? String(index + 1) : ''; }
  return '';
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
      for (const option of field.options.filter(option => !option.archived || (values[field.key] ?? []).includes(option.key))) {
        const label = document.createElement('label'); label.className = 'choice';
        const input = document.createElement('input'); input.type = 'checkbox'; input.name = field.key; input.value = option.key; input.checked = (values[field.key] ?? []).includes(option.key);
        label.append(input, text(`${option.label}${option.archived ? ' (retired)' : ''}`)); choices.append(label);
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
  const editableDefinition = structuredClone(schema.definition);
  for (const field of editableDefinition.fields) field.options = field.options.filter(option => !option.archived);
  editingDefinition = structuredClone(editableDefinition);
  originalDefinition = structuredClone(editableDefinition);
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
  $('#embedding-count').textContent = `${state.embedding?.indexedItems ?? 0} / ${state.embedding?.acceptedItems ?? 0}`;
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
    const displayedPath = root.path || root.canonicalPath || 'Path unavailable';
    const rootPath = document.createElement('span'); rootPath.className = 'root-path'; rootPath.textContent = displayedPath; rootPath.title = displayedPath; rootPath.dir = 'auto';
    location.append(select, rootPath);
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
    const prompts = provider.settings.promptTemplates ?? {};
    form.elements.taggingSystemPrompt.value = prompts.imageTagging?.systemText ?? state.promptDefaults.imageTagging.systemText;
    form.elements.taggingUserPrompt.value = prompts.imageTagging?.userText ?? state.promptDefaults.imageTagging.userText;
    form.elements.detectionSystemPrompt.value = prompts.detection?.systemText ?? state.promptDefaults.detection.systemText;
    form.elements.detectionUserPrompt.value = prompts.detection?.userText ?? state.promptDefaults.detection.userText;
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
    const preview = document.createElement('img');
    preview.src = fileUrl(image.path); preview.alt = '';
    preview.loading = 'lazy'; preview.decoding = 'async'; preview.fetchPriority = 'low';
    const previewFrame = document.createElement('div'); previewFrame.className = 'preview-frame interactive'; previewFrame.tabIndex = 0; previewFrame.setAttribute('role', 'button'); previewFrame.setAttribute('aria-label', `Open larger preview of ${image.filename}`); previewFrame.append(preview);
    if (showDetectionBoxes && detectionRegions(image).length) previewFrame.append(renderDetectionOverlay(image));
    previewFrame.addEventListener('click', () => openImagePreview(image));
    previewFrame.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); openImagePreview(image);
    });
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
    const activity = document.createElement('button'); activity.className = 'quiet'; activity.textContent = image.active ? 'Deactivate' : 'Reactivate';
    activity.addEventListener('click', () => perform(async () => { await window.imageTagging.command('images.setActive', { imageIds: [image.id], active: !image.active }); selectedImageIds.delete(image.id); await refresh(); }, image.active ? 'Deactivating image…' : 'Reactivating image…'));
    actions.append(activity);
    actionCell.append(actions);
    row.append(selectCell, assetCell, tagsCell, actionCell); body.append(row);
  }
  updateSelectionControls();
  const running = state.runs.find(run => ['queued', 'running'].includes(run.status));
  const detectionRunning = state.detectionRuns?.find(run => ['queued', 'running'].includes(run.status));
  const embeddingRunning = state.embeddingRuns?.find(run => ['queued', 'running'].includes(run.status));
  activeRunId = running?.id ?? activeRunId;
  activeDetectionRunId = detectionRunning?.id ?? activeDetectionRunId;
  activeEmbeddingRunId = embeddingRunning?.id ?? activeEmbeddingRunId;
  $('#cancel-run').hidden = !running;
  $('#cancel-detection').hidden = !detectionRunning;
  $('#cancel-embeddings').hidden = !embeddingRunning;
  renderQuickReview();
  if (running) setStatus(`Tagging ${running.completedItems} of ${running.totalItems} · ${running.failedItems} failed`);
  else if (detectionRunning) setStatus(`Detecting ${detectionRunning.completedItems} of ${detectionRunning.totalItems} · ${detectionRunning.failedItems} failed`);
  else if (embeddingRunning) setStatus(`Embedding ${embeddingRunning.completedItems} of ${embeddingRunning.totalItems} · ${embeddingRunning.failedItems} failed`);
}

async function refresh() {
  const sequence = ++refreshSequence;
  const next = await window.imageTagging.command('get', { rootIds: selectedRootIds === null ? null : [...selectedRootIds], activity: viewInactive ? 'inactive' : 'active' });
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
$('#toggle-detection-boxes').addEventListener('click', toggleDetectionBoxes);
$('#preview-toggle-boxes').addEventListener('click', toggleDetectionBoxes);
$('#close-image-preview').addEventListener('click', () => $('#image-preview-dialog').close());
$('#image-preview-dialog').addEventListener('close', () => { previewingImage = null; $('#image-preview-frame').replaceChildren(); });
$('#action-selector').addEventListener('change', updateSelectionControls);
$('#toggle-inactive').addEventListener('click', () => {
  viewInactive = !viewInactive;
  selectedImageIds.clear();
  refresh().catch(error => setStatus(error.message, true));
});
$('#set-selected-active').addEventListener('click', () => perform(async () => {
  const imageIds = [...selectedImageIds];
  if (!imageIds.length) return;
  await window.imageTagging.command('images.setActive', { imageIds, active: viewInactive });
  selectedImageIds.clear(); await refresh();
  setStatus(viewInactive ? 'Selected images reactivated.' : 'Selected images deactivated.');
}, viewInactive ? 'Reactivating images…' : 'Deactivating images…'));
$('#accept-selected').addEventListener('click', () => perform(async () => {
  const imageVersionIds = state.images
    .filter(image => selectedImageIds.has(image.id) && image.proposal && image.reviewState !== 'accepted')
    .map(image => image.versionId);
  if (!imageVersionIds.length) return;
  const result = await window.imageTagging.command('review.bulk.accept', { imageVersionIds, changes: {} });
  selectedImageIds.clear(); await refresh();
  setStatus(`Accepted ${result.count} selected proposal${result.count === 1 ? '' : 's'}.`);
}, 'Accepting selected proposals…'));
$('#search-demo').addEventListener('click', openSearchDemo);
$('#quick-review').addEventListener('click', openQuickReview);
$('#quick-review-previous').addEventListener('click', () => moveQuickReview(-1));
$('#quick-review-next').addEventListener('click', () => moveQuickReview(1));
$('#quick-review-accept').addEventListener('click', approveQuickReview);
$('#quick-review-close').addEventListener('click', () => $('#quick-review-dialog').close());
$('#quick-review-dialog').addEventListener('close', () => { quickReviewImageIds = []; quickReviewSelectedTagKey = null; });
$('#quick-review-add-close').addEventListener('click', () => $('#quick-review-add-dialog').close());
$('#quick-review-add-cancel').addEventListener('click', () => $('#quick-review-add-dialog').close());
  $('#quick-review-add-apply').addEventListener('click', applyQuickReviewAdd);
  $('#quick-review-new-tag').addEventListener('input', renderQuickReviewAddOptions);
  $('#quick-review-new-tag').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); applyQuickReviewAdd(); } });
$('#quick-review-add-dialog').addEventListener('close', () => { quickReviewAddSelected = new Set(); });
$('#quick-review-reset-keys').addEventListener('click', () => {
  quickReviewKeys = { ...QUICK_REVIEW_KEY_DEFAULTS };
  localStorage.setItem(QUICK_REVIEW_KEY_STORAGE, JSON.stringify(quickReviewKeys));
  renderQuickReviewKeyConfig();
  if ($('#quick-review-dialog').open) renderQuickReview();
});
$('#close-search').addEventListener('click', () => $('#search-dialog').close());
$('#search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const summary = $('#search-summary');
  summary.classList.remove('error');
  const semanticText = $('#search-query').value.trim();
  const bookKeys = selectedSearchKeys('book');
  if (!semanticText) { summary.textContent = 'Enter a semantic visual query.'; summary.classList.add('error'); $('#search-query').focus(); return; }
  if (!bookKeys.length) { summary.textContent = 'Choose at least one book. Book is a required hard filter.'; summary.classList.add('error'); return; }
  const payload = {
    semanticText,
    spokenText: $('#search-spoken-text').value.trim() || undefined,
    paragraphContext: $('#search-paragraph-context').value.trim() || undefined,
    videoTheme: $('#search-video-theme').value.trim() || undefined,
    bookKeys,
    limit: Number($('#search-limit').value)
  };
  for (const config of SEARCH_FIELD_CONFIG) {
    if (config.key === 'book') continue;
    payload[config.queryKey] = selectedSearchKeys(config.key);
  }
  const button = $('#run-search'); button.disabled = true;
  summary.textContent = 'Searching the local hybrid index…';
  $('#search-results').replaceChildren();
  try {
    const response = await window.imageTagging.command('search.hybrid', payload);
    if (!response.ok) { summary.textContent = response.message ?? 'Search could not run.'; summary.classList.add('error'); return; }
    renderSearchResults(response);
  } catch (error) {
    summary.textContent = error.message; summary.classList.add('error');
  } finally {
    button.disabled = !state?.embedding?.profile || !activeSchema()?.definition.fields.some(field => field.key === 'book' && field.type === 'tags');
  }
});
$('#copy-selection-packet').addEventListener('click', () => perform(async () => {
  if (!lastSelectionPacket) return;
  await window.imageTagging.command('clipboard.copy', { text: JSON.stringify(lastSelectionPacket, null, 2) });
  setStatus('LLM selection packet copied to the clipboard.');
}, 'Copying LLM selection packet…'));
$('#update-embeddings').addEventListener('click', () => perform(async () => {
  const result = await window.imageTagging.command('embeddings.update');
  activeEmbeddingRunId = result.runId;
  await refresh();
  setStatus(result.totalItems ? `Queued ${result.totalItems} stale image${result.totalItems === 1 ? '' : 's'} for local embeddings.` : `Embeddings are current · ${result.reusedItems} reused.`);
}, 'Preparing local embedding update…'));
$('#run-action').addEventListener('click', () => perform(async () => {
  const { action, scope } = selectedAction();
  const targets = actionTargets(action, scope);
  if (!targets.length) return;
  if (action === 'edit') {
    selectedImageIds = new Set(targets.map(image => image.id));
    renderBulkEditor();
    $('#bulk-dialog').showModal();
    return;
  }
  const imageVersionIds = targets.map(image => image.versionId);
  if (action === 'detect') {
    const result = await window.imageTagging.command('detection.start', { imageVersionIds });
    activeDetectionRunId = result.runId; await refresh(); setStatus(`Queued ${result.totalItems} image${result.totalItems === 1 ? '' : 's'} for face and object detection.`);
  } else {
    const result = await window.imageTagging.command('run.start', { selectionPolicy: 'force_all', imageVersionIds });
    activeRunId = result.runId; await refresh(); setStatus(`Queued ${result.totalItems} image${result.totalItems === 1 ? '' : 's'} for tagging.`);
  }
}, 'Starting action…'));
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

$('#open-catalog').addEventListener('click', () => perform(async () => { state = await window.imageTagging.command('catalog.open'); selectedRootIds = null; viewInactive = false; render(); setStatus('Catalog opened.'); }, 'Opening catalog…'));
$('#save-catalog-as').addEventListener('click', () => perform(async () => { await window.imageTagging.command('catalog.saveAs'); await refresh(); setStatus('Catalog saved and now in use.'); }, 'Saving catalog…'));
$('#toggle-config').addEventListener('click', () => setConfigCollapsed(!document.body.classList.contains('config-collapsed')));
$('#new-catalog').addEventListener('click', () => perform(async () => { state = await window.imageTagging.command('catalog.new'); selectedRootIds = null; viewInactive = false; render(); setStatus('Catalog ready.'); }, 'Creating catalog…'));
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
    await window.imageTagging.command('provider.save', { id: form.dataset.id, name: values.name, dialect: values.dialect, endpoint: values.endpoint, model: values.model, apiKey: values.apiKey,
      settings: { imagePreset: values.imagePreset, timeoutMs: 60000, extraInstructions: '', promptTemplates: {
        imageTagging: { systemText: values.taggingSystemPrompt, userText: values.taggingUserPrompt },
        detection: { systemText: values.detectionSystemPrompt, userText: values.detectionUserPrompt }
      } } });
    form.elements.apiKey.value = ''; await refresh(); setStatus('Provider settings saved securely.');
  }, 'Saving provider…');
});
$('#reset-image-prompts').addEventListener('click', () => {
  if (!state?.promptDefaults) return;
  const form = $('#provider-form');
  form.elements.taggingSystemPrompt.value = state.promptDefaults.imageTagging.systemText;
  form.elements.taggingUserPrompt.value = state.promptDefaults.imageTagging.userText;
  form.elements.detectionSystemPrompt.value = state.promptDefaults.detection.systemText;
  form.elements.detectionUserPrompt.value = state.promptDefaults.detection.userText;
  setStatus('Image prompt defaults restored in the form. Save provider to apply them to future runs.');
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
$('#cancel-run').addEventListener('click', () => perform(async () => { await window.imageTagging.command('run.cancel', { runId: activeRunId }); setStatus('Cancel requested…'); }, 'Canceling run…'));
$('#cancel-detection').addEventListener('click', () => perform(async () => { await window.imageTagging.command('detection.cancel', { runId: activeDetectionRunId }); setStatus('Detection cancel requested…'); }, 'Canceling detection…'));
$('#cancel-embeddings').addEventListener('click', () => perform(async () => { await window.imageTagging.command('embeddings.cancel', { runId: activeEmbeddingRunId }); setStatus('Embedding cancel requested…'); }, 'Canceling embeddings…'));
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
    if (!structureChanged) {
      let added = 0;
      let archived = 0;
      for (const field of definition.fields) {
        const original = originalDefinition.fields.find(candidate => candidate.id === field.id);
        const known = new Set(original.options.map(option => option.label.toLocaleLowerCase()));
        for (const option of field.options) if (!known.has(option.label.toLocaleLowerCase())) {
          await window.imageTagging.command('schema.tag.add', { schemaVersionId: schema.versionId, fieldId: field.id, label: option.label }); added++;
        }
        const current = new Set(field.options.map(option => option.label.toLocaleLowerCase()));
        for (const option of original.options) if (!current.has(option.label.toLocaleLowerCase())) {
          await window.imageTagging.command('schema.tag.archive', { schemaVersionId: schema.versionId, fieldId: field.id, optionId: option.id }); archived++;
        }
      }
      $('#schema-dialog').close(); await refresh();
      const changes = [added ? `${added} added` : '', archived ? `${archived} retired` : ''].filter(Boolean).join(', ');
      setStatus(changes ? `Tag values updated: ${changes}. Existing image tags were preserved.` : 'No schema changes.'); return;
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
  if (event.type === 'embedding.model.progress') setStatus(`Preparing BGE Small model${event.progress?.status ? ` · ${event.progress.status}` : ''}…`);
  if (event.type === 'embedding.progress') setStatus(`Embedding ${event.completed_items ?? event.completedItems ?? 0} of ${event.total_items ?? event.totalItems ?? 0} · ${event.failed_items ?? event.failedItems ?? 0} failed`);
  if (event.type === 'embedding.complete') setStatus(`Embedding update ${event.status}${event.failedItems ? ` · ${event.failedItems} failed` : ''}.`);
  clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(error => setStatus(error.message, true)), 180);
});

refresh().then(() => {
  if (state.unavailableLocation) setStatus(`The last catalog is unavailable: ${state.unavailableLocation}. Open it after connecting the drive, or choose another catalog.`, true);
  else setStatus('Catalog ready.');
}).catch(error => setStatus(error.message, true));
