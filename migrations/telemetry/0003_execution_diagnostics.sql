ALTER TABLE query_events ADD COLUMN execution_route TEXT;

ALTER TABLE query_statements ADD COLUMN runtime_diagnostics_json TEXT;
ALTER TABLE query_statements ADD COLUMN query_plan_json TEXT;

CREATE INDEX IF NOT EXISTS idx_query_events_route_duration
  ON query_events(execution_route, total_request_ms DESC, recorded_at_utc DESC);

