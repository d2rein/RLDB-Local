import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const databasePath = process.argv[3] ? path.resolve(process.argv[3]) : "";

function git(...args) {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${projectRoot.replaceAll("\\", "/")}`, ...args],
    { cwd: projectRoot, encoding: "utf8" }
  ).trim();
}

const fullCommit = git("rev-parse", "HEAD");
const shortCommit = fullCommit.slice(0, 12);
const status = git("status", "--porcelain=v1", "--untracked-files=all");
const excludedPrefixes = ["runtime-logs/", "runtime-data/", "reports/", ".wrangler/"];
const sourceChanges = status.split(/\r?\n/).filter(Boolean).filter((line) => {
  const relativePath = line.slice(3).replaceAll("\\", "/");
  return !excludedPrefixes.some((prefix) => relativePath.startsWith(prefix));
});
const hash = crypto.createHash("sha256");
for (const line of sourceChanges.sort()) {
  const relativePath = line.slice(3);
  hash.update(line.slice(0, 2));
  hash.update(relativePath);
  try {
    hash.update(await fs.readFile(path.join(projectRoot, relativePath)));
  } catch {
    hash.update(`${relativePath}:missing-or-unreadable`);
  }
}
const dirtyFingerprint = hash.digest("hex").slice(0, 12);
const applicationVersion = sourceChanges.length
  ? `${shortCommit}-dirty.${dirtyFingerprint}`
  : shortCommit;

let schemaVersion = "unavailable";
if (databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const rows = database.prepare(`
    SELECT type, name, COALESCE(sql, '') AS sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  schemaVersion = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
  database.close();
} else {
  const migrationDirectory = path.join(projectRoot, "migrations");
  const migrationFiles = (await fs.readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const schemaHash = crypto.createHash("sha256");
  for (const migrationFile of migrationFiles) {
    schemaHash.update(migrationFile);
    schemaHash.update(await fs.readFile(path.join(migrationDirectory, migrationFile)));
  }
  schemaVersion = `migrations-${schemaHash.digest("hex").slice(0, 16)}`;
}

process.stdout.write(JSON.stringify({
  applicationVersion,
  fullCommit,
  dirty: sourceChanges.length > 0,
  dirtyFingerprint: sourceChanges.length ? dirtyFingerprint : null,
  schemaVersion,
}));
