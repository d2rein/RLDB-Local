ALTER TABLE query_events ADD COLUMN request_started_at_utc TEXT;
ALTER TABLE query_events ADD COLUMN last_progress_at_utc TEXT;
ALTER TABLE query_events ADD COLUMN completed_at_utc TEXT;
ALTER TABLE query_events ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE query_statements ADD COLUMN started_at_utc TEXT;
ALTER TABLE query_statements ADD COLUMN completed_at_utc TEXT;
ALTER TABLE query_statements ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'completed';

CREATE INDEX IF NOT EXISTS idx_query_events_lifecycle_progress
  ON query_events(lifecycle_state, last_progress_at_utc);
