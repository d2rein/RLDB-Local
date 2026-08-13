CREATE TABLE IF NOT EXISTS player_match_query_components (
  player_match_summary_id INTEGER PRIMARY KEY,
  tries REAL NOT NULL DEFAULT 0,
  goals REAL NOT NULL DEFAULT 0,
  field_goals_1pt REAL NOT NULL DEFAULT 0,
  field_goals_2pt REAL NOT NULL DEFAULT 0,
  conversions_with_attempts REAL NOT NULL DEFAULT 0,
  conversion_attempts REAL NOT NULL DEFAULT 0,
  play_the_ball_total_seconds REAL NOT NULL DEFAULT 0,
  play_the_ball REAL NOT NULL DEFAULT 0,
  passes REAL NOT NULL DEFAULT 0,
  all_runs REAL NOT NULL DEFAULT 0,
  tackles_made REAL NOT NULL DEFAULT 0,
  tackle_attempts REAL NOT NULL DEFAULT 0,
  minutes_played REAL NOT NULL DEFAULT 0,
  minutes_played_present INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (player_match_summary_id)
    REFERENCES player_match_summary(player_match_summary_id)
    ON DELETE CASCADE
);

INSERT OR IGNORE INTO player_match_query_components (
  player_match_summary_id,
  tries,
  goals,
  field_goals_1pt,
  field_goals_2pt,
  conversions_with_attempts,
  conversion_attempts,
  play_the_ball_total_seconds,
  play_the_ball,
  passes,
  all_runs,
  tackles_made,
  tackle_attempts,
  minutes_played,
  minutes_played_present
)
SELECT
  player_match_summary_id,
  COALESCE(CAST(json_extract(stats_json, '$."tries"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."goals"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."field_goals_1pt"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."field_goals_2pt"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."conversions_with_attempts"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."conversion_attempts"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."play_the_ball_total_seconds"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."play_the_ball"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."passes"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."all_runs"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."tackles_made"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."tackle_attempts"') AS REAL), 0),
  COALESCE(CAST(json_extract(stats_json, '$."minutes_played"') AS REAL), 0),
  CASE WHEN json_type(stats_json, '$."minutes_played"') IS NULL THEN 0 ELSE 1 END
FROM player_match_summary
WHERE NOT EXISTS (
  SELECT 1
  FROM player_match_query_components
  LIMIT 1
);

CREATE TRIGGER IF NOT EXISTS trg_player_match_query_components_insert
AFTER INSERT ON player_match_summary
BEGIN
  INSERT OR REPLACE INTO player_match_query_components (
    player_match_summary_id, tries, goals, field_goals_1pt, field_goals_2pt,
    conversions_with_attempts, conversion_attempts,
    play_the_ball_total_seconds, play_the_ball, passes, all_runs,
    tackles_made, tackle_attempts, minutes_played, minutes_played_present
  ) VALUES (
    NEW.player_match_summary_id,
    COALESCE(CAST(json_extract(NEW.stats_json, '$."tries"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."goals"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."field_goals_1pt"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."field_goals_2pt"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."conversions_with_attempts"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."conversion_attempts"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."play_the_ball_total_seconds"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."play_the_ball"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."passes"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."all_runs"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."tackles_made"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."tackle_attempts"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."minutes_played"') AS REAL), 0),
    CASE WHEN json_type(NEW.stats_json, '$."minutes_played"') IS NULL THEN 0 ELSE 1 END
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_player_match_query_components_update
AFTER UPDATE OF stats_json ON player_match_summary
BEGIN
  INSERT OR REPLACE INTO player_match_query_components (
    player_match_summary_id, tries, goals, field_goals_1pt, field_goals_2pt,
    conversions_with_attempts, conversion_attempts,
    play_the_ball_total_seconds, play_the_ball, passes, all_runs,
    tackles_made, tackle_attempts, minutes_played, minutes_played_present
  ) VALUES (
    NEW.player_match_summary_id,
    COALESCE(CAST(json_extract(NEW.stats_json, '$."tries"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."goals"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."field_goals_1pt"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."field_goals_2pt"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."conversions_with_attempts"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."conversion_attempts"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."play_the_ball_total_seconds"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."play_the_ball"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."passes"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."all_runs"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."tackles_made"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."tackle_attempts"') AS REAL), 0),
    COALESCE(CAST(json_extract(NEW.stats_json, '$."minutes_played"') AS REAL), 0),
    CASE WHEN json_type(NEW.stats_json, '$."minutes_played"') IS NULL THEN 0 ELSE 1 END
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_player_match_query_components_delete
AFTER DELETE ON player_match_summary
BEGIN
  DELETE FROM player_match_query_components
  WHERE player_match_summary_id = OLD.player_match_summary_id;
END;
