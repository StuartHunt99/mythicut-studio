import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { openCatalogDatabase } from './database.mjs';
import { canonicalizeRoot, scanRoot } from './scanner.mjs';
import { prepareImageForApi } from './image-preparation.mjs';
import { compileTaggingRequest } from './prompt.mjs';
import { createStarterDefinition, definitionHash, inferOptionKey, validateSchemaDefinition, validateTagValues } from './schema.mjs';
import { createOpenAICompatibleProvider, createOpenAIProvider } from './providers/openai.mjs';

const DEFAULT_PROVIDER = Object.freeze({
  name: 'OpenAI',
  dialect: 'openai',
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  settings: { imagePreset: 'economy', timeoutMs: 60_000, extraInstructions: '' }
});

const parse = (value, fallback = null) => value == null ? fallback : JSON.parse(value);
const iso = clock => clock().toISOString();

function cleanText(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${name} must be 1-${max} characters`);
  return value.trim();
}

function providerSettings(input = {}) {
  const imagePreset = input.imagePreset ?? 'economy';
  if (!['economy', 'balanced', 'detail'].includes(imagePreset)) throw new Error('Unknown image preset');
  const timeoutMs = Number(input.timeoutMs ?? 60_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) throw new Error('Provider timeout must be 5-300 seconds');
  const extraInstructions = String(input.extraInstructions ?? '').trim();
  if (extraInstructions.length > 8_000) throw new Error('Extra instructions are too long');
  return { imagePreset, timeoutMs, extraInstructions };
}

function validateProvider(input) {
  const dialect = input.dialect ?? 'openai';
  if (!['openai', 'openai-compatible'].includes(dialect)) throw new Error('This build supports OpenAI and Responses-compatible providers');
  const endpoint = new URL(input.endpoint ?? DEFAULT_PROVIDER.endpoint);
  if (endpoint.protocol !== 'https:') throw new Error('Provider endpoint must use HTTPS');
  if (dialect === 'openai' && endpoint.origin !== 'https://api.openai.com') throw new Error('The OpenAI provider must use api.openai.com');
  return {
    name: cleanText(input.name, 'Provider name'),
    dialect,
    endpoint: endpoint.toString().replace(/\/$/, ''),
    model: cleanText(input.model, 'Model', 200),
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

function definitionWithVocabulary(db, schemaId, definition) {
  const normalized = validateSchemaDefinition(definition);
  return {
    ...normalized,
    fields: normalized.fields.map(field => {
      if (field.type === 'free_text') return field;
      const options = [...field.options];
      const keys = new Set(options.map(option => option.key));
      for (const row of db.prepare('SELECT id, option_key key, label FROM tag_options WHERE schema_id = ? AND field_id = ? AND archived = 0 ORDER BY created_at, id').all(schemaId, field.id)) {
        if (keys.has(row.key)) continue;
        options.push({ id: row.id, key: row.key, label: row.label }); keys.add(row.key);
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

function defaultProviderFactory(profile, credential) {
  const options = { apiKey: credential, endpoint: profile.endpoint, timeoutMs: profile.settings.timeoutMs };
  return profile.dialect === 'openai' ? createOpenAIProvider(options) : createOpenAICompatibleProvider(options);
}

export async function openImageCatalog({
  databasePath,
  name,
  clock = () => new Date(),
  id = randomUUID,
  inspect,
  prepareImage = prepareImageForApi,
  providerFactory = defaultProviderFactory
}) {
  const store = await openCatalogDatabase(databasePath, { name, clock, id });
  await ensureDefaults(store, { clock, id });
  const { db, transaction } = store;
  const events = new EventEmitter();
  const controllers = new Map();
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

  function snapshot({ limit = 200, offset = 0 } = {}) {
    const catalog = getCatalog();
    const schemas = db.prepare(`SELECT s.id, s.name, s.description, s.archived, s.updated_at,
      v.id version_id, v.version, v.definition_json, v.published_at
      FROM tag_schemas s JOIN tag_schema_versions v ON v.schema_id = s.id
      WHERE s.catalog_id = ? ORDER BY s.name, v.version DESC`).all(catalog.id).map(row => ({
      id: row.id, name: row.name, description: row.description, archived: Boolean(row.archived), updatedAt: row.updated_at,
        versionId: row.version_id, version: row.version, definition: definitionWithVocabulary(db, row.id, parse(row.definition_json)), publishedAt: row.published_at,
        active: row.version_id === catalog.active_schema_version_id
      }));
    const images = db.prepare(`SELECT i.id, i.display_path, i.filename, i.availability, i.last_seen_at,
      v.id version_id, v.width, v.height, v.media_type,
      at.review_state, at.accepted_revision_id,
      (SELECT tr.values_json FROM tag_revisions tr WHERE tr.image_version_id = v.id AND tr.schema_version_id = ? AND tr.kind = 'proposal' ORDER BY tr.created_at DESC LIMIT 1) proposal_json,
      (SELECT tr.values_json FROM tag_revisions tr WHERE tr.id = at.accepted_revision_id) accepted_json
      FROM images i JOIN image_versions v ON v.id = i.current_version_id
      LEFT JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = ?
      WHERE i.catalog_id = ? ORDER BY i.filename, i.id LIMIT ? OFFSET ?`)
      .all(catalog.active_schema_version_id, catalog.active_schema_version_id, catalog.id, Math.min(1000, Math.max(1, Number(limit))), Math.max(0, Number(offset)))
      .map(row => ({ id: row.id, path: row.display_path, filename: row.filename, availability: row.availability, lastSeenAt: row.last_seen_at,
        versionId: row.version_id, width: row.width, height: row.height, mediaType: row.media_type,
        reviewState: row.review_state ?? 'not_ready', acceptedRevisionId: row.accepted_revision_id,
        proposal: parse(row.proposal_json), accepted: parse(row.accepted_json) }));
    return {
      catalog: { id: catalog.id, name: catalog.name, revision: catalog.revision, activeSchemaVersionId: catalog.active_schema_version_id, activeProviderProfileId: catalog.active_provider_profile_id },
      roots: db.prepare('SELECT * FROM roots WHERE catalog_id = ? ORDER BY display_path').all(catalog.id).map(row => ({ id: row.id, path: row.display_path, canonicalPath: row.canonical_path, recursive: Boolean(row.recursive), includeHidden: Boolean(row.include_hidden), excludes: parse(row.exclude_json, []), enabled: Boolean(row.enabled) })),
      schemas,
      providers: db.prepare('SELECT * FROM provider_profiles WHERE catalog_id = ? ORDER BY name').all(catalog.id).map(publicProvider),
      runs: db.prepare('SELECT * FROM runs WHERE catalog_id = ? ORDER BY created_at DESC LIMIT 50').all(catalog.id).map(row => ({ id: row.id, status: row.status, totalItems: row.total_items, completedItems: row.completed_items, failedItems: row.failed_items, createdAt: row.created_at, finishedAt: row.finished_at, error: row.error_message })),
      imageCount: db.prepare('SELECT count(*) count FROM images WHERE catalog_id = ?').get(catalog.id).count,
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
    if (field.options.some(option => option.label.toLocaleLowerCase() === cleanLabel.toLocaleLowerCase())) throw new Error('That tag already exists in this category');
    const key = inferOptionKey(cleanLabel, new Set(field.options.map(option => option.key)));
    const optionId = id(); const now = iso(clock);
    transaction(() => {
      db.prepare('INSERT INTO tag_options(id, schema_id, field_id, option_key, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(optionId, schema.schema_id, field.id, key, cleanLabel, now, now);
      changed('schema.tag_added', { schemaVersionId: schema.id, fieldId: field.id, optionId, label: cleanLabel });
    });
    return { id: optionId, key, label: cleanLabel };
  }

  function selectedVersions(schemaVersionId, policy) {
    const base = `SELECT DISTINCT v.id version_id, i.display_path, i.filename,
      coalesce((SELECT min(ir.relative_path) FROM image_roots ir WHERE ir.image_id = i.id AND ir.present = 1), i.filename) relative_path
      FROM images i JOIN image_versions v ON v.id = i.current_version_id
      WHERE i.catalog_id = ? AND i.availability = 'present' AND v.readable = 1`;
    if (policy === 'force_all') return db.prepare(`${base} ORDER BY i.display_path`).all(getCatalog().id);
    if (!['new_only', 'retry_failed', 'stale_only'].includes(policy)) throw new Error('Unknown selection policy');
    const noAccepted = `NOT EXISTS (SELECT 1 FROM tag_revisions tr WHERE tr.image_version_id = v.id AND tr.schema_version_id = ? AND tr.kind = 'accepted')`;
    const proposal = `${policy === 'new_only' || policy === 'stale_only' ? 'NOT EXISTS' : 'EXISTS'} (SELECT 1 FROM tag_revisions tr WHERE tr.image_version_id = v.id AND tr.schema_version_id = ? AND tr.kind = 'proposal')`;
    const stale = policy === 'stale_only' ? `AND EXISTS (
      SELECT 1 FROM image_versions old_v JOIN tag_revisions old_tr ON old_tr.image_version_id = old_v.id
      WHERE old_v.image_id = i.id AND old_v.id <> v.id AND old_tr.schema_version_id = ? AND old_tr.kind = 'accepted'
    )` : '';
    const parameters = [getCatalog().id, schemaVersionId, schemaVersionId];
    if (policy === 'stale_only') parameters.push(schemaVersionId);
    return db.prepare(`${base} AND ${noAccepted} AND ${proposal} ${stale} ORDER BY i.display_path`).all(...parameters);
  }

  function startRun(payload) {
    const catalog = getCatalog();
    const schema = db.prepare('SELECT * FROM tag_schema_versions WHERE id = ? AND published_at IS NOT NULL').get(payload.schemaVersionId ?? catalog.active_schema_version_id);
    const providerRow = db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(payload.providerProfileId ?? catalog.active_provider_profile_id);
    if (!schema) throw new Error('Publish and activate a schema before tagging');
    if (!providerRow) throw new Error('Configure a provider before tagging');
    const profile = { ...publicProvider(providerRow), settings: parse(providerRow.settings_json, {}) };
    const definition = definitionWithVocabulary(db, schema.schema_id, parse(schema.definition_json));
    const policy = payload.selectionPolicy ?? 'new_only';
    const items = selectedVersions(schema.id, policy);
    const runId = id(); const now = iso(clock);
    const promptSnapshot = { definitionHash: definitionHash(definition), schemaDefinition: definition, extraInstructions: profile.settings.extraInstructions ?? '' };
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

  async function processRun(runId, { credential }) {
    const controller = new AbortController(); controllers.set(runId, controller);
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    const schema = db.prepare('SELECT * FROM tag_schema_versions WHERE id = ?').get(run.schema_version_id);
    const promptSnapshot = parse(run.prompt_snapshot_json, {});
    const definition = promptSnapshot.schemaDefinition ?? definitionWithVocabulary(db, schema.schema_id, parse(schema.definition_json));
    const profile = parse(run.provider_snapshot_json); const settings = providerSettings(profile.settings);
    let provider;
    try { provider = providerFactory(profile, credential); }
    catch (error) {
      transaction(() => {
        db.prepare("UPDATE runs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?").run(error.message, iso(clock), runId);
        db.prepare("UPDATE run_items SET state = 'failed', error_category = 'configuration', error_message = ?, updated_at = ? WHERE run_id = ?").run(error.message, iso(clock), runId);
        changed('run.failed', { runId, error: error.message });
      });
      emit('run.complete', { runId, status: 'failed' }); controllers.delete(runId); return;
    }
    db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(iso(clock), runId);
    emit('run.progress', { runId, status: 'running', completedItems: 0, totalItems: run.total_items });
    const items = db.prepare(`SELECT ri.*, v.image_id, i.display_path, i.filename,
      coalesce((SELECT min(ir.relative_path) FROM image_roots ir WHERE ir.image_id = i.id AND ir.present = 1), i.filename) relative_path
      FROM run_items ri JOIN image_versions v ON v.id = ri.image_version_id JOIN images i ON i.id = v.image_id
      WHERE ri.run_id = ? ORDER BY i.display_path`).all(runId);
    let consecutiveFailures = 0;
    for (const item of items) {
      if (controller.signal.aborted) break;
      const started = Date.now();
      db.prepare("UPDATE run_items SET state = 'running', attempt_count = attempt_count + 1, lease_at = ?, updated_at = ? WHERE id = ?").run(iso(clock), iso(clock), item.id);
      try {
        const image = await prepareImage(item.display_path, { preset: settings.imagePreset });
        const request = compileTaggingRequest({ definition, filename: item.filename, relativePath: item.relative_path, extraInstructions: settings.extraInstructions });
        const result = await provider.generate({ model: profile.model, image, ...request, signal: controller.signal });
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
        db.prepare("UPDATE run_items SET state = 'failed', error_category = 'provider', error_message = ?, timing_json = ?, updated_at = ? WHERE id = ?")
          .run(String(error.message).slice(0, 2000), JSON.stringify({ durationMs: Date.now() - started }), iso(clock), item.id);
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
      tr.id revision_id, tr.values_json
      FROM images i JOIN image_versions v ON v.id = i.current_version_id
      JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = ? AND at.review_state = 'accepted'
      JOIN tag_revisions tr ON tr.id = at.accepted_revision_id
      WHERE i.catalog_id = ? AND i.availability = 'present'`).all(schemaVersionId, getCatalog().id);
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
      results.push({ imageId: row.image_id, imageVersionId: row.image_version_id, revisionId: row.revision_id, path: row.display_path, filename: row.filename, values, score });
    }
    return results.sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename, 'en', { numeric: true }) || a.imageId.localeCompare(b.imageId)).slice(0, Math.min(500, Math.max(1, Number(limit))));
  }

  async function execute(command, payload = {}) {
    if (closed) throw new Error('Catalog is closed');
    switch (command) {
      case 'catalog.snapshot': return snapshot(payload);
      case 'roots.add': return addRoot(payload);
      case 'roots.scan': return scan(payload);
      case 'schema.saveDraft': return saveSchema(payload);
      case 'schema.publish': return publishSchema(payload);
      case 'schema.tag.add': return addTagOption(payload);
      case 'provider.save': return saveProvider(payload);
      case 'run.start': return startRun(payload);
      case 'run.cancel': return cancelRun(payload);
      case 'review.accept': return accept(payload);
      case 'review.undo': return undoAcceptance(payload);
      case 'search.accepted': return searchAccepted(payload);
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
      controllers.clear(); events.removeAllListeners(); store.close(); closed = true;
    }
  });
}
