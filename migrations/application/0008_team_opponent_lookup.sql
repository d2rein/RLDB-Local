CREATE INDEX IF NOT EXISTS idx_team_match_summary_lookup
ON team_match_summary (team_id, season, opponent_team_id);
