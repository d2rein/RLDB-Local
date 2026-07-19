export const FULL_HISTORICAL_RESEED_DELETE_STATEMENTS = [
  "DELETE FROM player_match_summary;",
  "DELETE FROM team_match_summary;",
  "DELETE FROM team_season_aggregates;",
  "DELETE FROM player_stat_aggregates;",
  "DELETE FROM match_sources;",
  "DELETE FROM match_team_stats;",
  "DELETE FROM match_player_stats;",
  "DELETE FROM legacy_player_scoring;",
  "DELETE FROM player_team_spells;",
  "DELETE FROM import_issues;",
  "DELETE FROM player_aliases;",
  "DELETE FROM players;",
  "DELETE FROM matches;",
  "DELETE FROM team_aliases;",
  "DELETE FROM teams;",
  "DELETE FROM venues;",
];

export function seasonScopedRefreshDeleteStatements(seasonSql) {
  return [
    `DELETE FROM legacy_player_scoring WHERE season = ${seasonSql};`,
    `DELETE FROM player_stat_aggregates WHERE season = ${seasonSql};`,
    `DELETE FROM team_season_aggregates WHERE season = ${seasonSql};`,
    `DELETE FROM player_match_summary WHERE season = ${seasonSql};`,
    `DELETE FROM team_match_summary WHERE season = ${seasonSql};`,
    `DELETE FROM match_sources WHERE match_id IN (SELECT match_id FROM matches WHERE season = ${seasonSql});`,
    `DELETE FROM matches WHERE season = ${seasonSql};`,
  ];
}
