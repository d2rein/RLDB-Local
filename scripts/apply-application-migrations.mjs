import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const projectRoot = resolve(import.meta.dirname, "..");
const [databaseArgument] = process.argv.slice(2);
const databasePath = resolve(
  databaseArgument || process.env.RLDB_DATABASE_PATH || resolve(projectRoot, "../rldb-direct-node-runtime/data/rldb.sqlite"),
);
const migrationsPath = resolve(projectRoot, "migrations/application");
const migrationFiles = readdirSync(migrationsPath)
  .filter((name) => /^\d+.*\.sql$/i.test(name))
  .sort();

const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout = 10000");
try {
  for (const migrationFile of migrationFiles) {
    database.exec(readFileSync(resolve(migrationsPath, migrationFile), "utf8"));
    console.log(`Applied ${migrationFile}`);
  }
} finally {
  database.close();
}
