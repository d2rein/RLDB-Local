import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SEED_DIR, WRANGLER_STATE_DIR } from "./lib/project-paths.mjs";

const D1_DIR = WRANGLER_STATE_DIR;
const MIGRATIONS_DIR = path.join(path.dirname(SEED_DIR), "migrations");
const APPLY_CURRENT_REFRESH = process.env.D1_LOCAL_APPLY_CURRENT_REFRESH === "1";

async function findDatabaseFile() {
  await fs.mkdir(D1_DIR, { recursive: true });
  const entries = await fs.readdir(D1_DIR);
  const sqliteFiles = entries
    .filter((entry) => entry.endsWith(".sqlite"))
    .filter((entry) => entry !== "metadata.sqlite")
    .sort();
  const preferredRuntimeFiles = sqliteFiles.filter((entry) => entry !== "local.sqlite");
  if (preferredRuntimeFiles.length > 0) {
    return path.join(D1_DIR, preferredRuntimeFiles[0]);
  }
  if (sqliteFiles.length === 0) {
    const fallbackPath = path.join(D1_DIR, "local.sqlite");
    await fs.writeFile(fallbackPath, "");
    return fallbackPath;
  }
  return path.join(D1_DIR, sqliteFiles[0]);
}

async function readSqlFiles(dirPath) {
  const entries = await fs.readdir(dirPath);
  return entries
    .filter((entry) => entry.endsWith(".sql"))
    .filter((entry) => APPLY_CURRENT_REFRESH || !entry.startsWith("0100_current_season_refresh_"))
    .sort()
    .map((entry) => ({
      name: entry,
      fullPath: path.join(dirPath, entry),
    }));
}

function partitionFiles(files) {
  const legacyAggregateUnify = [];
  const remaining = [];

  for (const file of files) {
    if (file.name === "0005_unify_legacy_scoring_into_aggregates.sql") {
      legacyAggregateUnify.push(file);
    } else {
      remaining.push(file);
    }
  }

  return { remaining, legacyAggregateUnify };
}

function stripTransactionControl(sql) {
  return sql
    .replace(/^\s*BEGIN(?:\s+TRANSACTION)?\s*;\s*$/gim, "")
    .replace(/^\s*COMMIT\s*;\s*$/gim, "")
    .replace(/^\s*END\s+TRANSACTION\s*;\s*$/gim, "");
}

const dbPath = await findDatabaseFile();
await fs.rm(dbPath, { force: true });
const migrationFiles = await readSqlFiles(MIGRATIONS_DIR);
const seedFiles = await readSqlFiles(SEED_DIR);
const { remaining: baseMigrationFiles, legacyAggregateUnify } = partitionFiles(migrationFiles);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = OFF;");

for (const file of [...baseMigrationFiles, ...seedFiles, ...legacyAggregateUnify]) {
  const sql = stripTransactionControl(await fs.readFile(file.fullPath, "utf8"));
  const fileStartedAt = Date.now();

  console.log(`Applying ${file.name}...`);
  db.exec("BEGIN TRANSACTION;");
  try {
    db.exec(sql);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  console.log(`Applied ${file.name} in ${Math.floor((Date.now() - fileStartedAt) / 1000)}s`);
}

db.exec("PRAGMA foreign_keys = ON;");

const counts = {};
for (const table of ["competitions", "stat_groups", "stat_definitions", "venues", "teams", "players", "player_aliases", "matches", "match_sources", "legacy_player_scoring", "player_stat_aggregates", "team_season_aggregates", "player_match_summary", "team_match_summary"]) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  counts[table] = row.count;
}

console.log("Local D1 sqlite:", dbPath);
console.log("Counts:", counts);
