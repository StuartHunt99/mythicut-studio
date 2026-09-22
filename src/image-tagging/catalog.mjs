import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { openCatalogDatabase } from './database.mjs';
import { canonicalizeRoot, scanRoot } from './scanner.mjs';
import { prepareImageForApi } from './image-preparation.mjs';
import { compileTaggingRequest } from './prompt.mjs';
import { DEFAULT_PROMPTS, effectivePromptTemplate, renderPrompt } from '../prompt-templates.mjs';
import { createStarterDefinition, definitionHash, inferOptionKey, validateSchemaDefinition, validateTagValues } from './schema.mjs';
import { createImageTagProvider, SUPPORTED_PROVIDER_DIALECTS } from './providers/ai-sdk.mjs';
import { BGE_SMALL_PROFILE, createBgeSmallEmbeddingModel } from './embedding-model.mjs';
import { RETRIEVAL_TEXT_VERSION } from './retrieval-text.mjs';
import { createEmbeddingRun, ensureEmbeddingProfile, processEmbeddingRun, setImagesActive } from './embedding-index.mjs';
import { searchHybridImages, validateHybridQuery } from './search.mjs';
import { buildSelectionPacket } from './selection-packet.mjs';

const DEFAULT_PROVIDER = Object.freeze({
  name: 'OpenAI',
  dialect: 'openai',
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  settings: { imagePreset: 'economy', timeoutMs: 60_000, extraInstructions: '' }
});

const GOOGLE_MODEL_RECOMMENDATIONS = Object.freeze(['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro']);
const MAX_DETECTION_FACES = 5;
const MAX_DETECTION_OBJECTS = 4;
const DETECTION_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    faces: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          box_2d: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 },
          label: { type: 'string' }
        },
        required: ['box_2d', 'label'],
        additionalProperties: false
      }
    },
    objects: {
      type: 'array',
      maxItems: MAX_DETECTION_OBJECTS,
      items: {
        type: 'object',
        properties: {
          box_2d: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 },
          label: { type: 'string' }
        },
        required: ['box_2d', 'label'],
        additionalProperties: false
      }
    }
  },
  required: ['faces', 'objects'],
  additionalProperties: false
});

const parse = (value, fallback = null) => value == null ? fallback : JSON.parse(value);
const iso = clock => clock().toISOString();
const imagePath = row => row.root_path && row.relative_path
  ? join(row.root_path, ...row.relative_path.split('/'))
  : row.display_path;

