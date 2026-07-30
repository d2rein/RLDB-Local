import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) {
  throw new Error("Usage: node scripts/seed-from-sqlite.mjs <source.sqlite> <destination.sqlite>");
}

const sourcePath = path.resolve(sourceArgument);
const destinationPath = path.resolve(destinationArgument);
if (sourcePath.toLowerCase() === destinationPath.toLowerCase()) {
  throw new Error("Source and destination must be different databases.");
}
if (!fs.existsSync(sourcePath)) {
  throw new Error(`Source database does not exist: ${sourcePath}`);
}

await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
const temporaryPath = `${destinationPath}.seeding`;
await fsp.rm(temporaryPath, { force: true });

const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(source, temporaryPath, {
    rate: 200,
    progress({ totalPages, remainingPages }) {
      const completed = totalPages - remainingPages;
      if (completed === totalPages || completed % 50000 === 0) {
        console.log(`SQLite backup pages: ${completed}/${totalPages}`);
      }
    },
  });
} finally {
  source.close();
}

const seeded = new DatabaseSync(temporaryPath, { readOnly: true });
let summary;
try {
  const integrity = seeded.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") {
    throw new Error(`Seeded database integrity check failed: ${JSON.stringify(integrity)}`);
  }
  const expectedTables = [
    "matches",
    "player_match_summary",
    "team_match_summary",
    "player_stat_aggregates",
    "team_season_aggregates",
  ];
  summary = {
    sourcePath,
    destinationPath,
    bytes: fs.statSync(temporaryPath).size,
    integrity: integrity.integrity_check,
    tables: {},
  };
  for (const table of expectedTables) {
    const exists = seeded
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) throw new Error(`Seeded database is missing required table: ${table}`);
    summary.tables[table] = Number(
      seeded.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count
    );
  }
} finally {
  seeded.close();
}

await fsp.rm(destinationPath, { force: true });
await fsp.rename(temporaryPath, destinationPath);
console.log(JSON.stringify(summary, null, 2));
