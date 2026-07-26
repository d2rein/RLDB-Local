PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS benchmark_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_utc TEXT NOT NULL,
  completed_at_utc TEXT,
  git_commit TEXT NOT NULL,
  application_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  data_cutoff_json TEXT NOT NULL,
  hosting_mode TEXT NOT NULL,
  database_engine TEXT NOT NULL,
  base_url TEXT NOT NULL,
  machine_json TEXT NOT NULL,
  node_version TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  baseline_path TEXT NOT NULL,
  total_duration_ms REAL,
  passed_cases INTEGER,
  failed_cases INTEGER
);

CREATE TABLE IF NOT EXISTS benchmark_iterations (
  iteration_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  case_id TEXT NOT NULL,
  case_label TEXT NOT NULL,
  category TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  query_input_json TEXT NOT NULL,
  stable_query_hash TEXT NOT NULL,
  iteration_number INTEGER NOT NULL,
  temperature TEXT NOT NULL,
  request_id TEXT,
  response_status INTEGER,
  database_execution_ms REAL,
  post_processing_ms REAL,
  total_request_ms REAL NOT NULL,
  rows_fetched INTEGER,
  rows_returned INTEGER,
  generated_sql_json TEXT,
  explain_query_plan_json TEXT,
  passed INTEGER NOT NULL,
  mismatch_json TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  recovered_after_failure INTEGER NOT NULL DEFAULT 0,
  normalized_result_json TEXT,
  FOREIGN KEY (run_id) REFERENCES benchmark_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_benchmark_iterations_run_case
  ON benchmark_iterations(run_id, case_id, iteration_number);
CREATE INDEX IF NOT EXISTS idx_benchmark_iterations_duration
  ON benchmark_iterations(total_request_ms DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_iterations_hash
  ON benchmark_iterations(stable_query_hash, run_id);
