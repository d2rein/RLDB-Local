CREATE TABLE stat_groups (
  stat_group_id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stat_definitions (
  stat_definition_id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  stat_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  stat_group_id INTEGER,
  description TEXT,
  source_priority TEXT NOT NULL DEFAULT 'nrl',
  value_type TEXT NOT NULL DEFAULT 'numeric',
  aggregation_type TEXT NOT NULL DEFAULT 'sum',
  supports_totals INTEGER NOT NULL DEFAULT 1,
  supports_averages INTEGER NOT NULL DEFAULT 1,
  supports_streaks INTEGER NOT NULL DEFAULT 0,
  first_recorded_season INTEGER,
  first_consistent_season INTEGER,
  availability_notes TEXT,
  missing_value_strategy TEXT NOT NULL DEFAULT 'exclude',
  include_pre_consistent_values INTEGER NOT NULL DEFAULT 1,
  is_derived INTEGER NOT NULL DEFAULT 0,
  derivation_sql TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scope, stat_key),
  FOREIGN KEY (stat_group_id) REFERENCES stat_groups(stat_group_id)
);

CREATE TABLE import_runs (
  import_run_id INTEGER PRIMARY KEY,
  import_name TEXT NOT NULL,
  started_at_utc TEXT NOT NULL,
  finished_at_utc TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  rows_written INTEGER NOT NULL DEFAULT 0,
  details_json TEXT
);

CREATE INDEX idx_stat_definitions_scope_group_sort
  ON stat_definitions(scope, stat_group_id, sort_order, display_name);

CREATE INDEX idx_stat_definitions_enabled
  ON stat_definitions(is_enabled, scope, stat_key);

CREATE INDEX idx_import_runs_name_status
  ON import_runs(import_name, status, started_at_utc);
