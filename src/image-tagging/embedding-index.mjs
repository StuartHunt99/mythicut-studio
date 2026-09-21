import { BGE_SMALL_PROFILE } from './embedding-model.mjs';
import { buildRetrievalDocument, RETRIEVAL_TEXT_VERSION } from './retrieval-text.mjs';
import { encodeFloat32LE } from './vector-search.mjs';

const iso = clock => clock().toISOString();

export function ensureEmbeddingProfile({ db, catalogId, id, clock, profile = BGE_SMALL_PROFILE }) {
  let row = db.prepare(`SELECT * FROM embedding_profiles WHERE catalog_id = ? AND runtime = ? AND model = ? AND model_revision = ?
    AND model_dtype = ? AND dimension = ? AND pooling = ? AND normalized = ? AND query_prefix = ? AND retrieval_text_version = ?`).get(
    catalogId, profile.runtime, profile.model, profile.modelRevision, profile.modelDtype, profile.dimension,
    profile.pooling, profile.normalized ? 1 : 0, profile.queryPrefix, RETRIEVAL_TEXT_VERSION
  );
  if (row) return row;
  const profileId = id();
  db.prepare(`INSERT INTO embedding_profiles(id, catalog_id, name, runtime, model, model_revision, model_dtype, dimension, pooling, normalized, query_prefix, retrieval_text_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    profileId, catalogId, profile.name, profile.runtime, profile.model, profile.modelRevision, profile.modelDtype,
    profile.dimension, profile.pooling, profile.normalized ? 1 : 0, profile.queryPrefix, RETRIEVAL_TEXT_VERSION, iso(clock)
  );
  return db.prepare('SELECT * FROM embedding_profiles WHERE id = ?').get(profileId);
}

function replaceRetrievalDocument(db, row, document, now) {
  db.prepare(`INSERT INTO retrieval_documents(image_version_id, image_id, schema_version_id, tag_revision_id, retrieval_text_version, retrieval_text_hash, retrieval_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(image_version_id) DO UPDATE SET image_id = excluded.image_id, schema_version_id = excluded.schema_version_id,
      tag_revision_id = excluded.tag_revision_id, retrieval_text_version = excluded.retrieval_text_version,
      retrieval_text_hash = excluded.retrieval_text_hash, retrieval_text = excluded.retrieval_text, updated_at = excluded.updated_at`).run(
    row.image_version_id, row.image_id, row.schema_version_id, row.tag_revision_id, document.version, document.hash, document.text, now
  );
  db.prepare('DELETE FROM retrieval_tag_values WHERE image_version_id = ?').run(row.image_version_id);
  const insertTag = db.prepare(`INSERT INTO retrieval_tag_values(image_version_id, schema_version_id, tag_revision_id, field_key, option_key)
    VALUES (?, ?, ?, ?, ?)`);
  for (const tag of document.tagValues) insertTag.run(row.image_version_id, row.schema_version_id, row.tag_revision_id, tag.fieldKey, tag.optionKey);
  db.prepare('DELETE FROM retrieval_fts WHERE image_version_id = ?').run(row.image_version_id);
  db.prepare('INSERT INTO retrieval_fts(image_version_id, schema_version_id, retrieval_text) VALUES (?, ?, ?)')
    .run(row.image_version_id, row.schema_version_id, document.text);
}

export function createEmbeddingRun({ db, transaction, catalogId, schemaVersionId, definition, profile, id, clock }) {
  const rows = db.prepare(`SELECT i.id image_id, v.id image_version_id, at.accepted_revision_id tag_revision_id,
    at.schema_version_id, tr.values_json
    FROM images i JOIN image_versions v ON v.id = i.current_version_id
    JOIN active_tags at ON at.image_version_id = v.id AND at.schema_version_id = ? AND at.review_state = 'accepted' AND at.accepted_revision_id IS NOT NULL
    JOIN tag_revisions tr ON tr.id = at.accepted_revision_id
    WHERE i.catalog_id = ? AND i.active = 1 AND i.availability = 'present'
    ORDER BY i.id`).all(schemaVersionId, catalogId);
  const prepared = rows.map(row => ({ row, document: buildRetrievalDocument(definition, JSON.parse(row.values_json)) }));
  const missing = [];
  const now = iso(clock);
  transaction(() => {
    for (const item of prepared) {
      replaceRetrievalDocument(db, item.row, item.document, now);
      const vector = db.prepare(`SELECT 1 FROM retrieval_embeddings WHERE tag_revision_id = ? AND retrieval_text_hash = ? AND profile_id = ?`)
        .get(item.row.tag_revision_id, item.document.hash, profile.id);
      if (!vector) missing.push(item);
    }
    db.prepare('UPDATE catalogs SET active_embedding_profile_id = ? WHERE id = ?').run(profile.id, catalogId);
  });
  if (!missing.length) return { runId: null, totalItems: 0, reusedItems: prepared.length, status: 'completed' };
  const runId = id();
  transaction(() => {
    db.prepare(`INSERT INTO embedding_runs(id, catalog_id, schema_version_id, profile_id, status, total_items, reused_items, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`).run(runId, catalogId, schemaVersionId, profile.id, missing.length, prepared.length - missing.length, now);
    const insert = db.prepare(`INSERT INTO embedding_run_items(id, run_id, image_version_id, tag_revision_id, retrieval_text_hash, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`);
    for (const item of missing) insert.run(id(), runId, item.row.image_version_id, item.row.tag_revision_id, item.document.hash, now, now);
  });
  return { runId, totalItems: missing.length, reusedItems: prepared.length - missing.length, status: 'queued' };
}

export async function processEmbeddingRun({ db, transaction, runId, embeddingModel, clock, signal, emit, batchSize = 16 }) {
  const run = db.prepare('SELECT * FROM embedding_runs WHERE id = ?').get(runId);
  if (!run) throw new Error('Embedding run not found');
  const now = iso(clock);
  db.prepare("UPDATE embedding_runs SET status = 'running', started_at = ? WHERE id = ?").run(now, runId);
  emit('embedding.progress', { runId, status: 'running', completedItems: 0, totalItems: run.total_items });
  const items = db.prepare(`SELECT eri.*, rd.retrieval_text FROM embedding_run_items eri
    JOIN retrieval_documents rd ON rd.image_version_id = eri.image_version_id AND rd.tag_revision_id = eri.tag_revision_id AND rd.retrieval_text_hash = eri.retrieval_text_hash
    WHERE eri.run_id = ? AND eri.state = 'queued' ORDER BY eri.created_at, eri.id`).all(runId);
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    if (signal.aborted) break;
    const started = iso(clock);
    transaction(() => {
      const mark = db.prepare("UPDATE embedding_run_items SET state = 'running', updated_at = ? WHERE id = ?");
      for (const item of batch) mark.run(started, item.id);
    });
    try {
      const vectors = await embeddingModel.embedDocuments(batch.map(item => item.retrieval_text));
      if (vectors.length !== batch.length) throw new Error('Embedding model returned the wrong number of vectors');
      transaction(() => {
        const completedAt = iso(clock);
        const insert = db.prepare(`INSERT OR REPLACE INTO retrieval_embeddings(tag_revision_id, retrieval_text_hash, profile_id, encoding, vector, created_at)
          VALUES (?, ?, ?, 'float32-le', ?, ?)`);
        const succeed = db.prepare("UPDATE embedding_run_items SET state = 'succeeded', error_message = NULL, updated_at = ? WHERE id = ?");
        for (let index = 0; index < batch.length; index++) {
          const vector = vectors[index];
          if (vector.length !== embeddingModel.profile.dimension) throw new Error('Embedding vector dimension does not match the active profile');
          insert.run(batch[index].tag_revision_id, batch[index].retrieval_text_hash, run.profile_id, encodeFloat32LE(vector), completedAt);
          succeed.run(completedAt, batch[index].id);
        }
        db.prepare('UPDATE embedding_runs SET completed_items = completed_items + ? WHERE id = ?').run(batch.length, runId);
      });
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 2000);
      transaction(() => {
        const failedAt = iso(clock);
        const fail = db.prepare("UPDATE embedding_run_items SET state = 'failed', error_message = ?, updated_at = ? WHERE id = ?");
        for (const item of batch) fail.run(message, failedAt, item.id);
        db.prepare('UPDATE embedding_runs SET completed_items = completed_items + ?, failed_items = failed_items + ? WHERE id = ?').run(batch.length, batch.length, runId);
      });
    }
    const progress = db.prepare('SELECT completed_items, failed_items, total_items FROM embedding_runs WHERE id = ?').get(runId);
    emit('embedding.progress', { runId, ...progress });
  }
  const canceled = signal.aborted;
  const failed = db.prepare("SELECT count(*) count FROM embedding_run_items WHERE run_id = ? AND state = 'failed'").get(runId).count;
  const remaining = db.prepare("SELECT count(*) count FROM embedding_run_items WHERE run_id = ? AND state IN ('queued', 'running')").get(runId).count;
  const finalStatus = canceled ? 'canceled' : failed ? 'failed' : 'completed';
  transaction(() => {
    if (remaining) db.prepare("UPDATE embedding_run_items SET state = 'canceled', updated_at = ? WHERE run_id = ? AND state IN ('queued', 'running')").run(iso(clock), runId);
    db.prepare('UPDATE embedding_runs SET status = ?, completed_items = total_items, failed_items = ?, error_message = ?, finished_at = ? WHERE id = ?')
      .run(finalStatus, failed, failed ? `${failed} embedding item${failed === 1 ? '' : 's'} failed` : null, iso(clock), runId);
  });
  emit('embedding.complete', { runId, status: finalStatus, failedItems: failed });
  return { runId, status: finalStatus, failedItems: failed };
}

export function setImagesActive({ db, transaction, catalogId, imageIds, active, clock }) {
  if (!Array.isArray(imageIds) || !imageIds.length || imageIds.length > 1000) throw new Error('Select between 1 and 1,000 images');
  const ids = [...new Set(imageIds.map(String))];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, current_version_id FROM images WHERE catalog_id = ? AND id IN (${placeholders})`).all(catalogId, ...ids);
  if (rows.length !== ids.length) throw new Error('One or more selected images do not belong to this catalog');
  transaction(() => {
    db.prepare(`UPDATE images SET active = ? WHERE catalog_id = ? AND id IN (${placeholders})`).run(active ? 1 : 0, catalogId, ...ids);
    for (const row of rows) {
      db.prepare('DELETE FROM retrieval_fts WHERE image_version_id = ?').run(row.current_version_id);
      if (active) {
        const document = db.prepare('SELECT schema_version_id, retrieval_text FROM retrieval_documents WHERE image_version_id = ?').get(row.current_version_id);
        if (document) db.prepare('INSERT INTO retrieval_fts(image_version_id, schema_version_id, retrieval_text) VALUES (?, ?, ?)').run(row.current_version_id, document.schema_version_id, document.retrieval_text);
      }
    }
  });
  return { count: rows.length, active: Boolean(active), updatedAt: iso(clock) };
}
