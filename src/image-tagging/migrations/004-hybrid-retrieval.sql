ALTER TABLE images ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1));

CREATE TABLE embedding_profiles (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  model_dtype TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK(dimension > 0),
  pooling TEXT NOT NULL,
  normalized INTEGER NOT NULL CHECK(normalized IN (0, 1)),
  query_prefix TEXT NOT NULL,
  retrieval_text_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(catalog_id, runtime, model, model_revision, model_dtype, dimension, pooling, normalized, query_prefix, retrieval_text_version)
) STRICT;

ALTER TABLE catalogs ADD COLUMN active_embedding_profile_id TEXT REFERENCES embedding_profiles(id);

CREATE TABLE embedding_runs (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  schema_version_id TEXT NOT NULL REFERENCES tag_schema_versions(id),
  profile_id TEXT NOT NULL REFERENCES embedding_profiles(id),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'canceled', 'failed')),
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  reused_items INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
) STRICT;

CREATE TABLE retrieval_documents (
  image_version_id TEXT PRIMARY KEY REFERENCES image_versions(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  schema_version_id TEXT NOT NULL REFERENCES tag_schema_versions(id),
  tag_revision_id TEXT NOT NULL REFERENCES tag_revisions(id) ON DELETE CASCADE,
  retrieval_text_version TEXT NOT NULL,
  retrieval_text_hash TEXT NOT NULL,
  retrieval_text TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE retrieval_tag_values (
  image_version_id TEXT NOT NULL REFERENCES image_versions(id) ON DELETE CASCADE,
  schema_version_id TEXT NOT NULL REFERENCES tag_schema_versions(id),
  tag_revision_id TEXT NOT NULL REFERENCES tag_revisions(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  option_key TEXT NOT NULL,
  PRIMARY KEY(image_version_id, schema_version_id, field_key, option_key)
) WITHOUT ROWID, STRICT;

CREATE TABLE retrieval_embeddings (
  tag_revision_id TEXT NOT NULL REFERENCES tag_revisions(id) ON DELETE CASCADE,
  retrieval_text_hash TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,
  encoding TEXT NOT NULL CHECK(encoding = 'float32-le'),
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tag_revision_id, retrieval_text_hash, profile_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE embedding_run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES embedding_runs(id) ON DELETE CASCADE,
  image_version_id TEXT NOT NULL REFERENCES image_versions(id),
  tag_revision_id TEXT NOT NULL REFERENCES tag_revisions(id),
  retrieval_text_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, image_version_id)
) STRICT;

CREATE VIRTUAL TABLE retrieval_fts USING fts5(
  image_version_id UNINDEXED,
  schema_version_id UNINDEXED,
  retrieval_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE INDEX embedding_runs_catalog_created ON embedding_runs(catalog_id, created_at DESC);
CREATE INDEX embedding_run_items_run_state ON embedding_run_items(run_id, state);
CREATE INDEX retrieval_documents_schema_revision ON retrieval_documents(schema_version_id, tag_revision_id);
CREATE INDEX retrieval_tag_values_lookup ON retrieval_tag_values(schema_version_id, field_key, option_key, image_version_id);
CREATE INDEX retrieval_embeddings_profile_hash ON retrieval_embeddings(profile_id, retrieval_text_hash);
