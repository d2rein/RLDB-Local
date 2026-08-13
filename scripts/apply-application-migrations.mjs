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
  database.exec(`
    CREATE TABLE IF NOT EXISTS application_migrations (
      migration_name TEXT PRIMARY KEY,
      applied_at_utc TEXT NOT NULL
    )
  `);
  const wasApplied = database.prepare(
    "SELECT 1 FROM application_migrations WHERE migration_name = ? LIMIT 1",
  );
  const recordMigration = database.prepare(
    "INSERT INTO application_migrations (migration_name, applied_at_utc) VALUES (?, ?)",
  );
  for (const migrationFile of migrationFiles) {
    if (wasApplied.get(migrationFile)) {
      console.log(`Already applied ${migrationFile}`);
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(readFileSync(resolve(migrationsPath, migrationFile), "utf8"));
      recordMigration.run(migrationFile, new Date().toISOString());
      database.exec("COMMIT");
      console.log(`Applied ${migrationFile}`);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
} finally {
  database.close();
}
