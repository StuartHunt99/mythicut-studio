CREATE TABLE tag_options (
  id TEXT PRIMARY KEY,
  schema_id TEXT NOT NULL REFERENCES tag_schemas(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL,
  option_key TEXT NOT NULL CHECK(length(option_key) BETWEEN 1 AND 64),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(schema_id, field_id, option_key)
) STRICT;

CREATE INDEX tag_options_field ON tag_options(schema_id, field_id, archived, label);
