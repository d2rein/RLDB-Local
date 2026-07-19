-- Unify pre-1998 scorer aggregates into player_stat_aggregates so query paths no longer need legacy unions.

DELETE FROM player_stat_aggregates
WHERE source = 'nrl'
  AND scope = 'season'
  AND season < 1998
  AND stat_key IN ('tries', 'goals', 'field_goals_1pt', 'field_goals_2pt', 'points');

WITH legacy_season AS (
  SELECT
    player_id,
    player_name_raw,
    season,
    SUM(tries) AS tries,
    SUM(goals) AS goals,
    SUM(fg1) AS field_goals_1pt,
    SUM(fg2) AS field_goals_2pt,
    SUM(points) AS points,
    COUNT(*) AS games
  FROM legacy_player_scoring
  WHERE season < 1998
  GROUP BY player_id, player_name_raw, season
)
INSERT INTO player_stat_aggregates (
  player_id,
  player_name_raw,
  source,
  scope,
  season,
  stat_key,
  total_value,
  recorded_games,
  total_games,
  first_season,
  last_season
)
SELECT player_id, player_name_raw, 'nrl', 'season', season, 'tries', tries, games, games, season, season
FROM legacy_season
UNION ALL
SELECT player_id, player_name_raw, 'nrl', 'season', season, 'goals', goals, games, games, season, season
FROM legacy_season
UNION ALL
SELECT player_id, player_name_raw, 'nrl', 'season', season, 'field_goals_1pt', field_goals_1pt, games, games, season, season
FROM legacy_season
UNION ALL
SELECT player_id, player_name_raw, 'nrl', 'season', season, 'field_goals_2pt', field_goals_2pt, games, games, season, season
FROM legacy_season
UNION ALL
SELECT player_id, player_name_raw, 'nrl', 'season', season, 'points', points, games, games, season, season
FROM legacy_season;

-- Legacy scorer indexes are no longer needed for runtime query paths.
DROP INDEX IF EXISTS idx_legacy_player_scoring_season_player;
DROP INDEX IF EXISTS idx_legacy_player_scoring_player_season;
