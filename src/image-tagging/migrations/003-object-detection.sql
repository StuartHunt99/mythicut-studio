CREATE TABLE detection_runs (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
  provider_snapshot_json TEXT NOT NULL CHECK(json_valid(provider_snapshot_json)),
  prompt_snapshot_json TEXT NOT NULL CHECK(json_valid(prompt_snapshot_json)),
  image_preset TEXT NOT NULL CHECK(image_preset IN ('economy', 'balanced', 'detail')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'canceled', 'failed')),
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
) STRICT;

CREATE TABLE detection_run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES detection_runs(id) ON DELETE CASCADE,
  image_version_id TEXT NOT NULL REFERENCES image_versions(id),
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  error_message TEXT,
  result_id TEXT,
  source_width INTEGER,
  source_height INTEGER,
  prepared_width INTEGER,
  prepared_height INTEGER,
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, image_version_id)
) STRICT;

CREATE TABLE image_detection_results (
  id TEXT PRIMARY KEY,
  image_version_id TEXT NOT NULL REFERENCES image_versions(id) ON DELETE CASCADE,
  detection_run_item_id TEXT NOT NULL REFERENCES detection_run_items(id),
  coordinates_json TEXT NOT NULL CHECK(json_valid(coordinates_json)),
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX detection_run_items_run_state ON detection_run_items(run_id, state);
CREATE INDEX image_detection_results_image_created ON image_detection_results(image_version_id, created_at DESC);
