CREATE TABLE IF NOT EXISTS site_password_login_attempts (
  subject_key TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL DEFAULT 0,
  first_failure_utc TEXT,
  locked_until_utc TEXT,
  updated_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_password_login_attempts_locked_until
  ON site_password_login_attempts(locked_until_utc);
