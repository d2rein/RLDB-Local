CREATE INDEX IF NOT EXISTS idx_team_match_stat_values_key_text
  ON team_match_stat_values(stat_key, stat_value_text)
  WHERE stat_value_text IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_player_stat_aggregates_query_covering
  ON player_stat_aggregates(
    source,
    scope,
    stat_key,
    season,
    player_id,
    total_value,
    recorded_games,
    total_games,
    player_name_raw
  );
