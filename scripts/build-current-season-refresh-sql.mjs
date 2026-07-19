import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SEED_DIR, WRANGLER_STATE_DIR } from "./lib/project-paths.mjs";
import { sqlNumber, sqlString } from "./lib/sql.mjs";
import { seasonScopedRefreshDeleteStatements } from "./lib/seed-delete-order.mjs";

const STATE_DIR = WRANGLER_STATE_DIR;
const OUTPUT_DIR = SEED_DIR;

function parseCliArgs(argv) {
  const options = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      options.set(rawKey, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(rawKey, next);
      index += 1;
    } else {
      options.set(rawKey, "1");
    }
  }
  return options;
}

async function findLocalSqliteFile() {
  const entries = await fs.readdir(STATE_DIR, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
    const fullPath = path.join(STATE_DIR, entry.name);
    const stat = await fs.stat(fullPath);
    candidates.push({ fullPath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`No local D1 sqlite file found in ${STATE_DIR}`);
  }
  return candidates[0].fullPath;
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return sqlNumber(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return sqlString(value);
}

function buildInsertStatement(tableName, columns, row) {
  const columnSql = columns.join(", ");
  const valueSql = columns.map((column) => sqlValue(row[column])).join(", ");
  return `INSERT OR REPLACE INTO ${tableName} (${columnSql}) VALUES (${valueSql});`;
}

function listFromSet(values) {
  return [...values].filter((value) => value !== null && value !== undefined);
}

const cliArgs = parseCliArgs(process.argv);
const season = Number(cliArgs.get("season") ?? new Date().getUTCFullYear());
if (!Number.isFinite(season)) {
  throw new Error("Expected a numeric --season value.");
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const sqlitePath = await findLocalSqliteFile();
const db = new DatabaseSync(sqlitePath, { readonly: true });

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function getTableColumns(tableName) {
  return all(`PRAGMA table_info(${tableName});`).map((column) => column.name);
}

const seasonMatches = all("SELECT * FROM matches WHERE season = ? ORDER BY match_id", season);
const seasonMatchIds = seasonMatches.map((row) => row.match_id);
const venueIds = new Set(seasonMatches.map((row) => row.venue_id).filter((value) => value !== null));
const teamIds = new Set(
  seasonMatches.flatMap((row) => [row.home_team_id, row.away_team_id]).filter((value) => value !== null)
);

const seasonMatchIdPlaceholders = seasonMatchIds.map(() => "?").join(", ");
const seasonTeamSummaries = all(
  "SELECT * FROM team_match_summary WHERE season = ? ORDER BY team_match_summary_id",
  season
);
const seasonPlayerSummaries = all(
  "SELECT * FROM player_match_summary WHERE season = ? ORDER BY player_match_summary_id",
  season
);
const seasonPlayerAggregates = all(
  "SELECT * FROM player_stat_aggregates WHERE season = ? ORDER BY player_stat_aggregate_id",
  season
);
const seasonTeamSeasonAggregates = all(
  "SELECT * FROM team_season_aggregates WHERE season = ? ORDER BY team_season_aggregate_id",
  season
);
const seasonLegacyScoring = all(
  "SELECT * FROM legacy_player_scoring WHERE season = ? ORDER BY legacy_player_scoring_id",
  season
);
const playerIds = new Set(seasonPlayerSummaries.map((row) => row.player_id).filter((value) => value !== null));
for (const row of seasonPlayerAggregates) {
  if (row.player_id !== null && row.player_id !== undefined) {
    playerIds.add(row.player_id);
  }
}
for (const row of seasonLegacyScoring) {
  if (row.player_id !== null && row.player_id !== undefined) {
    playerIds.add(row.player_id);
  }
}

const venues = venueIds.size > 0
  ? all(`SELECT * FROM venues WHERE venue_id IN (${listFromSet(venueIds).map(() => "?").join(", ")}) ORDER BY venue_id`, ...listFromSet(venueIds))
  : [];
const teams = teamIds.size > 0
  ? all(`SELECT * FROM teams WHERE team_id IN (${listFromSet(teamIds).map(() => "?").join(", ")}) ORDER BY team_id`, ...listFromSet(teamIds))
  : [];
const players = playerIds.size > 0
  ? all(`SELECT * FROM players WHERE player_id IN (${listFromSet(playerIds).map(() => "?").join(", ")}) ORDER BY player_id`, ...listFromSet(playerIds))
  : [];
const playerAliases = playerIds.size > 0
  ? all(`SELECT * FROM player_aliases WHERE player_id IN (${listFromSet(playerIds).map(() => "?").join(", ")}) ORDER BY player_alias_id`, ...listFromSet(playerIds))
  : [];
const seasonMatchSources = seasonMatchIds.length > 0
  ? all(`SELECT * FROM match_sources WHERE match_id IN (${seasonMatchIdPlaceholders}) ORDER BY match_source_id`, ...seasonMatchIds)
  : [];

const statements = [];
statements.push("-- Generated by scripts/build-current-season-refresh-sql.mjs");
statements.push("BEGIN TRANSACTION;");
statements.push(...seasonScopedRefreshDeleteStatements(sqlNumber(season)));

for (const row of venues) {
  statements.push(buildInsertStatement("venues", getTableColumns("venues"), row));
}
for (const row of teams) {
  statements.push(buildInsertStatement("teams", getTableColumns("teams"), row));
}
for (const row of players) {
  statements.push(buildInsertStatement("players", getTableColumns("players"), row));
}
for (const row of playerAliases) {
  statements.push(buildInsertStatement("player_aliases", getTableColumns("player_aliases"), row));
}
for (const row of seasonMatches) {
  statements.push(buildInsertStatement("matches", getTableColumns("matches"), row));
}
for (const row of seasonMatchSources) {
  statements.push(buildInsertStatement("match_sources", getTableColumns("match_sources"), row));
}
for (const row of seasonLegacyScoring) {
  statements.push(buildInsertStatement("legacy_player_scoring", getTableColumns("legacy_player_scoring"), row));
}
for (const row of seasonPlayerAggregates) {
  statements.push(buildInsertStatement("player_stat_aggregates", getTableColumns("player_stat_aggregates"), row));
}
for (const row of seasonTeamSeasonAggregates) {
  statements.push(buildInsertStatement("team_season_aggregates", getTableColumns("team_season_aggregates"), row));
}
for (const row of seasonPlayerSummaries) {
  statements.push(buildInsertStatement("player_match_summary", getTableColumns("player_match_summary"), row));
}
for (const row of seasonTeamSummaries) {
  statements.push(buildInsertStatement("team_match_summary", getTableColumns("team_match_summary"), row));
}

statements.push("COMMIT;");

const outputPath = path.join(OUTPUT_DIR, `0100_current_season_refresh_${season}.sql`);
await fs.writeFile(outputPath, `${statements.join("\n")}\n`, "utf8");

console.log("Current-season refresh SQL:", outputPath);
console.log("Season:", season);
console.log("Matches:", seasonMatches.length);
console.log("Match sources:", seasonMatchSources.length);
console.log("Legacy scoring rows:", seasonLegacyScoring.length);
console.log("Player aggregates:", seasonPlayerAggregates.length);
console.log("Team season aggregates:", seasonTeamSeasonAggregates.length);
console.log("Team summaries:", seasonTeamSummaries.length);
console.log("Player summaries:", seasonPlayerSummaries.length);
