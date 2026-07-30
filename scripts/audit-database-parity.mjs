import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const [leftPath, rightPath] = process.argv.slice(2);
if (!leftPath || !rightPath) {
  throw new Error("Usage: node scripts/audit-database-parity.mjs <left.sqlite> <right.sqlite>");
}

const tableNames = [
  "competitions",
  "matches",
  "players",
  "player_match_summary",
  "player_match_stat_values",
  "player_stat_aggregates",
  "team_match_summary",
  "team_match_stat_values",
  "team_season_aggregates",
];

function inspect(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const objects = database.prepare(`
    SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'view', 'trigger')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  const availableTables = new Set(
    objects.filter((row) => row.type === "table").map((row) => row.name)
  );
  const rowCounts = Object.fromEntries(
    tableNames
      .filter((tableName) => availableTables.has(tableName))
      .map((tableName) => [
        tableName,
        Number(database.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count),
      ])
  );
  const cutoff = availableTables.has("matches")
    ? database.prepare(`
        SELECT
          MAX(season) AS max_season,
          MAX(match_date_utc) AS max_match_date_utc,
          MAX(match_id) AS max_match_id
        FROM matches
      `).get()
    : null;
  database.close();

  const normalizedObjects = objects.map((row) => ({
    ...row,
    sql: String(row.sql).replace(/\s+/g, " ").trim(),
  }));
  return {
    path: databasePath,
    objectCount: normalizedObjects.length,
    tableCount: normalizedObjects.filter((row) => row.type === "table").length,
    indexCount: normalizedObjects.filter((row) => row.type === "index").length,
    schemaHash: crypto
      .createHash("sha256")
      .update(JSON.stringify(normalizedObjects))
      .digest("hex"),
    objects: normalizedObjects,
    rowCounts,
    cutoff,
  };
}

const left = inspect(leftPath);
const right = inspect(rightPath);
const leftObjects = new Map(left.objects.map((row) => [`${row.type}:${row.name}`, row]));
const rightObjects = new Map(right.objects.map((row) => [`${row.type}:${row.name}`, row]));
const objectKeys = [...new Set([...leftObjects.keys(), ...rightObjects.keys()])].sort();
const objectDifferences = objectKeys
  .map((key) => ({
    key,
    left: leftObjects.get(key) ?? null,
    right: rightObjects.get(key) ?? null,
  }))
  .filter((entry) => JSON.stringify(entry.left) !== JSON.stringify(entry.right));

const rowCountDifferences = tableNames
  .map((tableName) => ({
    tableName,
    left: left.rowCounts[tableName] ?? null,
    right: right.rowCounts[tableName] ?? null,
  }))
  .filter((entry) => entry.left !== entry.right);

console.log(JSON.stringify({
  left: {
    path: left.path,
    objectCount: left.objectCount,
    tableCount: left.tableCount,
    indexCount: left.indexCount,
    schemaHash: left.schemaHash,
    rowCounts: left.rowCounts,
    cutoff: left.cutoff,
  },
  right: {
    path: right.path,
    objectCount: right.objectCount,
    tableCount: right.tableCount,
    indexCount: right.indexCount,
    schemaHash: right.schemaHash,
    rowCounts: right.rowCounts,
    cutoff: right.cutoff,
  },
  schemaMatches: objectDifferences.length === 0,
  objectDifferenceCount: objectDifferences.length,
  objectDifferences: objectDifferences.slice(0, 50),
  rowCountsMatch: rowCountDifferences.length === 0,
  rowCountDifferences,
  cutoffMatches: JSON.stringify(left.cutoff) === JSON.stringify(right.cutoff),
}, null, 2));
