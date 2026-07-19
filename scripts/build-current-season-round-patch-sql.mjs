import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqlNumber, sqlString } from "./lib/sql.mjs";

const PROJECT_ROOT = "C:\\Users\\d2rei\\Rugby-League-Stats-Database";
const STATE_DIR = path.join(PROJECT_ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "seed");

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
  return `INSERT OR REPLACE INTO ${tableName} (${columns.join(", ")}) VALUES (${columns
    .map((column) => sqlValue(row[column]))
    .join(", ")});`;
}

function buildUpdateStatement(tableName, keyColumn, columns, row) {
  const assignments = columns
    .filter((column) => column !== keyColumn)
    .map((column) => `${column} = ${sqlValue(row[column])}`)
    .join(", ");
  return `UPDATE ${tableName} SET ${assignments} WHERE ${keyColumn} = ${sqlValue(row[keyColumn])};`;
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function listFromSet(values) {
  return [...values].filter((value) => value !== null && value !== undefined);
}

const cliArgs = parseCliArgs(process.argv);
const season = Number(cliArgs.get("season") ?? new Date().getUTCFullYear());
const fromRound = Number(cliArgs.get("from-round"));
const toRound = Number(cliArgs.get("to-round") ?? 99);

if (!Number.isFinite(season) || !Number.isFinite(fromRound) || !Number.isFinite(toRound)) {
  throw new Error("Expected numeric --season, --from-round, and optional --to-round values.");
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

const targetMatches = all(
  "SELECT * FROM matches WHERE season = ? AND round_index BETWEEN ? AND ? ORDER BY match_id",
  season,
  fromRound,
  toRound
);
const targetMatchIds = targetMatches.map((row) => row.match_id);
if (targetMatchIds.length === 0) {
  throw new Error(`No matches found for ${season} rounds ${fromRound}-${toRound}.`);
}

const targetMatchIdSql = placeholders(targetMatchIds);
const targetTeamSummaries = all(
  `SELECT * FROM team_match_summary WHERE match_id IN (${targetMatchIdSql}) ORDER BY team_match_summary_id`,
  ...targetMatchIds
);
const targetTeamSeasonAggregates = all(
  "SELECT * FROM team_season_aggregates WHERE season = ? ORDER BY team_season_aggregate_id",
  season
);
const targetPlayerSummaries = all(
  `SELECT * FROM player_match_summary WHERE match_id IN (${targetMatchIdSql}) ORDER BY player_match_summary_id`,
  ...targetMatchIds
);
const targetLegacyScoring = all(
  `SELECT * FROM legacy_player_scoring WHERE match_id IN (${targetMatchIdSql}) ORDER BY legacy_player_scoring_id`,
  ...targetMatchIds
);
const targetMatchSources = all(
  `SELECT * FROM match_sources WHERE match_id IN (${targetMatchIdSql}) ORDER BY match_source_id`,
  ...targetMatchIds
);

const venueIds = new Set(targetMatches.map((row) => row.venue_id).filter((value) => value !== null));
const teamIds = new Set(
  targetMatches.flatMap((row) => [row.home_team_id, row.away_team_id]).filter((value) => value !== null)
);
const playerIds = new Set();
for (const row of targetPlayerSummaries) {
  if (row.player_id !== null && row.player_id !== undefined) playerIds.add(row.player_id);
}
for (const row of targetLegacyScoring) {
  if (row.player_id !== null && row.player_id !== undefined) playerIds.add(row.player_id);
}

const venues = venueIds.size
  ? all(`SELECT * FROM venues WHERE venue_id IN (${placeholders(listFromSet(venueIds))}) ORDER BY venue_id`, ...listFromSet(venueIds))
  : [];
const teams = teamIds.size
  ? all(`SELECT * FROM teams WHERE team_id IN (${placeholders(listFromSet(teamIds))}) ORDER BY team_id`, ...listFromSet(teamIds))
  : [];
const players = playerIds.size
  ? all(`SELECT * FROM players WHERE player_id IN (${placeholders(listFromSet(playerIds))}) ORDER BY player_id`, ...listFromSet(playerIds))
  : [];
const playerAliases = playerIds.size
  ? all(
      `SELECT * FROM player_aliases WHERE player_id IN (${placeholders(listFromSet(playerIds))}) ORDER BY player_alias_id`,
      ...listFromSet(playerIds)
    )
  : [];

const statements = [];
statements.push(`-- Generated by scripts/build-current-season-round-patch-sql.mjs for ${season} rounds ${fromRound}-${toRound}`);
statements.push(`DELETE FROM team_match_summary WHERE match_id IN (${targetMatchIds.join(", ")});`);
statements.push(`DELETE FROM team_season_aggregates WHERE season = ${season};`);
statements.push(`DELETE FROM player_match_summary WHERE match_id IN (${targetMatchIds.join(", ")});`);
statements.push(`DELETE FROM legacy_player_scoring WHERE match_id IN (${targetMatchIds.join(", ")});`);
statements.push(`DELETE FROM match_sources WHERE match_id IN (${targetMatchIds.join(", ")});`);

for (const row of venues) statements.push(buildInsertStatement("venues", getTableColumns("venues"), row));
for (const row of teams) statements.push(buildInsertStatement("teams", getTableColumns("teams"), row));
for (const row of players) statements.push(buildInsertStatement("players", getTableColumns("players"), row));
for (const row of playerAliases) statements.push(buildInsertStatement("player_aliases", getTableColumns("player_aliases"), row));
for (const row of targetMatches) statements.push(buildUpdateStatement("matches", "match_id", getTableColumns("matches"), row));
for (const row of targetMatchSources) statements.push(buildInsertStatement("match_sources", getTableColumns("match_sources"), row));
for (const row of targetLegacyScoring) statements.push(buildInsertStatement("legacy_player_scoring", getTableColumns("legacy_player_scoring"), row));
for (const row of targetTeamSeasonAggregates) statements.push(buildInsertStatement("team_season_aggregates", getTableColumns("team_season_aggregates"), row));
for (const row of targetPlayerSummaries) statements.push(buildInsertStatement("player_match_summary", getTableColumns("player_match_summary"), row));
for (const row of targetTeamSummaries) statements.push(buildInsertStatement("team_match_summary", getTableColumns("team_match_summary"), row));

const outputPath = path.join(OUTPUT_DIR, `0101_current_season_round_${fromRound}_${toRound}_patch_${season}.sql`);
await fs.writeFile(outputPath, `${statements.join("\n")}\n`, "utf8");

console.log("Current-season round patch SQL:", outputPath);
console.log("Season:", season);
console.log("Rounds:", `${fromRound}-${toRound}`);
console.log("Matches:", targetMatches.length);
console.log("Match sources:", targetMatchSources.length);
console.log("Legacy scoring rows:", targetLegacyScoring.length);
console.log("Team season aggregates:", targetTeamSeasonAggregates.length);
console.log("Team summaries:", targetTeamSummaries.length);
console.log("Player summaries:", targetPlayerSummaries.length);
