import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./lib/csv.mjs";

const DOCS_DIR = "C:\\Users\\d2rei\\Rugby-League-Stats-Database\\docs";

function toCsv(rows) {
  if (rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const raw = String(value ?? "");
    return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, "\"\"")}"` : raw;
  };

  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
}

function topSuggestedName(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  const first = text.split(" || ")[0];
  return first.split(" [score=")[0].trim();
}

const candidatesPath = path.join(DOCS_DIR, "players_reconciliation_candidates.csv");
const candidates = parseCsv(await fs.readFile(candidatesPath, "utf8"));

const reviewRows = candidates.filter((row) =>
  ["nrl_only", "afltables_only", "ambiguous_multiple_afltables", "matched_name_only_review"].includes(
    row.suggested_status
  )
);

const nrlRows = parseCsv(await fs.readFile(path.join(DOCS_DIR, "players_nrl_player_stats.csv"), "utf8"));
const aflRows = parseCsv(await fs.readFile(path.join(DOCS_DIR, "players_afltables_scorers.csv"), "utf8"));
const nrlByName = new Map(nrlRows.map((row) => [row.player_name, row]));
const aflByName = new Map(aflRows.map((row) => [row.player_name, row]));

const simpleRows = reviewRows
  .map((row) => {
    const source = row.suggested_status === "nrl_only" ? "NRL.com" : "AFL Tables";
    const unmatchedName = source === "NRL.com" ? row.nrl_player_name : row.afl_player_name;
    const gamesRecorded = source === "NRL.com" ? row.nrl_match_count : row.afl_scoring_match_count;
    const suggestedName = topSuggestedName(source === "NRL.com" ? row.possible_afl_matches : row.possible_nrl_matches);

    return {
      source,
      unmatched_name: unmatchedName,
      games_recorded: gamesRecorded,
      suggested_name: suggestedName,
      suggested_nrl_games: suggestedName ? nrlByName.get(suggestedName)?.match_count ?? "" : "",
      suggested_afl_games: suggestedName ? aflByName.get(suggestedName)?.match_count ?? "" : "",
    };
  })
  .sort((a, b) => {
    if (a.source !== b.source) {
      return a.source.localeCompare(b.source);
    }
    return a.unmatched_name.localeCompare(b.unmatched_name);
  });

await fs.writeFile(path.join(DOCS_DIR, "players_reconciliation_review_only.csv"), toCsv(reviewRows), "utf8");
await fs.writeFile(path.join(DOCS_DIR, "players_reconciliation_review_simple.csv"), toCsv(simpleRows), "utf8");

console.log("Review rows:", reviewRows.length);
console.log("Simple review rows:", simpleRows.length);
