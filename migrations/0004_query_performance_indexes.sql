-- Improve broad player aggregate lookup performance without changing query logic.
CREATE INDEX IF NOT EXISTS idx_player_stat_aggregates_source_scope_stat_season_player
  ON player_stat_aggregates(source, scope, stat_key, season, player_id);

-- Helps legacy pre-1998 aggregate reads that filter mostly by season ranges.
CREATE INDEX IF NOT EXISTS idx_legacy_player_scoring_season_player
  ON legacy_player_scoring(season, player_id);
