CREATE TABLE IF NOT EXISTS player_match_stat_values (
  player_match_stat_value_id INTEGER PRIMARY KEY,
  player_match_summary_id INTEGER NOT NULL,
  stat_key TEXT NOT NULL,
  stat_value_text TEXT,
  stat_value_num REAL,
  FOREIGN KEY (player_match_summary_id) REFERENCES player_match_summary(player_match_summary_id),
  UNIQUE(player_match_summary_id, stat_key)
);

CREATE TABLE IF NOT EXISTS team_match_stat_values (
  team_match_stat_value_id INTEGER PRIMARY KEY,
  team_match_summary_id INTEGER NOT NULL,
  stat_key TEXT NOT NULL,
  stat_value_text TEXT,
  stat_value_num REAL,
  FOREIGN KEY (team_match_summary_id) REFERENCES team_match_summary(team_match_summary_id),
  UNIQUE(team_match_summary_id, stat_key)
);

CREATE INDEX IF NOT EXISTS idx_player_match_stat_values_lookup
  ON player_match_stat_values(player_match_summary_id, stat_key);

CREATE INDEX IF NOT EXISTS idx_player_match_stat_values_key_num
  ON player_match_stat_values(stat_key, stat_value_num);

CREATE INDEX IF NOT EXISTS idx_team_match_stat_values_lookup
  ON team_match_stat_values(team_match_summary_id, stat_key);

CREATE INDEX IF NOT EXISTS idx_team_match_stat_values_key_num
  ON team_match_stat_values(stat_key, stat_value_num);

CREATE TRIGGER IF NOT EXISTS trg_player_match_summary_stat_values_ai
AFTER INSERT ON player_match_summary
BEGIN
  INSERT OR REPLACE INTO player_match_stat_values (player_match_summary_id, stat_key, stat_value_text, stat_value_num)
  SELECT
    NEW.player_match_summary_id,
    j.key,
    CASE
      WHEN j.type = 'null' THEN NULL
      ELSE CAST(j.value AS TEXT)
    END,
    CASE
      WHEN j.type = 'integer' OR j.type = 'real' THEN CAST(j.value AS REAL)
      WHEN j.type = 'true' THEN 1
      WHEN j.type = 'false' THEN 0
      ELSE NULL
    END
  FROM json_each(NEW.stats_json) j;
END;

CREATE TRIGGER IF NOT EXISTS trg_player_match_summary_stat_values_au
AFTER UPDATE OF stats_json ON player_match_summary
BEGIN
  DELETE FROM player_match_stat_values
  WHERE player_match_summary_id = NEW.player_match_summary_id;

  INSERT OR REPLACE INTO player_match_stat_values (player_match_summary_id, stat_key, stat_value_text, stat_value_num)
  SELECT
    NEW.player_match_summary_id,
    j.key,
    CASE
      WHEN j.type = 'null' THEN NULL
      ELSE CAST(j.value AS TEXT)
    END,
    CASE
      WHEN j.type = 'integer' OR j.type = 'real' THEN CAST(j.value AS REAL)
      WHEN j.type = 'true' THEN 1
      WHEN j.type = 'false' THEN 0
      ELSE NULL
    END
  FROM json_each(NEW.stats_json) j;
END;

CREATE TRIGGER IF NOT EXISTS trg_player_match_summary_stat_values_ad
AFTER DELETE ON player_match_summary
BEGIN
  DELETE FROM player_match_stat_values
  WHERE player_match_summary_id = OLD.player_match_summary_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_team_match_summary_stat_values_ai
AFTER INSERT ON team_match_summary
BEGIN
  INSERT OR REPLACE INTO team_match_stat_values (team_match_summary_id, stat_key, stat_value_text, stat_value_num)
  SELECT
    NEW.team_match_summary_id,
    j.key,
    CASE
      WHEN j.type = 'null' THEN NULL
      ELSE CAST(j.value AS TEXT)
    END,
    CASE
      WHEN j.type = 'integer' OR j.type = 'real' THEN CAST(j.value AS REAL)
      WHEN j.type = 'true' THEN 1
      WHEN j.type = 'false' THEN 0
      ELSE NULL
    END
  FROM json_each(NEW.stats_json) j;
END;

CREATE TRIGGER IF NOT EXISTS trg_team_match_summary_stat_values_au
AFTER UPDATE OF stats_json ON team_match_summary
BEGIN
  DELETE FROM team_match_stat_values
  WHERE team_match_summary_id = NEW.team_match_summary_id;

  INSERT OR REPLACE INTO team_match_stat_values (team_match_summary_id, stat_key, stat_value_text, stat_value_num)
  SELECT
    NEW.team_match_summary_id,
    j.key,
    CASE
      WHEN j.type = 'null' THEN NULL
      ELSE CAST(j.value AS TEXT)
    END,
    CASE
      WHEN j.type = 'integer' OR j.type = 'real' THEN CAST(j.value AS REAL)
      WHEN j.type = 'true' THEN 1
      WHEN j.type = 'false' THEN 0
      ELSE NULL
    END
  FROM json_each(NEW.stats_json) j;
END;

CREATE TRIGGER IF NOT EXISTS trg_team_match_summary_stat_values_ad
AFTER DELETE ON team_match_summary
BEGIN
  DELETE FROM team_match_stat_values
  WHERE team_match_summary_id = OLD.team_match_summary_id;
END;
