CREATE TABLE catalogs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  active_schema_version_id TEXT,
  active_provider_profile_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE roots (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  display_path TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  recursive INTEGER NOT NULL DEFAULT 1 CHECK(recursive IN (0, 1)),
  include_hidden INTEGER NOT NULL DEFAULT 0 CHECK(include_hidden IN (0, 1)),
  exclude_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(exclude_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(catalog_id, canonical_path)
) STRICT;

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  canonical_path TEXT NOT NULL,
  display_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  availability TEXT NOT NULL CHECK(availability IN ('present', 'missing', 'unreadable', 'replaced')),
  current_version_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(catalog_id, canonical_path)
) STRICT;

CREATE TABLE image_versions (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  mtime_ns TEXT NOT NULL,
  sha256 TEXT,
  media_type TEXT,
  width INTEGER,
  height INTEGER,
  orientation INTEGER,
  readable INTEGER NOT NULL CHECK(readable IN (0, 1)),
  error_message TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE(image_id, size_bytes, mtime_ns)
) STRICT;

CREATE TABLE image_roots (
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  present INTEGER NOT NULL DEFAULT 1 CHECK(present IN (0, 1)),
  last_seen_scan TEXT NOT NULL,
  PRIMARY KEY(image_id, root_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE tag_schemas (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE tag_schema_versions (
  id TEXT PRIMARY KEY,
  schema_id TEXT NOT NULL REFERENCES tag_schemas(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  definition_hash TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(schema_id, version)
) STRICT;

CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  dialect TEXT NOT NULL CHECK(dialect IN ('openai', 'openai-compatible', 'anthropic', 'google')),
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_ref TEXT,
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  last_verified_at TEXT,
  last_verification_json TEXT CHECK(last_verification_json IS NULL OR json_valid(last_verification_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(catalog_id, name)
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  schema_version_id TEXT NOT NULL REFERENCES tag_schema_versions(id),
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
  provider_snapshot_json TEXT NOT NULL CHECK(json_valid(provider_snapshot_json)),
  prompt_snapshot_json TEXT NOT NULL CHECK(json_valid(prompt_snapshot_json)),
  image_preset TEXT NOT NULL CHECK(image_preset IN ('economy', 'balanced', 'detail')),
  selection_policy TEXT NOT NULL CHECK(selection_policy IN ('new_only', 'retry_failed', 'stale_only', 'force_all')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'paused', 'completed', 'canceled', 'failed')),
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
) STRICT;

CREATE TABLE run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  image_version_id TEXT NOT NULL REFERENCES image_versions(id),
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  lease_at TEXT,
  error_category TEXT,
  error_message TEXT,
  proposal_revision_id TEXT,
  timing_json TEXT CHECK(timing_json IS NULL OR json_valid(timing_json)),
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, image_version_id)
) STRICT;

CREATE TABLE tag_revisions (
  id TEXT PRIMARY KEY,
  image_version_id TEXT NOT NULL REFERENCES image_versions(id),
  schema_version_id TEXT NOT NULL REFERENCES tag_schema_versions(id),
  parent_revision_id TEXT REFERENCES tag_revisions(id),
  origin TEXT NOT NULL CHECK(origin IN ('ai_proposal', 'ai_accept', 'manual', 'bulk')),
  kind TEXT NOT NULL CHECK(kind IN ('proposal', 'accepted')),
  run_item_id TEXT REFERENCES run_items(id),
  values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE active_tags (
  image_version_id TEXT NOT NULL REFERENCES image_versions(id) ON DELETE CASCADE,
  schema_version_id TEXT NOT NULL REFERENCES tag_schema_versions(id),
  accepted_revision_id TEXT REFERENCES tag_revisions(id),
  review_state TEXT NOT NULL CHECK(review_state IN ('not_ready', 'needs_review', 'accepted', 'skipped')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(image_version_id, schema_version_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE review_drafts (
  image_version_id TEXT NOT NULL REFERENCES image_versions(id) ON DELETE CASCADE,
  schema_version_id TEXT NOT NULL REFERENCES tag_schema_versions(id),
  base_revision_id TEXT REFERENCES tag_revisions(id),
  values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(image_version_id, schema_version_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE embeddings (
  tag_revision_id TEXT NOT NULL REFERENCES tag_revisions(id) ON DELETE CASCADE,
  retrieval_text_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK(dimension > 0),
  encoding TEXT NOT NULL CHECK(encoding IN ('float32-le')),
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tag_revision_id, retrieval_text_hash, provider, model)
) WITHOUT ROWID, STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX image_roots_root_present ON image_roots(root_id, present);
CREATE INDEX image_versions_image_observed ON image_versions(image_id, observed_at DESC);
CREATE INDEX schema_versions_schema_version ON tag_schema_versions(schema_id, version DESC);
CREATE INDEX run_items_run_state ON run_items(run_id, state);
CREATE INDEX tag_revisions_image_schema ON tag_revisions(image_version_id, schema_version_id, created_at DESC);

