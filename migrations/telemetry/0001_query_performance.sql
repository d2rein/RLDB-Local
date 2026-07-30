PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS telemetry_migrations (
  migration_name TEXT PRIMARY KEY,
  applied_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS query_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at_utc TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  endpoint TEXT NOT NULL,
  request_input_json TEXT NOT NULL,
  query_shape_hash TEXT NOT NULL,
  query_category TEXT NOT NULL,
  database_execution_ms REAL NOT NULL,
  application_post_processing_ms REAL NOT NULL,
  total_request_ms REAL NOT NULL,
  rows_fetched INTEGER NOT NULL,
  database_rows_read INTEGER NOT NULL,
  rows_returned INTEGER,
  response_status INTEGER NOT NULL,
  error_name TEXT,
  error_message TEXT,
  application_version TEXT NOT NULL,
  database_schema_version TEXT NOT NULL,
  request_source TEXT NOT NULL,
  statement_count INTEGER NOT NULL,
  truncation_markers_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS query_statements (
  statement_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  method TEXT NOT NULL,
  sql_text TEXT NOT NULL,
  normalized_sql TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  rows_fetched INTEGER NOT NULL,
  database_rows_read INTEGER,
  error_name TEXT,
  error_message TEXT,
  FOREIGN KEY (event_id) REFERENCES query_events(event_id) ON DELETE CASCADE,
  UNIQUE(event_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_query_events_slowest
  ON query_events(total_request_ms DESC, recorded_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_query_events_category_duration
  ON query_events(query_category, total_request_ms DESC, recorded_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_query_events_shape
  ON query_events(query_shape_hash, recorded_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_query_events_rows
  ON query_events(database_rows_read DESC, rows_fetched DESC, recorded_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_query_events_post_processing
  ON query_events(application_post_processing_ms DESC, recorded_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_query_events_version_shape
  ON query_events(application_version, query_shape_hash, recorded_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_query_events_source_time
  ON query_events(request_source, recorded_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_query_events_status
  ON query_events(response_status, recorded_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_query_statements_event
  ON query_statements(event_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_query_statements_duration
  ON query_statements(duration_ms DESC);

INSERT OR IGNORE INTO telemetry_migrations (migration_name, applied_at_utc)
VALUES ('0001_query_performance.sql', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
