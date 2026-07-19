CREATE TABLE competitions (
  competition_id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE teams (
  team_id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL,
  canonical_name TEXT NOT NULL,
  short_name TEXT,
  first_season INTEGER,
  last_season INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (competition_id) REFERENCES competitions(competition_id)
);

CREATE TABLE team_aliases (
  team_alias_id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_name TEXT NOT NULL,
  first_season INTEGER,
  last_season INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE TABLE venues (
  venue_id INTEGER PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  afltables_name TEXT,
  nrl_name TEXT,
  city TEXT,
  country TEXT
);

CREATE TABLE players (
  player_id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  sort_name TEXT,
  first_season INTEGER,
  last_season INTEGER,
  afltables_player_url TEXT,
  is_unresolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE player_aliases (
  player_alias_id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_name TEXT NOT NULL,
  first_season INTEGER,
  last_season INTEGER,
  confidence REAL,
  FOREIGN KEY (player_id) REFERENCES players(player_id)
);

CREATE TABLE matches (
  match_id INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  round_label TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  match_date_utc TEXT,
  match_date_local_text TEXT,
  is_finals INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL,
  away_team_id INTEGER NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  winner_team_id INTEGER,
  margin INTEGER,
  venue_id INTEGER,
  notes TEXT,
  FOREIGN KEY (competition_id) REFERENCES competitions(competition_id),
  FOREIGN KEY (home_team_id) REFERENCES teams(team_id),
  FOREIGN KEY (away_team_id) REFERENCES teams(team_id),
  FOREIGN KEY (winner_team_id) REFERENCES teams(team_id),
  FOREIGN KEY (venue_id) REFERENCES venues(venue_id)
);

CREATE TABLE match_sources (
  match_source_id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_match_key TEXT,
  source_round_label TEXT,
  source_round_index INTEGER,
  source_date TEXT,
  source_home_team TEXT,
  source_away_team TEXT,
  source_home_score TEXT,
  source_away_score TEXT,
  source_venue TEXT,
  source_url TEXT,
  FOREIGN KEY (match_id) REFERENCES matches(match_id)
);

CREATE TABLE match_team_stats (
  match_team_stat_id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  is_home INTEGER NOT NULL,
  stat_key TEXT NOT NULL,
  stat_value_text TEXT,
  stat_value_num REAL,
  FOREIGN KEY (match_id) REFERENCES matches(match_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE TABLE match_player_stats (
  match_player_stat_id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  player_id INTEGER,
  player_name_raw TEXT NOT NULL,
  jumper_number INTEGER,
  position_label TEXT,
  stat_key TEXT NOT NULL,
  stat_value_text TEXT,
  stat_value_num REAL,
  FOREIGN KEY (match_id) REFERENCES matches(match_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (player_id) REFERENCES players(player_id)
);

CREATE TABLE legacy_player_scoring (
  legacy_player_scoring_id INTEGER PRIMARY KEY,
  match_id INTEGER,
  season INTEGER NOT NULL,
  player_id INTEGER,
  player_name_raw TEXT NOT NULL,
  team_id INTEGER,
  tries INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  fg1 INTEGER NOT NULL DEFAULT 0,
  fg2 INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(match_id),
  FOREIGN KEY (player_id) REFERENCES players(player_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE TABLE player_stat_aggregates (
  player_stat_aggregate_id INTEGER PRIMARY KEY,
  player_id INTEGER,
  player_name_raw TEXT NOT NULL,
  source TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'career',
  season INTEGER,
  stat_key TEXT NOT NULL,
  total_value REAL NOT NULL DEFAULT 0,
  recorded_games INTEGER NOT NULL DEFAULT 0,
  total_games INTEGER NOT NULL DEFAULT 0,
  first_season INTEGER,
  last_season INTEGER,
  FOREIGN KEY (player_id) REFERENCES players(player_id)
);

CREATE TABLE player_match_summary (
  player_match_summary_id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  player_id INTEGER,
  player_name_raw TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  season INTEGER NOT NULL,
  round_index INTEGER,
  is_finals INTEGER NOT NULL DEFAULT 0,
  match_date_utc TEXT,
  is_home INTEGER NOT NULL,
  jumper_number INTEGER,
  position_label TEXT,
  stats_json TEXT NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(match_id),
  FOREIGN KEY (player_id) REFERENCES players(player_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id)
);

CREATE TABLE team_match_summary (
  team_match_summary_id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  opponent_team_id INTEGER,
  season INTEGER NOT NULL,
  round_index INTEGER,
  is_finals INTEGER NOT NULL DEFAULT 0,
  match_date_utc TEXT,
  is_home INTEGER NOT NULL,
  team_score INTEGER,
  opponent_score INTEGER,
  result_code TEXT,
  stats_json TEXT NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(match_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id)
);

CREATE TABLE player_team_spells (
  player_team_spell_id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  first_match_id INTEGER,
  last_match_id INTEGER,
  first_season INTEGER,
  last_season INTEGER,
  FOREIGN KEY (player_id) REFERENCES players(player_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (first_match_id) REFERENCES matches(match_id),
  FOREIGN KEY (last_match_id) REFERENCES matches(match_id)
);

CREATE TABLE import_issues (
  import_issue_id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_key TEXT,
  season INTEGER,
  issue_type TEXT NOT NULL,
  details_json TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE INDEX idx_matches_competition_season_round_date
  ON matches(competition_id, season, round_index, match_date_utc);

CREATE INDEX idx_matches_home_team_date
  ON matches(home_team_id, season, match_date_utc);

CREATE INDEX idx_matches_away_team_date
  ON matches(away_team_id, season, match_date_utc);

CREATE INDEX idx_matches_finals_date
  ON matches(is_finals, season, match_date_utc);

CREATE INDEX idx_match_team_stats_key
  ON match_team_stats(match_id, team_id, stat_key);

CREATE INDEX idx_match_team_stats_value
  ON match_team_stats(stat_key, stat_value_num);

CREATE INDEX idx_match_player_stats_key
  ON match_player_stats(match_id, player_id, stat_key);

CREATE INDEX idx_match_player_stats_value
  ON match_player_stats(player_id, stat_key, stat_value_num);

CREATE INDEX idx_legacy_player_scoring_player_season
  ON legacy_player_scoring(player_id, season);

CREATE INDEX idx_player_stat_aggregates_lookup
  ON player_stat_aggregates(scope, stat_key, total_value DESC);

CREATE INDEX idx_player_stat_aggregates_player
  ON player_stat_aggregates(player_id, scope, stat_key);

CREATE INDEX idx_player_match_summary_player
  ON player_match_summary(player_id, season, match_date_utc);

CREATE INDEX idx_player_match_summary_match
  ON player_match_summary(match_id, team_id);

CREATE INDEX idx_team_match_summary_team
  ON team_match_summary(team_id, season, match_date_utc);

CREATE INDEX idx_player_aliases_source_name
  ON player_aliases(source, source_name);

CREATE INDEX idx_team_aliases_source_name
  ON team_aliases(source, source_name);
