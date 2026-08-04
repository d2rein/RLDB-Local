import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const [mode, configArgument] = process.argv.slice(2);
if (!["prepare", "promote", "rollback"].includes(mode) || !configArgument) {
  throw new Error("Usage: node weekly-update.mjs <prepare|promote|rollback> <service.json>");
}
const configPath = path.resolve(configArgument);
const config = JSON.parse((await fsp.readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
const releaseRoot = path.resolve(config.releaseRoot);
const livePath = path.resolve(config.databasePath);
const dataRoot = path.resolve(config.updateDataRoot);
const stagingRoot = path.join(path.dirname(livePath), "staging");
const stagingPath = path.join(stagingRoot, "rldb-update.sqlite");
const previousRoot = path.join(path.dirname(livePath), "previous");
const previousPath = path.join(previousRoot, "rldb.sqlite");
const markerPath = path.join(stagingRoot, "prepared.json");
const statusPath = path.join(config.runtimeRoot, "update-status.json");
const season = Number(config.updateSeason || new Date().getFullYear());
const competitions = config.updateCompetitions || ["NRL", "NRLW"];

async function writeStatus(status, details = {}) {
  const payload = { atUtc: new Date().toISOString(), status, ...details };
  await fsp.mkdir(path.dirname(statusPath), { recursive: true });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(payload, null, 2));
  await fsp.rename(temporary, statusPath);
}
async function runNode(script, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(config.nodePath, [script, ...args], { cwd: releaseRoot, windowsHide: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(script)} exited ${code ?? signal}`)));
  });
}
function inspectDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    const freshness = db.prepare(`SELECT c.code,MAX(m.round_index) latest_round,COUNT(DISTINCT m.match_id) matches,COUNT(DISTINCT p.player_match_summary_id) player_rows
      FROM matches m JOIN competitions c ON c.competition_id=m.competition_id JOIN player_match_summary p ON p.match_id=m.match_id
      WHERE m.season=? AND c.code IN (${competitions.map(() => "?").join(",")}) GROUP BY c.code ORDER BY c.code`).all(season, ...competitions);
    return { integrity, bytes: fs.statSync(databasePath).size, freshness };
  } finally { db.close(); }
}

if (mode === "prepare") {
  await writeStatus("preparing", { season, competitions });
  await Promise.all([fsp.mkdir(stagingRoot, { recursive: true }), fsp.mkdir(dataRoot, { recursive: true })]);
  for (const competition of competitions) {
    await runNode(path.join(releaseRoot, "scripts", "update", "fetch-current-season.mjs"), [
      "--competition", competition, "--season", String(season), "--data-root", dataRoot,
    ]);
  }
  await fsp.rm(stagingPath, { force: true });
  const source = new DatabaseSync(livePath, { readOnly: true });
  try {
    await backup(source, stagingPath, { rate: 5000, progress: ({ totalPages, remainingPages }) => {
      if (remainingPages % 50000 < 5000) console.log(`SQLite staging backup: ${totalPages - remainingPages}/${totalPages}`);
    }});
  } finally { source.close(); }
  await runNode(path.join(releaseRoot, "scripts", "update", "import-current-season.mjs"), [
    "--database", stagingPath, "--data-root", dataRoot, "--season", String(season), "--competitions", competitions.join(","),
  ]);
  const before = inspectDatabase(livePath); const after = inspectDatabase(stagingPath);
  if (after.integrity !== "ok") throw new Error(`Prepared database integrity failed: ${after.integrity}`);
  const beforeByCode = new Map(before.freshness.map((row) => [row.code, row]));
  for (const row of after.freshness) {
    const old = beforeByCode.get(row.code);
    if (old && Number(row.latest_round) < Number(old.latest_round)) throw new Error(`${row.code} freshness regressed.`);
    if (old && Number(row.matches) < Number(old.matches)) throw new Error(`${row.code} match count regressed.`);
    // Small row-count reductions can be legitimate upstream corrections or duplicate cleanup.
    if (old && Number(row.player_rows) < Number(old.player_rows) * 0.95) {
      throw new Error(`${row.code} player rows regressed by more than 5%.`);
    }
  }
  const marker = { preparedAtUtc: new Date().toISOString(), season, competitions, before, after };
  await fsp.writeFile(markerPath, JSON.stringify(marker, null, 2));
  await writeStatus("prepared", marker);
  console.log(JSON.stringify(marker, null, 2));
}

if (mode === "promote") {
  const marker = JSON.parse(await fsp.readFile(markerPath, "utf8"));
  const staged = inspectDatabase(stagingPath);
  if (staged.integrity !== "ok" || staged.bytes < 100_000_000) throw new Error("Prepared database failed promotion checks.");
  await fsp.mkdir(previousRoot, { recursive: true });
  await fsp.rm(previousPath, { force: true });
  await fsp.rename(livePath, previousPath);
  try { await fsp.rename(stagingPath, livePath); }
  catch (error) { await fsp.rename(previousPath, livePath); throw error; }
  await fsp.rm(markerPath, { force: true });
  await writeStatus("promoted", { ...marker, promotedAtUtc: new Date().toISOString(), previousPath });
  console.log(`Promoted ${livePath}; rollback retained at ${previousPath}`);
}

if (mode === "rollback") {
  if (!fs.existsSync(previousPath)) throw new Error(`No rollback database exists at ${previousPath}`);
  const failedPath = `${livePath}.failed-${Date.now()}`;
  await fsp.rename(livePath, failedPath);
  try { await fsp.rename(previousPath, livePath); }
  catch (error) { await fsp.rename(failedPath, livePath); throw error; }
  await fsp.rm(failedPath, { force: true });
  await writeStatus("rolled_back", { rolledBackAtUtc: new Date().toISOString() });
}
