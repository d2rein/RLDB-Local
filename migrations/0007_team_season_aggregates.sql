CREATE TABLE IF NOT EXISTS team_season_aggregates (
  team_season_aggregate_id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL,
  team_name_raw TEXT NOT NULL,
  source TEXT NOT NULL,
  season INTEGER NOT NULL,
  season_phase TEXT NOT NULL,
  stat_key TEXT NOT NULL,
  total_value REAL NOT NULL DEFAULT 0,
  recorded_games INTEGER NOT NULL DEFAULT 0,
  total_games INTEGER NOT NULL DEFAULT 0,
  first_season INTEGER,
  last_season INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  UNIQUE(team_id, source, season, season_phase, stat_key)
);

CREATE INDEX IF NOT EXISTS idx_team_season_aggregates_lookup
  ON team_season_aggregates(source, season_phase, stat_key, season, total_value DESC, team_id);

CREATE INDEX IF NOT EXISTS idx_team_season_aggregates_team
  ON team_season_aggregates(team_id, source, season, season_phase, stat_key);
