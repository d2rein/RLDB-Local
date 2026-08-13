UPDATE player_match_query_components
SET minutes_played_present = 0
WHERE minutes_played_present <> 0
  AND EXISTS (
    SELECT 1
    FROM player_match_summary s
    WHERE s.player_match_summary_id = player_match_query_components.player_match_summary_id
      AND COALESCE(json_type(s.stats_json, '$."minutes_played"'), 'null') = 'null'
  );

DROP TRIGGER IF EXISTS trg_player_match_query_components_insert;
DROP TRIGGER IF EXISTS trg_player_match_query_components_update;

CREATE TRIGGER trg_player_match_query_components_insert
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
    CASE WHEN COALESCE(json_type(NEW.stats_json, '$."minutes_played"'), 'null') = 'null' THEN 0 ELSE 1 END
  );
END;

CREATE TRIGGER trg_player_match_query_components_update
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
    CASE WHEN COALESCE(json_type(NEW.stats_json, '$."minutes_played"'), 'null') = 'null' THEN 0 ELSE 1 END
  );
END;
