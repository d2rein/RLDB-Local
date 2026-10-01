CREATE TABLE IF NOT EXISTS warg_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warg_season_ratings (
  season INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  position TEXT NOT NULL,
  role TEXT NOT NULL,
  games INTEGER NOT NULL,
  minutes REAL NOT NULL,
  fty REAL NOT NULL,
  pty REAL NOT NULL,
  warg REAL NOT NULL,
  PRIMARY KEY (season, player_id)
);

CREATE TABLE IF NOT EXISTS warg_match_ratings (
  season INTEGER NOT NULL,
  match_id INTEGER NOT NULL,
  match_date_utc TEXT,
  round_label TEXT,
  player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  team_name TEXT NOT NULL,
  opponent_name TEXT NOT NULL,
  score TEXT NOT NULL,
  position TEXT NOT NULL,
  role TEXT NOT NULL,
  minutes REAL NOT NULL,
  minutes_imputed INTEGER NOT NULL,
  fty REAL NOT NULL,
  pty REAL NOT NULL,
  game_warg REAL NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS warg_career_ratings (
  player_id INTEGER PRIMARY KEY,
  player_name TEXT NOT NULL,
  primary_position TEXT NOT NULL,
  primary_role TEXT NOT NULL,
  seasons INTEGER NOT NULL,
  games INTEGER NOT NULL,
  minutes REAL NOT NULL,
  career_warg REAL NOT NULL,
  warg_per_game REAL NOT NULL,
  best_season INTEGER,
  best_season_warg REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_warg_match_season_value
  ON warg_match_ratings (season, game_warg DESC);
CREATE INDEX IF NOT EXISTS idx_warg_match_team_value
  ON warg_match_ratings (team_id, season, player_id);
CREATE INDEX IF NOT EXISTS idx_warg_season_value
  ON warg_season_ratings (season, warg DESC);
CREATE INDEX IF NOT EXISTS idx_warg_season_role_value
  ON warg_season_ratings (season, role, warg DESC);
CREATE INDEX IF NOT EXISTS idx_warg_career_value
  ON warg_career_ratings (career_warg DESC);
CREATE INDEX IF NOT EXISTS idx_warg_career_role_value
  ON warg_career_ratings (primary_role, career_warg DESC);
