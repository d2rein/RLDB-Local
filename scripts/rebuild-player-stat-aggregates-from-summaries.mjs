import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WRANGLER_STATE_DIR } from "./lib/project-paths.mjs";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const separator = value.indexOf("=");
    if (separator >= 0) {
      args.set(value.slice(2, separator), value.slice(separator + 1));
    } else {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        args.set(value.slice(2), next);
        index += 1;
      } else {
        args.set(value.slice(2), "1");
      }
    }
  }
  return args;
}

async function findOperationalDatabase() {
  const entries = await fsp.readdir(WRANGLER_STATE_DIR, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite")
    .map(async (entry) => {
      const filePath = path.join(WRANGLER_STATE_DIR, entry.name);
      return { filePath, stat: await fsp.stat(filePath) };
    }));
  candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  const preferred = candidates.find((candidate) => path.basename(candidate.filePath) !== "local.sqlite") ?? candidates[0];
  if (!preferred) throw new Error("Unable to locate the operational local D1 SQLite database.");
  return preferred.filePath;
}

const args = parseArgs(process.argv.slice(2));
const explicitPath = args.get("database");
if (!explicitPath && args.get("operational") !== "1") {
  throw new Error("Pass --database <path> for an isolated database or --operational for the active local database.");
}

const databasePath = path.resolve(explicitPath || await findOperationalDatabase());
if (!fs.existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`);

const db = new DatabaseSync(databasePath);
const startedAt = Date.now();
console.log(`Rebuilding player_stat_aggregates from player_match_summary: ${databasePath}`);

db.exec(`
  DROP TABLE IF EXISTS temp.rebuilt_player_stat_aggregates;
  DROP TABLE IF EXISTS temp.rebuilt_player_game_counts;
  CREATE TEMP TABLE rebuilt_player_stat_aggregates (
    player_stat_aggregate_id INTEGER PRIMARY KEY,
    player_id INTEGER,
    player_name_raw TEXT NOT NULL,
    source TEXT NOT NULL,
    scope TEXT NOT NULL,
    season INTEGER,
    stat_key TEXT NOT NULL,
    total_value REAL NOT NULL,
    recorded_games INTEGER NOT NULL,
    total_games INTEGER NOT NULL,
    first_season INTEGER,
    last_season INTEGER
  );

  CREATE TEMP TABLE rebuilt_player_game_counts AS
  SELECT
    s.player_id,
    COALESCE(p.display_name, s.player_name_raw) AS player_name_raw,
    lower(c.code) AS source,
    s.season,
    COUNT(*) AS total_games
  FROM player_match_summary s
  LEFT JOIN players p ON p.player_id = s.player_id
  JOIN matches m ON m.match_id = s.match_id
  JOIN competitions c ON c.competition_id = m.competition_id
  GROUP BY s.player_id, COALESCE(p.display_name, s.player_name_raw), lower(c.code), s.season;

  CREATE INDEX temp.idx_rebuilt_player_game_counts
    ON rebuilt_player_game_counts(player_id, player_name_raw, source, season);

  INSERT INTO rebuilt_player_stat_aggregates (
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
  SELECT
    games.player_id,
    games.player_name_raw,
    games.source,
    'season',
    games.season,
    'games_played',
    games.total_games,
    games.total_games,
    games.total_games,
    games.season,
    games.season
  FROM rebuilt_player_game_counts games;
`);

const statDefinitions = db.prepare(`
  SELECT stat_key, missing_value_strategy
  FROM stat_definitions
  WHERE scope = 'player'
    AND is_enabled = 1
    AND stat_key <> 'games_played'
  ORDER BY stat_key
`).all();
const insertStat = db.prepare(`
  INSERT INTO rebuilt_player_stat_aggregates (
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
  SELECT
    s.player_id,
    COALESCE(p.display_name, s.player_name_raw),
    lower(c.code),
    'season',
    s.season,
    ?,
    SUM(values_table.stat_value_num),
    CASE WHEN ? = 'zero_if_missing' THEN games.total_games ELSE COUNT(values_table.stat_value_num) END,
    games.total_games,
    s.season,
    s.season
  FROM player_match_stat_values values_table
  JOIN player_match_summary s
    ON s.player_match_summary_id = values_table.player_match_summary_id
  LEFT JOIN players p ON p.player_id = s.player_id
  JOIN matches m ON m.match_id = s.match_id
  JOIN competitions c ON c.competition_id = m.competition_id
  JOIN rebuilt_player_game_counts games
    ON games.player_id IS s.player_id
    AND games.player_name_raw = COALESCE(p.display_name, s.player_name_raw)
    AND games.source = lower(c.code)
    AND games.season = s.season
  WHERE values_table.stat_key = ?
    AND values_table.stat_value_num IS NOT NULL
  GROUP BY
    s.player_id,
    COALESCE(p.display_name, s.player_name_raw),
    lower(c.code),
    s.season,
    games.total_games
`);

for (const [index, definition] of statDefinitions.entries()) {
  const statStartedAt = Date.now();
  insertStat.run(definition.stat_key, definition.missing_value_strategy, definition.stat_key);
  console.log(
    `[${index + 1}/${statDefinitions.length}] ${definition.stat_key} `
    + `${((Date.now() - statStartedAt) / 1000).toFixed(1)}s`
  );
}

const rebuiltCount = Number(db.prepare("SELECT COUNT(*) AS count FROM temp.rebuilt_player_stat_aggregates").get().count);
if (rebuiltCount <= 0) throw new Error("Aggregate rebuild produced no rows; active table was not changed.");

const duplicateCount = Number(db.prepare(`
  SELECT COUNT(*) AS count
  FROM (
    SELECT player_id, player_name_raw, source, season, stat_key, COUNT(*) AS copies
    FROM temp.rebuilt_player_stat_aggregates
    GROUP BY player_id, player_name_raw, source, season, stat_key
    HAVING COUNT(*) > 1
  )
`).get().count);
if (duplicateCount > 0) throw new Error(`Aggregate rebuild produced ${duplicateCount} duplicate keys; active table was not changed.`);

db.exec("BEGIN IMMEDIATE TRANSACTION;");
try {
  db.exec(`
    DELETE FROM player_stat_aggregates;
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
    SELECT
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
    FROM temp.rebuilt_player_stat_aggregates
    ORDER BY player_name_raw, source, season, stat_key;
  `);
  db.exec("COMMIT;");
} catch (error) {
  db.exec("ROLLBACK;");
  throw error;
}

const activeCount = Number(db.prepare("SELECT COUNT(*) AS count FROM player_stat_aggregates").get().count);
console.log(`Player aggregate rows: ${activeCount.toLocaleString()}`);
console.log(`Completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
db.close();
