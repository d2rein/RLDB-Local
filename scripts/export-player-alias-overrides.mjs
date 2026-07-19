import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./lib/csv.mjs";

const DOCS_DIR = "C:\\Users\\d2rei\\Rugby-League-Stats-Database\\docs";

const overridesPath = path.join(DOCS_DIR, "player_reconciliation_overrides.csv");
const outputPath = path.join(DOCS_DIR, "player_alias_overrides.json");

const rows = parseCsv(await fs.readFile(overridesPath, "utf8"));
const approved = rows
  .filter((row) => String(row.status ?? "").toLowerCase() === "approved")
  .map((row) => ({
    nrlPlayerName: row.nrl_player_name,
    aflPlayerName: row.afl_player_name,
    notes: row.notes,
  }))
  .sort((a, b) => a.nrlPlayerName.localeCompare(b.nrlPlayerName));

await fs.writeFile(outputPath, `${JSON.stringify(approved, null, 2)}\n`, "utf8");

console.log("Approved overrides exported:", approved.length);
console.log("Output:", outputPath);