function cleanText(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${name} must be 1-${max} characters`);
  return value.trim();
}

function validateDetectionValues(input, metadata = {}) {
  if (!input || typeof input !== 'object') throw new Error('Detection output must be a JSON object or array');
  const normalizeItem = (item, key, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 200) throw new Error(`Detection ${key}[${index}] has an invalid label`);
    if (!Array.isArray(item.box_2d) || item.box_2d.length !== 4 || item.box_2d.some(coordinate => !Number.isInteger(coordinate) || coordinate < 0 || coordinate > 1000)) throw new Error(`Detection ${key}[${index}] has an invalid box`);
    const [ymin, xmin, ymax, xmax] = item.box_2d;
    if (ymax < ymin || xmax < xmin) throw new Error(`Detection ${key}[${index}] has an inverted box`);
    return { label: item.label.trim(), x: xmin / 1000, y: ymin / 1000, width: (xmax - xmin) / 1000, height: (ymax - ymin) / 1000 };
  };
  const normalize = (value, key, maxItems) => {
    if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Detection ${key} must contain 0-${maxItems} items`);
    return value.map((item, index) => normalizeItem(item, key, index));
  };
  if (Array.isArray(input)) {
    const characterLabels = new Set((Array.isArray(metadata.characters) ? metadata.characters : []).map(value => String(value).trim().toLocaleLowerCase()).filter(Boolean));
    const faces = [];
    const objects = [];
    for (const [index, item] of input.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Detection output[${index}] is invalid`);
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      const category = typeof item.category === 'string' ? item.category.trim().toLocaleLowerCase() : '';
      const labelKey = label.toLocaleLowerCase();
      const looksLikeObject = ['object', 'thing'].includes(category) || /\b(bottle|lamp|post|table|chair|book|door|window|sword|horse|animal)\b/i.test(label);
      const looksLikeFace = ['face', 'person', 'character'].includes(category) || characterLabels.has(labelKey) || /\b(face|person|character|man|woman|boy|girl)\b/i.test(label) || (category === '' && label.includes('_') && !looksLikeObject);
      if (looksLikeFace && !looksLikeObject) faces.push(item);
      else objects.push(item);
    }
    return { faces: normalize(faces, 'faces', MAX_DETECTION_FACES), objects: normalize(objects, 'objects', MAX_DETECTION_OBJECTS) };
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'faces') || !Object.prototype.hasOwnProperty.call(input, 'objects')) throw new Error('Detection output must contain faces and objects');
  return { faces: normalize(input.faces, 'faces', MAX_DETECTION_FACES), objects: normalize(input.objects, 'objects', MAX_DETECTION_OBJECTS) };
}

function providerSettings(input = {}) {
  const imagePreset = input.imagePreset ?? 'economy';
  if (!['economy', 'balanced', 'detail'].includes(imagePreset)) throw new Error('Unknown image preset');
  const timeoutMs = Number(input.timeoutMs ?? 60_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) throw new Error('Provider timeout must be 5-300 seconds');
  const extraInstructions = String(input.extraInstructions ?? '').trim();
  if (extraInstructions.length > 8_000) throw new Error('Extra instructions are too long');
  const promptTemplates = input.promptTemplates ?? {};
  if (!promptTemplates || typeof promptTemplates !== 'object' || Array.isArray(promptTemplates) ||
      Object.keys(promptTemplates).some(task => !['imageTagging', 'detection'].includes(task))) throw new Error('Invalid catalog prompt templates');
  for (const [task, template] of Object.entries(promptTemplates)) effectivePromptTemplate(task, template);
  return { imagePreset, timeoutMs, extraInstructions, promptTemplates };
}

function validateGoogleModel(model) {
  const value = cleanText(model, 'Model', 200);
  if (value.includes('/')) throw new Error('Google model names must be bare names like gemini-2.5-flash; do not include "models/" or provider prefixes.');
  if (!GOOGLE_MODEL_RECOMMENDATIONS.includes(value) && /^gemini-[0-9]+\.[0-9]+/.test(value)) {
    throw new Error(`Unsupported Google model "${value}". Use a known stable model such as ${GOOGLE_MODEL_RECOMMENDATIONS.join(', ')}.`);
  }
  return value;
}

function validateProvider(input) {
  const dialect = input.dialect ?? 'openai';
  if (!SUPPORTED_PROVIDER_DIALECTS.includes(dialect)) throw new Error('This build supports OpenAI, Google Gemini, and OpenAI-compatible providers');
  const endpoint = new URL(input.endpoint ?? DEFAULT_PROVIDER.endpoint);
  if (endpoint.protocol !== 'https:') throw new Error('Provider endpoint must use HTTPS');
  if (dialect === 'openai' && endpoint.origin !== 'https://api.openai.com') throw new Error('The OpenAI provider must use api.openai.com');
  if (dialect === 'google' && endpoint.origin !== 'https://generativelanguage.googleapis.com') throw new Error('The Google provider must use generativelanguage.googleapis.com');
  return {
    name: cleanText(input.name, 'Provider name'),
    dialect,
    endpoint: endpoint.toString().replace(/\/$/, ''),
    model: dialect === 'google' ? validateGoogleModel(input.model) : cleanText(input.model, 'Model', 200),
    credentialRef: input.credentialRef == null ? null : cleanText(input.credentialRef, 'Credential reference', 500),
    settings: providerSettings(input.settings)
  };
}

function publicProvider(row) {
  return {
    id: row.id,
    name: row.name,
    dialect: row.dialect,
    endpoint: row.endpoint,
    model: row.model,
    hasCredential: Boolean(row.credential_ref),
    settings: parse(row.settings_json, {}),
    lastVerifiedAt: row.last_verified_at,
    updatedAt: row.updated_at
  };
}

function seedOptionRows(db, schemaId, definition, { clock, id }) {
  const now = iso(clock);
  const insert = db.prepare(`INSERT OR IGNORE INTO tag_options(id, schema_id, field_id, option_key, label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const field of definition.fields) {
    if (field.type === 'free_text') continue;
    for (const option of field.options) insert.run(option.id ?? id(), schemaId, field.id, option.key, option.label, now, now);
  }
}

function definitionWithVocabulary(db, schemaId, definition, { includeArchived = true } = {}) {
  const normalized = validateSchemaDefinition(definition);
  return {
    ...normalized,
    fields: normalized.fields.map(field => {
      if (field.type === 'free_text') return field;
      const rows = db.prepare('SELECT id, option_key key, label, archived FROM tag_options WHERE schema_id = ? AND field_id = ? ORDER BY created_at, id').all(schemaId, field.id);
      const rowsByKey = new Map(rows.map(row => [row.key, row]));
      const options = [];
      const keys = new Set();
      for (const option of field.options) {
        const row = rowsByKey.get(option.key);
        const archived = Boolean(row?.archived);
        if (!archived || includeArchived) {
          options.push({ id: row?.id ?? option.id, key: option.key, label: row?.label ?? option.label, ...(archived ? { archived: true } : {}) });
          keys.add(option.key);
        }
      }
      for (const row of rows) {
        if (keys.has(row.key) || (!includeArchived && row.archived)) continue;
        options.push({ id: row.id, key: row.key, label: row.label, ...(row.archived ? { archived: true } : {}) }); keys.add(row.key);
      }
      return { ...field, options };
    })
  };
}

async function ensureDefaults(store, { clock, id }) {
  const { db, transaction } = store;
  const catalog = db.prepare('SELECT * FROM catalogs LIMIT 1').get();
  const now = iso(clock);
  transaction(() => {
    if (!db.prepare('SELECT id FROM tag_schemas WHERE catalog_id = ? LIMIT 1').get(catalog.id)) {
      const schemaId = id(); const versionId = id(); const definition = createStarterDefinition(id);
      db.prepare('INSERT INTO tag_schemas(id, catalog_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(schemaId, catalog.id, 'Production image tags', 'Starter schema for reviewable production metadata.', now, now);
      db.prepare('INSERT INTO tag_schema_versions(id, schema_id, version, definition_json, definition_hash, published_at, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
        .run(versionId, schemaId, JSON.stringify(definition), definitionHash(definition), now, now, now);
      db.prepare('UPDATE catalogs SET active_schema_version_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(versionId, now, catalog.id);
    }
    if (!db.prepare('SELECT id FROM provider_profiles WHERE catalog_id = ? LIMIT 1').get(catalog.id)) {
      const profileId = id();
      db.prepare('INSERT INTO provider_profiles(id, catalog_id, name, dialect, endpoint, model, credential_ref, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)')
        .run(profileId, catalog.id, DEFAULT_PROVIDER.name, DEFAULT_PROVIDER.dialect, DEFAULT_PROVIDER.endpoint, DEFAULT_PROVIDER.model, JSON.stringify(DEFAULT_PROVIDER.settings), now, now);
      db.prepare('UPDATE catalogs SET active_provider_profile_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(profileId, now, catalog.id);
    }
  });
  transaction(() => {
    for (const row of db.prepare('SELECT v.schema_id, v.definition_json FROM tag_schema_versions v JOIN tag_schemas s ON s.id = v.schema_id WHERE s.catalog_id = ?').all(catalog.id)) {
      seedOptionRows(db, row.schema_id, validateSchemaDefinition(JSON.parse(row.definition_json)), { clock, id });
    }
  });
}

function defaultProviderFactory(profile, credential, logger) {
  return createImageTagProvider({
    dialect: profile.dialect,
    apiKey: credential,
    endpoint: profile.endpoint,
    timeoutMs: profile.settings.timeoutMs,
    logger
  });
}

function defaultEmbeddingFactory(options) {
  return createBgeSmallEmbeddingModel(options);
}

export async function openImageCatalog({
  databasePath,
  name,
  clock = () => new Date(),
  id = randomUUID,
  inspect,
  prepareImage = prepareImageForApi,
  providerFactory = defaultProviderFactory,
  embeddingFactory = defaultEmbeddingFactory,
  modelCachePath,
  logger
}) {
  const store = await openCatalogDatabase(databasePath, { name, clock, id });
  await ensureDefaults(store, { clock, id });
  const { db, transaction } = store;
  const events = new EventEmitter();
  const controllers = new Map();
  let embeddingModelPromise = null;
  let closed = false;

  const getCatalog = () => db.prepare('SELECT * FROM catalogs LIMIT 1').get();

  function emit(type, detail = {}) {
    events.emit('event', { type, at: iso(clock), ...detail });
  }

  function audit(kind, payload) {
    const catalog = getCatalog();
    db.prepare('INSERT INTO audit_events(id, catalog_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id(), catalog.id, kind, JSON.stringify(payload), iso(clock));
  }

  function changed(kind, payload) {
    const catalog = getCatalog();
    const now = iso(clock);
    db.prepare('UPDATE catalogs SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, catalog.id);
    audit(kind, payload);
    emit('catalog.changed', { kind, revision: catalog.revision + 1, payload });
  }

  function recoverInterruptedWork() {
    const catalog = getCatalog();
    const tagRuns = db.prepare("SELECT id FROM runs WHERE catalog_id = ? AND status IN ('queued', 'running', 'paused')").all(catalog.id);
    const detectionRuns = db.prepare("SELECT id FROM detection_runs WHERE catalog_id = ? AND status IN ('queued', 'running')").all(catalog.id);
    const embeddingRuns = db.prepare("SELECT id FROM embedding_runs WHERE catalog_id = ? AND status IN ('queued', 'running')").all(catalog.id);
    if (!tagRuns.length && !detectionRuns.length && !embeddingRuns.length) return;
    const now = iso(clock);
    const message = 'Interrupted when the catalog was reopened; retry the failed images.';
    transaction(() => {
      for (const run of tagRuns) {
        db.prepare("UPDATE run_items SET state = 'failed', error_category = 'interrupted', error_message = ?, updated_at = ? WHERE run_id = ? AND state = 'running'")
          .run(message, now, run.id);
        db.prepare("UPDATE run_items SET state = 'canceled', error_category = 'interrupted', error_message = ?, updated_at = ? WHERE run_id = ? AND state = 'queued'")
          .run(message, now, run.id);
        const failed = db.prepare("SELECT count(*) count FROM run_items WHERE run_id = ? AND state = 'failed'").get(run.id).count;
        db.prepare("UPDATE runs SET status = 'failed', completed_items = total_items, failed_items = ?, error_message = ?, finished_at = ? WHERE id = ?")
          .run(failed, message, now, run.id);
      }
      for (const run of detectionRuns) {
        db.prepare("UPDATE detection_run_items SET state = 'failed', error_message = ?, updated_at = ? WHERE run_id = ? AND state = 'running'")
          .run(message, now, run.id);
        db.prepare("UPDATE detection_run_items SET state = 'canceled', error_message = ?, updated_at = ? WHERE run_id = ? AND state = 'queued'")
          .run(message, now, run.id);
        const failed = db.prepare("SELECT count(*) count FROM detection_run_items WHERE run_id = ? AND state = 'failed'").get(run.id).count;
        db.prepare("UPDATE detection_runs SET status = 'failed', completed_items = total_items, failed_items = ?, error_message = ?, finished_at = ? WHERE id = ?")
          .run(failed, message, now, run.id);
      }
      for (const run of embeddingRuns) {
        db.prepare("UPDATE embedding_run_items SET state = 'failed', error_message = ?, updated_at = ? WHERE run_id = ? AND state = 'running'")
          .run(message, now, run.id);
        db.prepare("UPDATE embedding_run_items SET state = 'canceled', error_message = ?, updated_at = ? WHERE run_id = ? AND state = 'queued'")
          .run(message, now, run.id);
        const failed = db.prepare("SELECT count(*) count FROM embedding_run_items WHERE run_id = ? AND state = 'failed'").get(run.id).count;
        db.prepare("UPDATE embedding_runs SET status = 'failed', completed_items = total_items, failed_items = ?, error_message = ?, finished_at = ? WHERE id = ?")
          .run(failed, message, now, run.id);
      }
      db.prepare('UPDATE catalogs SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, catalog.id);
      audit('work.interrupted', { tagRunIds: tagRuns.map(run => run.id), detectionRunIds: detectionRuns.map(run => run.id), embeddingRunIds: embeddingRuns.map(run => run.id) });
    });
  }

  recoverInterruptedWork();

  function snapshot({ limit = 1000, offset = 0, rootIds = null, activity = 'active' } = {}) {
    const catalog = getCatalog();
    if (rootIds !== null && !Array.isArray(rootIds)) throw new Error('Snapshot rootIds must be an array');
    if (!['active', 'inactive'].includes(activity)) throw new Error('Snapshot activity must be active or inactive');
    const activityFilter = activity === 'active' ? ' AND i.active = 1' : ' AND i.active = 0';
    const selectedRootIds = rootIds === null ? null : [...new Set(rootIds.map(value => String(value)).filter(Boolean))];
    const rootFilter = selectedRootIds === null
      ? ''
      : selectedRootIds.length
        ? ` AND EXISTS (SELECT 1 FROM image_roots selected_ir JOIN roots selected_root ON selected_root.id = selected_ir.root_id
          WHERE selected_ir.image_id = i.id AND selected_ir.root_id IN (${selectedRootIds.map(() => '?').join(',')}) AND selected_root.catalog_id = i.catalog_id)`
        : ' AND 0';
    const schemas = db.prepare(`SELECT s.id, s.name, s.description, s.archived, s.updated_at,
      v.id version_id, v.version, v.definition_json, v.published_at
      FROM tag_schemas s JOIN tag_schema_versions v ON v.schema_id = s.id
      WHERE s.catalog_id = ? ORDER BY s.name, v.version DESC`).all(catalog.id).map(row => ({
      id: row.id, name: row.name, description: row.description, archived: Boolean(row.archived), updatedAt: row.updated_at,
        versionId: row.version_id, version: row.version, definition: definitionWithVocabulary(db, row.id, parse(row.definition_json), { includeArchived: true }), publishedAt: row.published_at,
        active: row.version_id === catalog.active_schema_version_id
      }));
    const images = db.prepare(`SELECT i.id, i.display_path, i.filename, i.availability, i.active, i.last_seen_at,
      r.canonical_path root_path, ir.relative_path,
      v.id version_id, v.width, v.height, v.media_type,
      at.review_state, at.accepted_revision_id,
      (SELECT tr.values_json FROM tag_revisions tr WHERE tr.image_version_id = v.id AND tr.schema_version_id = ? AND tr.kind = 'proposal' ORDER BY tr.created_at DESC LIMIT 1) proposal_json,
      (SELECT tr.values_json FROM tag_revisions tr WHERE tr.id = at.accepted_revision_id) accepted_json,
      (SELECT dr.coordinates_json FROM image_detection_results dr WHERE dr.image_version_id = v.id ORDER BY dr.created_at DESC LIMIT 1) detection_json,
      (SELECT ri.state FROM run_items ri JOIN runs latest_run ON latest_run.id = ri.run_id WHERE ri.image_version_id = v.id ORDER BY ri.updated_at DESC, ri.id DESC LIMIT 1) latest_run_item_state,
      (SELECT ri.error_message FROM run_items ri JOIN runs latest_run ON latest_run.id = ri.run_id WHERE ri.image_version_id = v.id ORDER BY ri.updated_at DESC, ri.id DESC LIMIT 1) latest_run_item_error,
      (SELECT dri.state FROM detection_run_items dri JOIN detection_runs latest_detection_run ON latest_detection_run.id = dri.run_id WHERE dri.image_version_id = v.id ORDER BY dri.updated_at DESC, dri.id DESC LIMIT 1) latest_detection_item_state,
      (SELECT dri.error_message FROM detection_run_items dri JOIN detection_runs latest_detection_run ON latest_detection_run.id = dri.run_id WHERE dri.image_version_id = v.id ORDER BY dri.updated_at DESC, dri.id DESC LIMIT 1) latest_detection_item_error
      FROM images i JOIN image_versions v ON v.id = i.current_version_id
      LEFT JOIN image_roots ir ON ir.image_id = i.id AND ir.root_id = (
        SELECT min(ir2.root_id) FROM image_roots ir2 WHERE ir2.image_id = i.id AND ir2.present = 1
      )
      LEFT JOIN roots r ON r.id = ir.root_id
      LEFT JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = ?
      WHERE i.catalog_id = ?${activityFilter}${rootFilter} ORDER BY i.filename, i.id LIMIT ? OFFSET ?`)
      .all(catalog.active_schema_version_id, catalog.active_schema_version_id, catalog.id, ...(selectedRootIds ?? []), Math.min(1000, Math.max(1, Number(limit))), Math.max(0, Number(offset)))
      .map(row => ({ id: row.id, path: imagePath(row), filename: row.filename, availability: row.availability, active: Boolean(row.active), lastSeenAt: row.last_seen_at,
        versionId: row.version_id, width: row.width, height: row.height, mediaType: row.media_type,
        runState: row.latest_run_item_state, errorMessage: row.latest_run_item_error,
        detectionRunState: row.latest_detection_item_state, detectionErrorMessage: row.latest_detection_item_error,
        reviewState: row.review_state ?? 'not_ready', acceptedRevisionId: row.accepted_revision_id,
        proposal: parse(row.proposal_json), accepted: parse(row.accepted_json), detection: parse(row.detection_json) }));
    const imageCount = db.prepare(`SELECT count(*) count FROM images i WHERE i.catalog_id = ?${activityFilter}${rootFilter}`)
      .get(catalog.id, ...(selectedRootIds ?? [])).count;
    const activeImageCount = db.prepare('SELECT count(*) count FROM images WHERE catalog_id = ? AND active = 1').get(catalog.id).count;
    const inactiveImageCount = db.prepare('SELECT count(*) count FROM images WHERE catalog_id = ? AND active = 0').get(catalog.id).count;
    const embeddingProfile = catalog.active_embedding_profile_id
      ? db.prepare('SELECT * FROM embedding_profiles WHERE id = ?').get(catalog.active_embedding_profile_id)
      : null;
    const acceptedForEmbedding = db.prepare(`SELECT count(*) count FROM images i JOIN image_versions v ON v.id = i.current_version_id
      JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = ? AND at.review_state = 'accepted' AND at.accepted_revision_id IS NOT NULL
      WHERE i.catalog_id = ? AND i.active = 1 AND i.availability = 'present'`).get(catalog.active_schema_version_id, catalog.id).count;
    const indexedForEmbedding = embeddingProfile ? db.prepare(`SELECT count(*) count FROM images i JOIN image_versions v ON v.id = i.current_version_id
      JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = ? AND at.review_state = 'accepted'
      JOIN retrieval_documents rd ON rd.image_version_id = v.id AND rd.tag_revision_id = at.accepted_revision_id
      JOIN retrieval_embeddings re ON re.tag_revision_id = rd.tag_revision_id AND re.retrieval_text_hash = rd.retrieval_text_hash AND re.profile_id = ?
      WHERE i.catalog_id = ? AND i.active = 1 AND i.availability = 'present'`).get(catalog.active_schema_version_id, embeddingProfile.id, catalog.id).count : 0;
    return {
      catalog: { id: catalog.id, name: catalog.name, revision: catalog.revision, activeSchemaVersionId: catalog.active_schema_version_id, activeProviderProfileId: catalog.active_provider_profile_id, activeEmbeddingProfileId: catalog.active_embedding_profile_id },
      roots: db.prepare('SELECT * FROM roots WHERE catalog_id = ? ORDER BY display_path').all(catalog.id).map(row => ({ id: row.id, path: row.display_path, canonicalPath: row.canonical_path, recursive: Boolean(row.recursive), includeHidden: Boolean(row.include_hidden), excludes: parse(row.exclude_json, []), enabled: Boolean(row.enabled) })),
      schemas,
      providers: db.prepare('SELECT * FROM provider_profiles WHERE catalog_id = ? ORDER BY name').all(catalog.id).map(publicProvider),
      runs: db.prepare('SELECT * FROM runs WHERE catalog_id = ? ORDER BY created_at DESC LIMIT 50').all(catalog.id).map(row => ({ id: row.id, status: row.status, totalItems: row.total_items, completedItems: row.completed_items, failedItems: row.failed_items, createdAt: row.created_at, finishedAt: row.finished_at, error: row.error_message })),
      detectionRuns: db.prepare('SELECT * FROM detection_runs WHERE catalog_id = ? ORDER BY created_at DESC LIMIT 50').all(catalog.id).map(row => ({ id: row.id, status: row.status, totalItems: row.total_items, completedItems: row.completed_items, failedItems: row.failed_items, createdAt: row.created_at, finishedAt: row.finished_at, error: row.error_message })),
      embeddingRuns: db.prepare('SELECT * FROM embedding_runs WHERE catalog_id = ? ORDER BY created_at DESC LIMIT 50').all(catalog.id).map(row => ({ id: row.id, status: row.status, totalItems: row.total_items, completedItems: row.completed_items, failedItems: row.failed_items, reusedItems: row.reused_items, createdAt: row.created_at, finishedAt: row.finished_at, error: row.error_message })),
      embedding: { profile: embeddingProfile ? { id: embeddingProfile.id, name: embeddingProfile.name, model: embeddingProfile.model, modelRevision: embeddingProfile.model_revision, dimension: embeddingProfile.dimension } : null, acceptedItems: acceptedForEmbedding, indexedItems: indexedForEmbedding, staleItems: Math.max(0, acceptedForEmbedding - indexedForEmbedding) },
      promptDefaults: { imageTagging: DEFAULT_PROMPTS.imageTagging, detection: DEFAULT_PROMPTS.detection },
      activity,
      activeImageCount,
      inactiveImageCount,
      imageCount,
      images
    };
  }

  async function addRoot(payload) {
    const catalog = getCatalog();
    const canonicalPath = await canonicalizeRoot(payload.path);
    const existing = db.prepare('SELECT id FROM roots WHERE catalog_id = ? AND canonical_path = ?').get(catalog.id, canonicalPath);
    if (existing) return { rootId: existing.id, canonicalPath, alreadyPresent: true };
    const now = iso(clock); const rootId = id();
    const excludes = Array.isArray(payload.excludes) ? payload.excludes.map(item => cleanText(item, 'Exclude pattern', 500)) : [];
    transaction(() => {
      db.prepare('INSERT INTO roots(id, catalog_id, display_path, canonical_path, recursive, include_hidden, exclude_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(rootId, catalog.id, payload.path, canonicalPath, payload.recursive === false ? 0 : 1, payload.includeHidden ? 1 : 0, JSON.stringify(excludes), now, now);
      changed('root.added', { rootId, canonicalPath });
    });
    return { rootId, canonicalPath };
  }

  async function relocateRoot({ rootId, path }) {
    const catalog = getCatalog();
    const root = db.prepare('SELECT * FROM roots WHERE id = ? AND catalog_id = ?').get(rootId, catalog.id);
    if (!root) throw new Error('Image folder not found');
    const canonicalPath = await canonicalizeRoot(path);
    const duplicate = db.prepare('SELECT id FROM roots WHERE catalog_id = ? AND canonical_path = ? AND id <> ?').get(catalog.id, canonicalPath, root.id);
    if (duplicate) throw new Error('That folder is already part of this catalog');
    const members = db.prepare('SELECT image_id, relative_path FROM image_roots WHERE root_id = ?').all(root.id);
    if (members.length) {
      let matched = false;
      for (const member of members) {
        try { await access(join(canonicalPath, ...member.relative_path.split('/'))); matched = true; break; } catch {}
      }
      if (!matched) throw new Error('The selected folder does not contain the cataloged images. Select the replacement for the original root folder.');
    }
    const destinations = members.map(member => ({ ...member, path: join(canonicalPath, ...member.relative_path.split('/')) }));
    for (const destination of destinations) {
      const collision = db.prepare('SELECT id FROM images WHERE catalog_id = ? AND canonical_path = ? AND id <> ?').get(catalog.id, destination.path, destination.image_id);
      if (collision) throw new Error(`Cannot relocate because ${basename(destination.path)} is already cataloged from another folder`);
    }
    const now = iso(clock);
    transaction(() => {
      db.prepare('UPDATE roots SET display_path = ?, canonical_path = ?, updated_at = ? WHERE id = ?').run(canonicalPath, canonicalPath, now, root.id);
      const updateImage = db.prepare('UPDATE images SET canonical_path = ?, display_path = ?, filename = ? WHERE id = ?');
      for (const destination of destinations) updateImage.run(destination.path, destination.path, basename(destination.path), destination.image_id);
      changed('root.relocated', { rootId: root.id, from: root.canonical_path, to: canonicalPath, imageCount: destinations.length });
    });
    return { rootId: root.id, canonicalPath, imageCount: destinations.length };
  }

  async function scan(payload) {
    const roots = payload.rootId ? [payload.rootId] : db.prepare('SELECT id FROM roots WHERE catalog_id = ? AND enabled = 1').all(getCatalog().id).map(row => row.id);
    const summaries = [];
    for (const rootId of roots) {
      const summary = await scanRoot(store, rootId, { clock, id, inspect, progress: event => emit('scan.progress', event) });
      summaries.push(summary);
    }
    transaction(() => changed('roots.scanned', { summaries }));
    return summaries;
  }

  function saveSchema(payload) {
    const definition = validateSchemaDefinition(payload.definition);
    const catalog = getCatalog(); const now = iso(clock);
    let schemaId = payload.schemaId;
    let versionId;
    transaction(() => {
      if (!schemaId) {
        schemaId = id();
        db.prepare('INSERT INTO tag_schemas(id, catalog_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(schemaId, catalog.id, cleanText(payload.name, 'Schema name'), String(payload.description ?? '').trim().slice(0, 2000), now, now);
      } else if (!db.prepare('SELECT id FROM tag_schemas WHERE id = ? AND catalog_id = ?').get(schemaId, catalog.id)) throw new Error('Schema not found');
      const nextVersion = db.prepare('SELECT coalesce(max(version), 0) + 1 next FROM tag_schema_versions WHERE schema_id = ?').get(schemaId).next;
      versionId = id();
      db.prepare('INSERT INTO tag_schema_versions(id, schema_id, version, definition_json, definition_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(versionId, schemaId, nextVersion, JSON.stringify(definition), definitionHash(definition), now, now);
      seedOptionRows(db, schemaId, definition, { clock, id });
      db.prepare('UPDATE tag_schemas SET updated_at = ? WHERE id = ?').run(now, schemaId);
      changed('schema.draft_created', { schemaId, versionId, version: nextVersion });
    });
    return { schemaId, versionId };
  }

  function publishSchema({ schemaVersionId }) {
    const catalog = getCatalog(); const now = iso(clock);
    const row = db.prepare('SELECT v.*, s.catalog_id FROM tag_schema_versions v JOIN tag_schemas s ON s.id = v.schema_id WHERE v.id = ?').get(schemaVersionId);
    if (!row || row.catalog_id !== catalog.id) throw new Error('Schema version not found');
    transaction(() => {
      db.prepare('UPDATE tag_schema_versions SET published_at = coalesce(published_at, ?), updated_at = ? WHERE id = ?').run(now, now, row.id);
      db.prepare('UPDATE catalogs SET active_schema_version_id = ? WHERE id = ?').run(row.id, catalog.id);
      changed('schema.published', { schemaVersionId: row.id });
    });
    return { schemaVersionId: row.id };
  }

  function saveProvider(payload) {
    const value = validateProvider(payload); const catalog = getCatalog(); const now = iso(clock); const profileId = payload.id ?? id();
    transaction(() => {
      const existing = db.prepare('SELECT id FROM provider_profiles WHERE id = ? AND catalog_id = ?').get(profileId, catalog.id);
      if (existing) db.prepare('UPDATE provider_profiles SET name = ?, dialect = ?, endpoint = ?, model = ?, credential_ref = ?, settings_json = ?, updated_at = ? WHERE id = ?')
        .run(value.name, value.dialect, value.endpoint, value.model, value.credentialRef, JSON.stringify(value.settings), now, profileId);
      else db.prepare('INSERT INTO provider_profiles(id, catalog_id, name, dialect, endpoint, model, credential_ref, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(profileId, catalog.id, value.name, value.dialect, value.endpoint, value.model, value.credentialRef, JSON.stringify(value.settings), now, now);
      if (payload.active !== false) db.prepare('UPDATE catalogs SET active_provider_profile_id = ? WHERE id = ?').run(profileId, catalog.id);
      changed(existing ? 'provider.updated' : 'provider.created', { profileId, dialect: value.dialect, model: value.model });
    });
    return publicProvider(db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(profileId));
  }

  function addTagOption({ schemaVersionId, fieldId, label }) {
    const catalog = getCatalog();
    const schema = db.prepare(`SELECT v.*, s.catalog_id FROM tag_schema_versions v JOIN tag_schemas s ON s.id = v.schema_id WHERE v.id = ?`).get(schemaVersionId ?? catalog.active_schema_version_id);
    if (!schema || schema.catalog_id !== catalog.id) throw new Error('Schema version not found');
    if (schema.id !== catalog.active_schema_version_id) throw new Error('Add values to the active schema version');
    const definition = definitionWithVocabulary(db, schema.schema_id, parse(schema.definition_json));
    const field = definition.fields.find(item => item.id === fieldId);
    if (!field) throw new Error('Tag category not found');
    if (field.type !== 'tags') throw new Error('Free-text categories cannot contain tag values');
    const cleanLabel = cleanText(label, 'Tag label');
    const matching = field.options.find(option => option.label.toLocaleLowerCase() === cleanLabel.toLocaleLowerCase())
      ?? db.prepare('SELECT id, option_key key, label, 1 archived FROM tag_options WHERE schema_id = ? AND field_id = ? AND archived = 1 AND lower(label) = lower(?)').get(schema.schema_id, field.id, cleanLabel);
    if (matching && !matching.archived) throw new Error('That tag already exists in this category');
    if (matching?.archived) {
      const now = iso(clock);
      transaction(() => {
        db.prepare('UPDATE tag_options SET archived = 0, updated_at = ? WHERE id = ?').run(now, matching.id);
        changed('schema.tag_reactivated', { schemaVersionId: schema.id, fieldId: field.id, optionId: matching.id, label: matching.label });
      });
      return { id: matching.id, key: matching.key, label: matching.label };
    }
    const usedKeys = new Set(db.prepare('SELECT option_key FROM tag_options WHERE schema_id = ? AND field_id = ?').all(schema.schema_id, field.id).map(row => row.option_key));
    const key = inferOptionKey(cleanLabel, usedKeys);
    const optionId = id(); const now = iso(clock);
    transaction(() => {
      db.prepare('INSERT INTO tag_options(id, schema_id, field_id, option_key, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(optionId, schema.schema_id, field.id, key, cleanLabel, now, now);
      changed('schema.tag_added', { schemaVersionId: schema.id, fieldId: field.id, optionId, label: cleanLabel });
    });
    return { id: optionId, key, label: cleanLabel };
  }

  function archiveTagOption({ schemaVersionId, fieldId, optionId }) {
    const catalog = getCatalog();
    const schema = db.prepare(`SELECT v.*, s.catalog_id FROM tag_schema_versions v JOIN tag_schemas s ON s.id = v.schema_id WHERE v.id = ?`).get(schemaVersionId ?? catalog.active_schema_version_id);
    if (!schema || schema.catalog_id !== catalog.id) throw new Error('Schema version not found');
    if (schema.id !== catalog.active_schema_version_id) throw new Error('Remove values from the active schema version');
    const definition = definitionWithVocabulary(db, schema.schema_id, parse(schema.definition_json));
    const field = definition.fields.find(item => item.id === fieldId);
    if (!field || field.type !== 'tags') throw new Error('Tag category not found');
    const option = field.options.find(item => item.id === optionId);
    if (!option) throw new Error('Tag value not found');
    if (option.archived) return { id: option.id, key: option.key, label: option.label, archived: true };
    if (field.options.filter(item => !item.archived).length <= 1) throw new Error('A tag category must keep at least one active value');
    const now = iso(clock);
    transaction(() => {
      const updated = db.prepare('UPDATE tag_options SET archived = 1, updated_at = ? WHERE id = ? AND schema_id = ? AND field_id = ?').run(now, option.id, schema.schema_id, field.id);
      if (!updated.changes) throw new Error('Tag value not found');
      changed('schema.tag_archived', { schemaVersionId: schema.id, fieldId: field.id, optionId: option.id, label: option.label });
    });
    return { id: option.id, key: option.key, label: option.label, archived: true };
  }

  function selectedVersions(schemaVersionId, policy, imageVersionIds = null) {
    const base = `SELECT DISTINCT v.id version_id, i.display_path, i.filename,
      ir.relative_path, r.canonical_path root_path
      FROM images i JOIN image_versions v ON v.id = i.current_version_id
      LEFT JOIN image_roots ir ON ir.image_id = i.id AND ir.root_id = (
        SELECT min(ir2.root_id) FROM image_roots ir2 WHERE ir2.image_id = i.id AND ir2.present = 1
      )
      LEFT JOIN roots r ON r.id = ir.root_id
      WHERE i.catalog_id = ? AND i.availability = 'present' AND v.readable = 1`;
    const ids = Array.isArray(imageVersionIds) ? [...new Set(imageVersionIds.map(value => String(value)))] : null;
    const selectedClause = ids?.length ? ` AND v.id IN (${ids.map(() => '?').join(',')})` : '';
    const selectedParameters = ids?.length ? [getCatalog().id, ...ids] : [getCatalog().id];
    if (policy === 'force_all') return db.prepare(`${base}${selectedClause} ORDER BY i.display_path`).all(...selectedParameters).map(row => ({ ...row, display_path: imagePath(row) }));
    if (policy === 'retry_failed') {
      const latestAttemptFailed = `(SELECT ri.state FROM run_items ri JOIN runs latest_run ON latest_run.id = ri.run_id
        WHERE ri.image_version_id = v.id AND latest_run.schema_version_id = ? AND ri.state IN ('succeeded', 'failed')
        ORDER BY ri.updated_at DESC, ri.id DESC LIMIT 1) = 'failed'`;
      return db.prepare(`${base}${selectedClause} AND ${latestAttemptFailed} ORDER BY i.display_path`)
        .all(...selectedParameters, schemaVersionId).map(row => ({ ...row, display_path: imagePath(row) }));
    }
    if (!['new_only', 'stale_only'].includes(policy)) throw new Error('Unknown selection policy');
    const noAccepted = `NOT EXISTS (SELECT 1 FROM tag_revisions tr WHERE tr.image_version_id = v.id AND tr.schema_version_id = ? AND tr.kind = 'accepted')`;
    const proposal = `NOT EXISTS (SELECT 1 FROM tag_revisions tr WHERE tr.image_version_id = v.id AND tr.schema_version_id = ? AND tr.kind = 'proposal')`;
    const stale = policy === 'stale_only' ? `AND EXISTS (
      SELECT 1 FROM image_versions old_v JOIN tag_revisions old_tr ON old_tr.image_version_id = old_v.id
      WHERE old_v.image_id = i.id AND old_v.id <> v.id AND old_tr.schema_version_id = ? AND old_tr.kind = 'accepted'
    )` : '';
    const parameters = [...selectedParameters, schemaVersionId, schemaVersionId];
    if (policy === 'stale_only') parameters.push(schemaVersionId);
    return db.prepare(`${base}${selectedClause} AND ${noAccepted} AND ${proposal} ${stale} ORDER BY i.display_path`).all(...parameters).map(row => ({ ...row, display_path: imagePath(row) }));
  }

  function startRun(payload) {
    const catalog = getCatalog();
    const schema = db.prepare('SELECT * FROM tag_schema_versions WHERE id = ? AND published_at IS NOT NULL').get(payload.schemaVersionId ?? catalog.active_schema_version_id);
    const providerRow = db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(payload.providerProfileId ?? catalog.active_provider_profile_id);
    if (!schema) throw new Error('Publish and activate a schema before tagging');
    if (!providerRow) throw new Error('Configure a provider before tagging');
    const profile = { ...publicProvider(providerRow), settings: parse(providerRow.settings_json, {}) };
    const definition = definitionWithVocabulary(db, schema.schema_id, parse(schema.definition_json), { includeArchived: false });
    const policy = payload.selectionPolicy ?? 'new_only';
    const imageVersionIds = payload.imageVersionIds === undefined ? null : payload.imageVersionIds;
    if (imageVersionIds !== null && (!Array.isArray(imageVersionIds) || !imageVersionIds.length || imageVersionIds.length > 500)) throw new Error('Select between 1 and 500 images for selected tagging');
    const items = selectedVersions(schema.id, policy, imageVersionIds);
    const runId = id(); const now = iso(clock);
    const promptSnapshot = { definitionHash: definitionHash(definition), schemaDefinition: definition,
      extraInstructions: profile.settings.extraInstructions ?? '',
      imageTagging: effectivePromptTemplate('imageTagging', profile.settings.promptTemplates?.imageTagging) };
    transaction(() => {
      db.prepare(`INSERT INTO runs(id, catalog_id, schema_version_id, provider_profile_id, provider_snapshot_json, prompt_snapshot_json, image_preset, selection_policy, status, total_items, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(runId, catalog.id, schema.id, profile.id, JSON.stringify(profile), JSON.stringify(promptSnapshot), profile.settings.imagePreset, policy, items.length, now);
      const insert = db.prepare("INSERT INTO run_items(id, run_id, image_version_id, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)");
      for (const item of items) insert.run(id(), runId, item.version_id, now, now);
      changed('run.created', { runId, totalItems: items.length });
    });
    const credential = payload.credential;
    queueMicrotask(() => processRun(runId, { credential }).catch(error => emit('run.error', { runId, error: error.message })));
    return { runId, totalItems: items.length };
  }

  function selectedDetectionVersions(imageVersionIds) {
    if (!Array.isArray(imageVersionIds) || !imageVersionIds.length || imageVersionIds.length > 500) throw new Error('Select between 1 and 500 images for object detection');
    const ids = [...new Set(imageVersionIds.map(value => String(value)))];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT DISTINCT v.id version_id, i.display_path, i.filename,
      ir.relative_path, r.canonical_path root_path
      FROM images i JOIN image_versions v ON v.id = i.current_version_id
      LEFT JOIN image_roots ir ON ir.image_id = i.id AND ir.root_id = (
        SELECT min(ir2.root_id) FROM image_roots ir2 WHERE ir2.image_id = i.id AND ir2.present = 1
      )
      LEFT JOIN roots r ON r.id = ir.root_id
      WHERE i.catalog_id = ? AND i.availability = 'present' AND v.readable = 1 AND v.id IN (${placeholders})
      ORDER BY i.display_path`).all(getCatalog().id, ...ids).map(row => ({ ...row, display_path: imagePath(row) }));
  }

  function startDetectionRun(payload) {
    const catalog = getCatalog();
    const providerRow = db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(payload.providerProfileId ?? catalog.active_provider_profile_id);
    if (!providerRow) throw new Error('Configure a provider before object detection');
    const profile = { ...publicProvider(providerRow), settings: parse(providerRow.settings_json, {}) };
    const items = selectedDetectionVersions(payload.imageVersionIds);
    if (!items.length) throw new Error('None of the selected images are available for object detection');
    const settings = providerSettings(profile.settings);
    const runId = id(); const now = iso(clock);
    const promptSnapshot = { outputSchema: DETECTION_OUTPUT_SCHEMA, coordinateSpace: 'normalized_0_1_top_left',
      maxFaces: MAX_DETECTION_FACES, maxObjects: MAX_DETECTION_OBJECTS,
      detection: effectivePromptTemplate('detection', settings.promptTemplates?.detection) };
    transaction(() => {
      db.prepare(`INSERT INTO detection_runs(id, catalog_id, provider_profile_id, provider_snapshot_json, prompt_snapshot_json, image_preset, status, total_items, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(runId, catalog.id, profile.id, JSON.stringify(profile), JSON.stringify(promptSnapshot), settings.imagePreset, items.length, now);
      const insert = db.prepare('INSERT INTO detection_run_items(id, run_id, image_version_id, state, created_at, updated_at) VALUES (?, ?, ?, \'queued\', ?, ?)');
      for (const item of items) insert.run(id(), runId, item.version_id, now, now);
      changed('detection.created', { runId, totalItems: items.length });
    });
    queueMicrotask(() => processDetectionRun(runId, { credential: payload.credential }).catch(error => emit('detection.error', { runId, error: error.message })));
    return { runId, totalItems: items.length };
  }

  async function processDetectionRun(runId, { credential }) {
    const controller = new AbortController(); controllers.set(`detection:${runId}`, controller);
    const run = db.prepare('SELECT * FROM detection_runs WHERE id = ?').get(runId);
    const profile = parse(run.provider_snapshot_json); const settings = providerSettings(profile.settings);
    const promptSnapshot = parse(run.prompt_snapshot_json, {});
    let provider;
    try { provider = providerFactory(profile, credential, logger); }
    catch (error) {
      const errorText = JSON.stringify({ dialect: profile.dialect, model: profile.model, error: { name: error.name ?? 'Error', message: error.message ?? String(error) } }).slice(0, 2000);
      transaction(() => {
        db.prepare("UPDATE detection_runs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?").run(errorText, iso(clock), runId);
        db.prepare("UPDATE detection_run_items SET state = 'failed', error_message = ?, updated_at = ? WHERE run_id = ?").run(errorText, iso(clock), runId);
        changed('detection.failed', { runId, error: errorText });
      });
      emit('detection.complete', { runId, status: 'failed' }); controllers.delete(`detection:${runId}`); return;
    }
    db.prepare("UPDATE detection_runs SET status = 'running', started_at = ? WHERE id = ?").run(iso(clock), runId);
    emit('detection.progress', { runId, status: 'running', completedItems: 0, totalItems: run.total_items });
    const items = db.prepare(`SELECT dri.*, v.image_id, v.width, v.height, i.display_path, i.filename,
      ir.relative_path, r.canonical_path root_path
      FROM detection_run_items dri JOIN image_versions v ON v.id = dri.image_version_id JOIN images i ON i.id = v.image_id
      LEFT JOIN image_roots ir ON ir.image_id = i.id AND ir.root_id = (
        SELECT min(ir2.root_id) FROM image_roots ir2 WHERE ir2.image_id = i.id AND ir2.present = 1
      )
      LEFT JOIN roots r ON r.id = ir.root_id
      WHERE dri.run_id = ? ORDER BY i.display_path`).all(runId).map(row => ({ ...row, display_path: imagePath(row) }));
    let consecutiveFailures = 0;
    for (const item of items) {
      if (controller.signal.aborted) break;
      const started = Date.now();
      db.prepare("UPDATE detection_run_items SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(iso(clock), item.id);
      try {
        const image = await prepareImage(item.display_path, { preset: settings.imagePreset });
        const schemaVersionId = getCatalog().active_schema_version_id;
        const metadataRow = schemaVersionId ? db.prepare(`SELECT
          (SELECT tr.values_json FROM tag_revisions tr WHERE tr.id = at.accepted_revision_id) accepted_json,
          (SELECT tr.values_json FROM tag_revisions tr WHERE tr.image_version_id = ? AND tr.schema_version_id = ? AND tr.kind = 'proposal' ORDER BY tr.created_at DESC LIMIT 1) proposal_json
          FROM active_tags at WHERE at.image_version_id = ? AND at.schema_version_id = ?`).get(item.image_version_id, schemaVersionId, item.image_version_id, schemaVersionId) : null;
        const metadata = parse(metadataRow?.accepted_json) ?? parse(metadataRow?.proposal_json) ?? {};
        const prompt = renderPrompt('detection', { filename: item.filename, relativePath: item.relative_path ?? item.filename,
          metadataJson: JSON.stringify(metadata), maxFaces: String(MAX_DETECTION_FACES), maxObjects: String(MAX_DETECTION_OBJECTS) },
          promptSnapshot.detection ? { systemText: promptSnapshot.detection.systemText, userText: promptSnapshot.detection.userText } : settings.promptTemplates?.detection);
        const result = await provider.generateTags({
          model: profile.model,
          image,
          systemText: prompt.systemText,
          userText: prompt.userText,
          outputSchema: DETECTION_OUTPUT_SCHEMA,
          signal: controller.signal
        });
        const values = validateDetectionValues(result.values, metadata);
        const resultId = id(); const now = iso(clock);
        transaction(() => {
          db.prepare(`INSERT INTO image_detection_results(id, image_version_id, detection_run_item_id, coordinates_json, provenance_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(resultId, item.image_version_id, item.id, JSON.stringify(values), JSON.stringify({ provider: profile.dialect, model: result.providerModel, requestId: result.providerRequestId, sourceWidth: item.width ?? null, sourceHeight: item.height ?? null, preparedWidth: image.width, preparedHeight: image.height, coordinateSpace: 'normalized_0_1_top_left' }), now);
          db.prepare("UPDATE detection_run_items SET state = 'succeeded', result_id = ?, source_width = ?, source_height = ?, prepared_width = ?, prepared_height = ?, usage_json = ?, updated_at = ? WHERE id = ?")
            .run(resultId, item.width ?? null, item.height ?? null, image.width, image.height, JSON.stringify(result.usage), now, item.id);
          db.prepare('UPDATE detection_runs SET completed_items = completed_items + 1 WHERE id = ?').run(runId);
        });
        consecutiveFailures = 0;
      } catch (error) {
        if (controller.signal.aborted) break;
        consecutiveFailures++;
        const requestContext = error?.requestContext ?? { dialect: profile.dialect, model: profile.model, image: { path: item.display_path, filename: item.filename, relativePath: item.relative_path }, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) } };
        const errorText = JSON.stringify({ dialect: requestContext.dialect ?? profile.dialect, model: requestContext.model ?? profile.model, image: requestContext.image, error: requestContext.error }).slice(0, 2000);
        db.prepare("UPDATE detection_run_items SET state = 'failed', error_message = ?, updated_at = ? WHERE id = ?").run(errorText, iso(clock), item.id);
        db.prepare('UPDATE detection_runs SET completed_items = completed_items + 1, failed_items = failed_items + 1 WHERE id = ?').run(runId);
        if (consecutiveFailures >= 5) {
          db.prepare("UPDATE detection_run_items SET state = 'failed', error_message = ?, updated_at = ? WHERE run_id = ? AND state = 'queued'").run('Stopped after five consecutive failures', iso(clock), runId);
          break;
        }
      }
      const progress = db.prepare('SELECT status, completed_items, failed_items, total_items FROM detection_runs WHERE id = ?').get(runId);
      emit('detection.progress', { runId, ...progress });
    }
    const canceled = controller.signal.aborted;
    const remaining = db.prepare("SELECT count(*) count FROM detection_run_items WHERE run_id = ? AND state = 'queued'").get(runId).count;
    const failed = db.prepare("SELECT count(*) count FROM detection_run_items WHERE run_id = ? AND state = 'failed'").get(runId).count;
    const finalStatus = canceled ? 'canceled' : (remaining || (failed && failed === run.total_items) ? 'failed' : 'completed');
    transaction(() => {
      if (canceled) db.prepare("UPDATE detection_run_items SET state = 'canceled', updated_at = ? WHERE run_id = ? AND state IN ('queued', 'running')").run(iso(clock), runId);
      db.prepare('UPDATE detection_runs SET status = ?, failed_items = ?, completed_items = total_items, finished_at = ?, error_message = ? WHERE id = ?')
        .run(finalStatus, failed, iso(clock), remaining ? 'Stopped after five consecutive failures' : null, runId);
      changed(`detection.${finalStatus}`, { runId, failedItems: failed });
    });
    controllers.delete(`detection:${runId}`);
    emit('detection.complete', { runId, status: finalStatus, failedItems: failed });
  }

  async function processRun(runId, { credential }) {
    const controller = new AbortController(); controllers.set(runId, controller);
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    const schema = db.prepare('SELECT * FROM tag_schema_versions WHERE id = ?').get(run.schema_version_id);
    const promptSnapshot = parse(run.prompt_snapshot_json, {});
    const definition = promptSnapshot.schemaDefinition ?? definitionWithVocabulary(db, schema.schema_id, parse(schema.definition_json));
    const profile = parse(run.provider_snapshot_json); const settings = providerSettings(profile.settings);
    let provider;
    try { provider = providerFactory(profile, credential, logger); }
    catch (error) {
      const debug = { dialect: profile.dialect, model: profile.model, provider: { name: profile.name, endpoint: profile.endpoint }, error: { name: error.name ?? 'Error', message: error.message ?? String(error) } };
      const errorText = JSON.stringify(debug).slice(0, 2000);
      transaction(() => {
        db.prepare("UPDATE runs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?").run(errorText, iso(clock), runId);
        db.prepare("UPDATE run_items SET state = 'failed', error_category = 'configuration', error_message = ?, updated_at = ? WHERE run_id = ?").run(errorText, iso(clock), runId);
        changed('run.failed', { runId, error: errorText });
      });
      emit('run.complete', { runId, status: 'failed' }); controllers.delete(runId); return;
    }
    db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(iso(clock), runId);
    emit('run.progress', { runId, status: 'running', completedItems: 0, totalItems: run.total_items });
    const items = db.prepare(`SELECT ri.*, v.image_id, i.display_path, i.filename,
      ir.relative_path, r.canonical_path root_path
      FROM run_items ri JOIN image_versions v ON v.id = ri.image_version_id JOIN images i ON i.id = v.image_id
      LEFT JOIN image_roots ir ON ir.image_id = i.id AND ir.root_id = (
        SELECT min(ir2.root_id) FROM image_roots ir2 WHERE ir2.image_id = i.id AND ir2.present = 1
      )
      LEFT JOIN roots r ON r.id = ir.root_id
      WHERE ri.run_id = ? ORDER BY i.display_path`).all(runId).map(row => ({ ...row, display_path: imagePath(row) }));
    let consecutiveFailures = 0;
    for (const item of items) {
      if (controller.signal.aborted) break;
      const started = Date.now();
      db.prepare("UPDATE run_items SET state = 'running', attempt_count = attempt_count + 1, lease_at = ?, updated_at = ? WHERE id = ?").run(iso(clock), iso(clock), item.id);
      try {
        const image = await prepareImage(item.display_path, { preset: settings.imagePreset });
        const request = compileTaggingRequest({ definition, filename: item.filename, relativePath: item.relative_path,
          extraInstructions: settings.extraInstructions,
          promptTemplate: promptSnapshot.imageTagging ? { systemText: promptSnapshot.imageTagging.systemText, userText: promptSnapshot.imageTagging.userText } : settings.promptTemplates?.imageTagging });
        const result = await provider.generateTags({ model: profile.model, image, ...request, signal: controller.signal });
        const values = validateTagValues(definition, result.values);
        const revisionId = id(); const now = iso(clock);
        transaction(() => {
          db.prepare(`INSERT INTO tag_revisions(id, image_version_id, schema_version_id, origin, kind, run_item_id, values_json, provenance_json, created_at)
            VALUES (?, ?, ?, 'ai_proposal', 'proposal', ?, ?, ?, ?)`).run(revisionId, item.image_version_id, schema.id, item.id, JSON.stringify(values), JSON.stringify({ provider: profile.dialect, model: result.providerModel, requestId: result.providerRequestId, preset: settings.imagePreset }), now);
          db.prepare(`INSERT INTO active_tags(image_version_id, schema_version_id, accepted_revision_id, review_state, updated_at) VALUES (?, ?, NULL, 'needs_review', ?)
            ON CONFLICT(image_version_id, schema_version_id) DO UPDATE SET review_state = 'needs_review', updated_at = excluded.updated_at`).run(item.image_version_id, schema.id, now);
          db.prepare("UPDATE run_items SET state = 'succeeded', proposal_revision_id = ?, timing_json = ?, usage_json = ?, updated_at = ? WHERE id = ?")
            .run(revisionId, JSON.stringify({ durationMs: Date.now() - started, encodedBytes: image.encodedBytes }), JSON.stringify(result.usage), now, item.id);
          db.prepare('UPDATE runs SET completed_items = completed_items + 1 WHERE id = ?').run(runId);
        });
        consecutiveFailures = 0;
      } catch (error) {
        if (controller.signal.aborted) break;
        consecutiveFailures++;
        const requestContext = error?.requestContext ?? {
          dialect: profile.dialect,
          model: profile.model,
          image: { path: item.display_path, filename: item.filename, relativePath: item.relative_path },
          error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) }
        };
        const debug = {
          dialect: requestContext.dialect ?? profile.dialect,
          model: requestContext.model ?? profile.model,
          provider: { name: profile.name, endpoint: profile.endpoint },
          image: requestContext.image ?? { path: item.display_path, filename: item.filename, relativePath: item.relative_path },
          error: requestContext.error ?? { name: error?.name ?? 'Error', message: error?.message ?? String(error) }
        };
        const errorText = JSON.stringify(debug).slice(0, 2000);
        db.prepare("UPDATE run_items SET state = 'failed', error_category = 'provider', error_message = ?, timing_json = ?, updated_at = ? WHERE id = ?")
          .run(errorText, JSON.stringify({ durationMs: Date.now() - started }), iso(clock), item.id);
        db.prepare('UPDATE runs SET completed_items = completed_items + 1, failed_items = failed_items + 1 WHERE id = ?').run(runId);
        if (consecutiveFailures >= 5) {
          db.prepare("UPDATE run_items SET state = 'failed', error_category = 'circuit_breaker', error_message = ?, updated_at = ? WHERE run_id = ? AND state = 'queued'")
            .run('Stopped after five consecutive failures', iso(clock), runId);
          break;
        }
      }
      const progress = db.prepare('SELECT status, completed_items, failed_items, total_items FROM runs WHERE id = ?').get(runId);
      emit('run.progress', { runId, ...progress });
    }
    const canceled = controller.signal.aborted;
    const remaining = db.prepare("SELECT count(*) count FROM run_items WHERE run_id = ? AND state = 'queued'").get(runId).count;
    const failed = db.prepare("SELECT count(*) count FROM run_items WHERE run_id = ? AND state = 'failed'").get(runId).count;
    const finalStatus = canceled ? 'canceled' : (remaining || (failed && failed === run.total_items) ? 'failed' : 'completed');
    transaction(() => {
      if (canceled) db.prepare("UPDATE run_items SET state = 'canceled', updated_at = ? WHERE run_id = ? AND state IN ('queued', 'running')").run(iso(clock), runId);
      db.prepare('UPDATE runs SET status = ?, failed_items = ?, completed_items = total_items, finished_at = ?, error_message = ? WHERE id = ?')
        .run(finalStatus, failed, iso(clock), remaining ? 'Stopped after five consecutive failures' : null, runId);
      changed(`run.${finalStatus}`, { runId, failedItems: failed });
    });
    controllers.delete(runId);
    emit('run.complete', { runId, status: finalStatus, failedItems: failed });
  }

  function cancelRun({ runId }) {
    const controller = controllers.get(runId);
    if (!controller) throw new Error('Run is not active');
    controller.abort();
    return { runId, cancelRequested: true };
  }

  function cancelDetectionRun({ runId }) {
    const controller = controllers.get(`detection:${runId}`);
    if (!controller) throw new Error('Object detection run is not active');
    controller.abort();
    return { runId, cancelRequested: true };
  }

  function accept({ imageVersionId, values }) {
    const catalog = getCatalog(); const schema = db.prepare('SELECT * FROM tag_schema_versions WHERE id = ?').get(catalog.active_schema_version_id);
    if (!schema) throw new Error('No active schema');
    const definition = definitionWithVocabulary(db, schema.schema_id, parse(schema.definition_json));
    const proposal = db.prepare("SELECT * FROM tag_revisions WHERE image_version_id = ? AND schema_version_id = ? AND kind = 'proposal' ORDER BY created_at DESC LIMIT 1").get(imageVersionId, schema.id);
    if (!proposal && values === undefined) throw new Error('No proposal is available to accept');
    const active = db.prepare('SELECT accepted_revision_id FROM active_tags WHERE image_version_id = ? AND schema_version_id = ?').get(imageVersionId, schema.id);
    const normalized = validateTagValues(definition, values ?? parse(proposal.values_json));
    const revisionId = id(); const now = iso(clock);
    transaction(() => {
      db.prepare(`INSERT INTO tag_revisions(id, image_version_id, schema_version_id, parent_revision_id, origin, kind, values_json, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`).run(revisionId, imageVersionId, schema.id, active?.accepted_revision_id ?? proposal?.id ?? null, values === undefined ? 'ai_accept' : 'manual', JSON.stringify(normalized), JSON.stringify({ reviewed: true }), now);
      db.prepare(`INSERT INTO active_tags(image_version_id, schema_version_id, accepted_revision_id, review_state, updated_at) VALUES (?, ?, ?, 'accepted', ?)
        ON CONFLICT(image_version_id, schema_version_id) DO UPDATE SET accepted_revision_id = excluded.accepted_revision_id, review_state = 'accepted', updated_at = excluded.updated_at`)
        .run(imageVersionId, schema.id, revisionId, now);
      changed('tags.accepted', { imageVersionId, schemaVersionId: schema.id, revisionId });
    });
    return { revisionId, values: normalized };
  }

  function bulkAccept({ imageVersionIds, changes }) {
    const catalog = getCatalog();
    const schema = db.prepare('SELECT * FROM tag_schema_versions WHERE id = ?').get(catalog.active_schema_version_id);
    if (!schema) throw new Error('No active schema');
    if (!Array.isArray(imageVersionIds) || !imageVersionIds.length) throw new Error('Select at least one image');
    const ids = [...new Set(imageVersionIds.map(value => String(value)))];
    if (ids.length !== imageVersionIds.length) throw new Error('Duplicate images were selected');
    if (ids.length > 1000) throw new Error('Bulk editing is limited to 1,000 images at a time');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Bulk changes are required');

    const definition = definitionWithVocabulary(db, schema.schema_id, parse(schema.definition_json));
    const fields = new Map(definition.fields.map(field => [field.key, field]));
    for (const key of Object.keys(changes)) if (!fields.has(key)) throw new Error(`Unknown bulk edit field: ${key}`);
    const selected = db.prepare(`SELECT v.id version_id FROM image_versions v JOIN images i ON i.id = v.image_id
      WHERE i.catalog_id = ? AND v.id IN (${ids.map(() => '?').join(',')})`).all(catalog.id, ...ids);
    if (selected.length !== ids.length) throw new Error('One or more selected images are not in this catalog');

    const accepted = db.prepare('SELECT accepted_revision_id FROM active_tags WHERE image_version_id = ? AND schema_version_id = ?');
    const revision = db.prepare('SELECT * FROM tag_revisions WHERE id = ? AND kind = \'accepted\'');
    const proposal = db.prepare("SELECT * FROM tag_revisions WHERE image_version_id = ? AND schema_version_id = ? AND kind = 'proposal' ORDER BY created_at DESC LIMIT 1");
    const emptyValues = () => Object.fromEntries(definition.fields.map(field => [field.key, field.type === 'tags' ? [] : null]));
    const now = iso(clock);
    const createdRevisionIds = [];

    transaction(() => {
      for (const imageVersionId of ids) {
        const active = accepted.get(imageVersionId, schema.id);
        const parent = active?.accepted_revision_id ? revision.get(active.accepted_revision_id) : proposal.get(imageVersionId, schema.id);
        const values = validateTagValues(definition, parent ? parse(parent.values_json) : emptyValues());
        for (const [key, change] of Object.entries(changes)) {
          const field = fields.get(key);
          if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error(`Invalid bulk change for ${field.label}`);
          if (field.type === 'tags') {
            const add = Array.isArray(change.add) ? change.add : [];
            const remove = Array.isArray(change.remove) ? change.remove : [];
            const allowed = new Set(field.options.map(option => option.key));
            if ([...add, ...remove].some(option => typeof option !== 'string' || !allowed.has(option))) throw new Error(`${field.label} contains an unknown option`);
            values[key] = field.options.filter(option => {
              const current = values[key].includes(option.key);
              if (remove.includes(option.key)) return false;
              if (add.includes(option.key)) return true;
              return current;
            }).map(option => option.key);
          } else if (Object.prototype.hasOwnProperty.call(change, 'set')) {
            values[key] = change.set;
          } else throw new Error(`Invalid bulk change for ${field.label}`);
        }
        const normalized = validateTagValues(definition, values);
        const revisionId = id(); createdRevisionIds.push(revisionId);
        db.prepare(`INSERT INTO tag_revisions(id, image_version_id, schema_version_id, parent_revision_id, origin, kind, values_json, provenance_json, created_at)
          VALUES (?, ?, ?, ?, 'bulk', 'accepted', ?, ?, ?)`).run(revisionId, imageVersionId, schema.id, parent?.id ?? null, JSON.stringify(normalized), JSON.stringify({ reviewed: true, bulk: true, imageCount: ids.length }), now);
        db.prepare(`INSERT INTO active_tags(image_version_id, schema_version_id, accepted_revision_id, review_state, updated_at) VALUES (?, ?, ?, 'accepted', ?)
          ON CONFLICT(image_version_id, schema_version_id) DO UPDATE SET accepted_revision_id = excluded.accepted_revision_id, review_state = excluded.review_state, updated_at = excluded.updated_at`)
          .run(imageVersionId, schema.id, revisionId, now);
      }
      changed('tags.bulk_accepted', { schemaVersionId: schema.id, imageCount: ids.length, imageVersionIds: ids });
    });
    return { count: ids.length, revisionIds: createdRevisionIds };
  }

  function undoAcceptance({ imageVersionId }) {
    const schemaVersionId = getCatalog().active_schema_version_id;
    const active = db.prepare(`SELECT at.accepted_revision_id, tr.parent_revision_id
      FROM active_tags at JOIN tag_revisions tr ON tr.id = at.accepted_revision_id
      WHERE at.image_version_id = ? AND at.schema_version_id = ?`).get(imageVersionId, schemaVersionId);
    if (!active) throw new Error('There is no accepted revision to undo');
    const parent = active.parent_revision_id ? db.prepare("SELECT id FROM tag_revisions WHERE id = ? AND kind = 'accepted'").get(active.parent_revision_id) : null;
    const now = iso(clock);
    transaction(() => {
      db.prepare('UPDATE active_tags SET accepted_revision_id = ?, review_state = ?, updated_at = ? WHERE image_version_id = ? AND schema_version_id = ?')
        .run(parent?.id ?? null, parent ? 'accepted' : 'needs_review', now, imageVersionId, schemaVersionId);
      changed('tags.acceptance_undone', { imageVersionId, schemaVersionId, fromRevisionId: active.accepted_revision_id, toRevisionId: parent?.id ?? null });
    });
    return { acceptedRevisionId: parent?.id ?? null, reviewState: parent ? 'accepted' : 'needs_review' };
  }

  function activeSchema() {
    const schemaVersionId = getCatalog().active_schema_version_id;
    const row = db.prepare('SELECT schema_id, definition_json FROM tag_schema_versions WHERE id = ?').get(schemaVersionId);
    if (!row) throw new Error('No active schema');
    return { id: schemaVersionId, definition: definitionWithVocabulary(db, row.schema_id, parse(row.definition_json)) };
  }

  function getEmbeddingModel({ allowDownload }) {
    if (!embeddingModelPromise) {
      embeddingModelPromise = embeddingFactory({
        cacheDirectory: modelCachePath,
        allowDownload,
        progress: value => emit('embedding.model.progress', { progress: value })
      }).catch(error => { embeddingModelPromise = null; throw error; });
    }
    return embeddingModelPromise;
  }

  function failEmbeddingRun(runId, error) {
    const message = String(error?.message ?? error).slice(0, 2000);
    transaction(() => {
      const now = iso(clock);
      db.prepare("UPDATE embedding_run_items SET state = 'failed', error_message = ?, updated_at = ? WHERE run_id = ? AND state IN ('queued', 'running')").run(message, now, runId);
      db.prepare("UPDATE embedding_runs SET status = 'failed', completed_items = total_items, failed_items = total_items, error_message = ?, finished_at = ? WHERE id = ?").run(message, now, runId);
    });
    emit('embedding.complete', { runId, status: 'failed', error: message });
  }

  function startEmbeddingUpdate() {
    const catalog = getCatalog();
    if (db.prepare("SELECT 1 FROM embedding_runs WHERE catalog_id = ? AND status IN ('queued', 'running')").get(catalog.id)) throw new Error('An embedding update is already running');
    const schema = activeSchema();
    const profile = transaction(() => ensureEmbeddingProfile({ db, catalogId: catalog.id, id, clock, profile: BGE_SMALL_PROFILE }));
    const result = createEmbeddingRun({ db, transaction, catalogId: catalog.id, schemaVersionId: schema.id, definition: schema.definition, profile, id, clock });
    changed('embeddings.update_started', { profileId: profile.id, runId: result.runId, totalItems: result.totalItems, reusedItems: result.reusedItems });
    if (!result.runId) return result;
    const controller = new AbortController();
    controllers.set(`embedding:${result.runId}`, controller);
    queueMicrotask(async () => {
      try {
        const embeddingModel = await getEmbeddingModel({ allowDownload: true });
        await processEmbeddingRun({ db, transaction, runId: result.runId, embeddingModel, clock, signal: controller.signal, emit });
      } catch (error) {
        failEmbeddingRun(result.runId, error);
      } finally {
        controllers.delete(`embedding:${result.runId}`);
      }
    });
    return result;
  }

  function cancelEmbeddingRun({ runId }) {
    const controller = controllers.get(`embedding:${runId}`);
    if (!controller) throw new Error('Embedding run is not active');
    controller.abort();
    return { runId, cancelRequested: true };
  }

  async function hybridSearch(payload) {
    const catalog = getCatalog();
    if (!catalog.active_embedding_profile_id) throw new Error('Run Update embeddings before searching');
    const profile = db.prepare('SELECT * FROM embedding_profiles WHERE id = ?').get(catalog.active_embedding_profile_id);
    if (!profile) throw new Error('The active embedding profile is unavailable');
    const schema = activeSchema();
    const embeddingModel = await getEmbeddingModel({ allowDownload: false });
    const response = await searchHybridImages({ db, catalogId: catalog.id, schemaVersionId: schema.id, profile, definition: schema.definition, query: payload, embeddingModel });
    if (!response.ok) return { ...response, selectionPacket: null };
    return {
      ...response,
      selectionPacket: buildSelectionPacket({
        definition: schema.definition,
        searchResponse: response,
        context: { spokenText: payload.spokenText, paragraphContext: payload.paragraphContext, videoTheme: payload.videoTheme }
      })
    };
  }

  function brollEmbeddingReadiness(catalog, schemaVersionId) {
    const profile = catalog.active_embedding_profile_id
      ? db.prepare('SELECT * FROM embedding_profiles WHERE id = ?').get(catalog.active_embedding_profile_id) : null;
    const acceptedItems = db.prepare(`SELECT count(*) count FROM images i
      JOIN image_versions v ON v.id = i.current_version_id
      JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = ?
        AND at.review_state = 'accepted' AND at.accepted_revision_id IS NOT NULL
      WHERE i.catalog_id = ? AND i.active = 1 AND i.availability = 'present'`).get(schemaVersionId, catalog.id).count;
    const indexedItems = profile ? db.prepare(`SELECT count(*) count FROM images i
      JOIN image_versions v ON v.id = i.current_version_id
      JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = ?
        AND at.review_state = 'accepted' AND at.accepted_revision_id IS NOT NULL
      JOIN retrieval_documents rd ON rd.image_version_id = v.id AND rd.schema_version_id = at.schema_version_id
        AND rd.tag_revision_id = at.accepted_revision_id
      JOIN retrieval_embeddings re ON re.tag_revision_id = rd.tag_revision_id
        AND re.retrieval_text_hash = rd.retrieval_text_hash AND re.profile_id = ?
      WHERE i.catalog_id = ? AND i.active = 1 AND i.availability = 'present'`).get(schemaVersionId, profile.id, catalog.id).count : 0;
    const currentProfile = Boolean(profile && profile.runtime === BGE_SMALL_PROFILE.runtime && profile.model === BGE_SMALL_PROFILE.model &&
      profile.model_revision === BGE_SMALL_PROFILE.modelRevision && profile.model_dtype === BGE_SMALL_PROFILE.modelDtype &&
      profile.dimension === BGE_SMALL_PROFILE.dimension && profile.pooling === BGE_SMALL_PROFILE.pooling &&
      Boolean(profile.normalized) === BGE_SMALL_PROFILE.normalized && profile.query_prefix === BGE_SMALL_PROFILE.queryPrefix &&
      profile.retrieval_text_version === RETRIEVAL_TEXT_VERSION);
    const updating = Boolean(db.prepare("SELECT 1 FROM embedding_runs WHERE catalog_id = ? AND status IN ('queued', 'running')").get(catalog.id));
    return { profileId: profile?.id ?? null, acceptedItems, indexedItems, staleItems: Math.max(0, acceptedItems - indexedItems), currentProfile, updating };
  }

  async function brollSearchReadiness() {
    const catalog = getCatalog();
    const schema = activeSchema();
    const readiness = brollEmbeddingReadiness(catalog, schema.id);
    if (!readiness.currentProfile || readiness.staleItems || readiness.updating) return {
      ok: false, code: 'search_not_ready', catalogId: catalog.id,
      message: readiness.updating ? 'Wait for the embedding update to finish before B-roll planning.' : 'Update embeddings for every present accepted image before B-roll planning.',
      readiness, action: readiness.updating ? 'wait' : 'embeddings.update'
    };
    try { await getEmbeddingModel({ allowDownload: false }); }
    catch (error) { return { ok: false, code: 'search_not_ready', catalogId: catalog.id,
      message: `Local embedding model unavailable: ${error.message}`, readiness, action: 'prepare_model' }; }
    return { ok: true, catalogId: catalog.id, readiness };
  }

  async function brollSearch(payload) {
    const catalog = getCatalog();
    const schema = activeSchema();
    const query = validateHybridQuery(schema.definition, payload, { mode: 'broll' });
    const ready = await brollSearchReadiness();
    if (!ready.ok) return { ...ready, query, results: [], selectionPacket: null };
    const { readiness } = ready;
    const profile = db.prepare('SELECT * FROM embedding_profiles WHERE id = ?').get(readiness.profileId);
    const embeddingModel = await getEmbeddingModel({ allowDownload: false });
    const response = await searchHybridImages({ db, catalogId: catalog.id, schemaVersionId: schema.id, profile,
      definition: schema.definition, query: payload, embeddingModel, mode: 'broll' });
    return { ...response, readiness, selectionPacket: buildSelectionPacket({ definition: schema.definition, searchResponse: response,
      context: { spokenText: payload.spokenText, paragraphContext: payload.paragraphContext, videoTheme: payload.videoTheme } }) };
  }

  function changeImageActivity({ imageIds, active }) {
    const catalog = getCatalog();
    const result = setImagesActive({ db, transaction, catalogId: catalog.id, imageIds, active: Boolean(active), clock });
    changed(active ? 'images.reactivated' : 'images.deactivated', { imageIds, count: result.count });
    return result;
  }

  function searchAccepted({ query = '', filters = {}, limit = 50 } = {}) {
    const schemaVersionId = getCatalog().active_schema_version_id;
    const schema = db.prepare('SELECT schema_id, definition_json FROM tag_schema_versions WHERE id = ?').get(schemaVersionId);
    if (!schema) throw new Error('No active schema');
    const definition = definitionWithVocabulary(db, schema.schema_id, parse(schema.definition_json));
    const fields = new Map(definition.fields.map(field => [field.key, field]));
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('Search filters must be an object');
    for (const key of Object.keys(filters)) if (!fields.has(key)) throw new Error(`Unknown search field: ${key}`);
    const words = String(query).toLocaleLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean).slice(0, 50);
    const rows = db.prepare(`SELECT i.id image_id, i.display_path, i.filename, v.id image_version_id,
      r.canonical_path root_path, ir.relative_path,
      tr.id revision_id, tr.values_json
      FROM images i JOIN image_versions v ON v.id = i.current_version_id
      LEFT JOIN image_roots ir ON ir.image_id = i.id AND ir.root_id = (
        SELECT min(ir2.root_id) FROM image_roots ir2 WHERE ir2.image_id = i.id AND ir2.present = 1
      )
      LEFT JOIN roots r ON r.id = ir.root_id
      JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = ? AND at.review_state = 'accepted'
      JOIN tag_revisions tr ON tr.id = at.accepted_revision_id
      WHERE i.catalog_id = ? AND i.active = 1 AND i.availability = 'present'`).all(schemaVersionId, getCatalog().id);
    const results = [];
    for (const row of rows) {
      const values = parse(row.values_json);
      const matches = Object.entries(filters).every(([key, wanted]) => {
        const actual = values[key]; const expected = Array.isArray(wanted) ? wanted : [wanted];
        return Array.isArray(actual) ? expected.every(value => actual.includes(value)) : expected.length === 1 && actual === expected[0];
      });
      if (!matches) continue;
      const haystack = Object.values(values).flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ').toLocaleLowerCase();
      const score = words.length ? words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0) / words.length : 1;
      if (words.length && score === 0) continue;
      results.push({ imageId: row.image_id, imageVersionId: row.image_version_id, revisionId: row.revision_id, path: imagePath(row), filename: row.filename, values, score });
    }
    return results.sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename, 'en', { numeric: true }) || a.imageId.localeCompare(b.imageId)).slice(0, Math.min(500, Math.max(1, Number(limit))));
  }

  function resolveImages({ imageIds } = {}) {
    if (!Array.isArray(imageIds) || imageIds.length > 1000 || imageIds.some(id => typeof id !== 'string' || !id)) throw new Error('Resolve up to 1,000 image IDs');
    const ids = [...new Set(imageIds)];
    if (!ids.length) return [];
    return db.prepare(`SELECT i.id image_id, i.display_path, i.filename, i.availability, i.active,
      v.id image_version_id, v.width, v.height,
      root.canonical_path root_path, ir.relative_path,
      at.accepted_revision_id revision_id, at.review_state
      FROM images i JOIN image_versions v ON v.id = i.current_version_id
      LEFT JOIN image_roots ir ON ir.image_id = i.id AND ir.root_id =
        (SELECT min(ir2.root_id) FROM image_roots ir2 WHERE ir2.image_id = i.id AND ir2.present = 1)
      LEFT JOIN roots root ON root.id = ir.root_id
      LEFT JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = ?
      WHERE i.catalog_id = ? AND i.id IN (${ids.map(() => '?').join(',')})`)
      .all(getCatalog().active_schema_version_id, getCatalog().id, ...ids)
      .map(row => ({ imageId: row.image_id, imageVersionId: row.image_version_id, revisionId: row.revision_id,
        filename: row.filename, path: imagePath(row), width: row.width, height: row.height,
        availability: row.availability, active: Boolean(row.active), reviewState: row.review_state }));
  }

  async function execute(command, payload = {}) {
    if (closed) throw new Error('Catalog is closed');
    switch (command) {
      case 'catalog.snapshot': return snapshot(payload);
      case 'roots.add': return addRoot(payload);
      case 'roots.relocate': return relocateRoot(payload);
      case 'roots.scan': return scan(payload);
      case 'schema.saveDraft': return saveSchema(payload);
      case 'schema.publish': return publishSchema(payload);
      case 'schema.tag.add': return addTagOption(payload);
      case 'schema.tag.archive': return archiveTagOption(payload);
      case 'provider.save': return saveProvider(payload);
      case 'run.start': return startRun(payload);
      case 'run.cancel': return cancelRun(payload);
      case 'detection.start': return startDetectionRun(payload);
      case 'detection.cancel': return cancelDetectionRun(payload);
      case 'review.accept': return accept(payload);
      case 'review.bulk.accept': return bulkAccept(payload);
      case 'review.undo': return undoAcceptance(payload);
      case 'images.setActive': return changeImageActivity(payload);
      case 'embeddings.update': return startEmbeddingUpdate(payload);
      case 'embeddings.cancel': return cancelEmbeddingRun(payload);
      case 'search.hybrid': return hybridSearch(payload);
      case 'search.broll.readiness': return brollSearchReadiness();
      case 'search.broll': return brollSearch(payload);
      case 'search.accepted': return searchAccepted(payload);
      case 'images.resolve': return resolveImages(payload);
      default: throw new Error(`Unknown image catalog command: ${command}`);
    }
  }

  return Object.freeze({
    execute,
    onEvent(listener) { events.on('event', listener); return () => events.off('event', listener); },
    async backupTo(destination) { return store.backupTo(destination); },
    close() {
      if (closed) return;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      if (embeddingModelPromise) embeddingModelPromise.then(model => model.close?.()).catch(() => {});
      events.removeAllListeners(); store.close(); closed = true;
    }
  });
}
