import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./lib/csv.mjs";
import { DOCS_DIR } from "./lib/project-paths.mjs";
import { LONG_CAREER_SPLITS_CSV, seasonRangeOverlaps } from "./lib/player-splits.mjs";

const LONG_CAREERS_CSV = path.join(DOCS_DIR, "player_long_careers_ordered.csv");

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function parseSplitRowText(text) {
  const match = String(text).trim().match(/^(.*?)\s+(\d{4})(?:-(\d{4}))?\s+T:(-?\d+)\s+P:(-?\d+)$/);
  if (!match) return null;
  const playerName = match[1].trim();
  const firstSeason = Number(match[2]);
  const lastSeason = Number(match[3] ?? match[2]);
  return {
    playerName,
    firstSeason,
    lastSeason,
    tries: Number(match[4]),
    points: Number(match[5]),
  };
}

function buildSplitDisplayName(baseDisplayName, firstSeason, lastSeason) {
  return firstSeason === lastSeason
    ? `${baseDisplayName} [${firstSeason}]`
    : `${baseDisplayName} [${firstSeason}-${lastSeason}]`;
}

const rows = parseCsv(await fs.readFile(LONG_CAREERS_CSV, "utf8"));
const outputRows = [];

for (const row of rows) {
  const count = Number(row.afl_points_record_count ?? 0);
  if (count <= 1) continue;

  const rawUrls = String(row.afl_points_urls ?? "")
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);
  const rawSegments = String(row.afl_points_rows ?? "")
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);

  if (rawUrls.length !== rawSegments.length) {
    outputRows.push({
      base_display_name: row.display_name,
      split_display_name: "",
      first_season: "",
      last_season: "",
      afltables_player_url: "",
      afltables_tries: "",
      afltables_points: "",
      apply_split: 0,
      split_status: "parse_error_length_mismatch",
    });
    continue;
  }

  const splitRows = rawSegments.map((segment, index) => ({
    ...parseSplitRowText(segment),
    afltablesPlayerUrl: rawUrls[index],
  }));

  if (splitRows.some((entry) => !entry)) {
    outputRows.push({
      base_display_name: row.display_name,
      split_display_name: "",
      first_season: "",
      last_season: "",
      afltables_player_url: "",
      afltables_tries: "",
      afltables_points: "",
      apply_split: 0,
      split_status: "parse_error_row_format",
    });
    continue;
  }

  splitRows.sort((left, right) => left.firstSeason - right.firstSeason || left.lastSeason - right.lastSeason);

  let hasOverlap = false;
  for (let index = 1; index < splitRows.length; index += 1) {
    const previous = splitRows[index - 1];
    const current = splitRows[index];
    if (seasonRangeOverlaps(previous.firstSeason, previous.lastSeason, current.firstSeason, current.lastSeason)) {
      hasOverlap = true;
      break;
    }
  }

  for (const split of splitRows) {
    outputRows.push({
      base_display_name: row.display_name,
      split_display_name: buildSplitDisplayName(row.display_name, split.firstSeason, split.lastSeason),
      first_season: split.firstSeason,
      last_season: split.lastSeason,
      afltables_player_url: split.afltablesPlayerUrl,
      afltables_tries: split.tries,
      afltables_points: split.points,
      apply_split: hasOverlap ? 0 : 1,
      split_status: hasOverlap ? "overlapping_season_ranges" : "ready",
    });
  }
}

const headers = [
  "base_display_name",
  "split_display_name",
  "first_season",
  "last_season",
  "afltables_player_url",
  "afltables_tries",
  "afltables_points",
  "apply_split",
  "split_status",
];

await fs.writeFile(
  LONG_CAREER_SPLITS_CSV,
  `${[
    headers.join(","),
    ...outputRows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n")}\n`,
  "utf8"
);

console.log(`Long-career split definitions written to ${LONG_CAREER_SPLITS_CSV}`);
console.log(`Rows: ${outputRows.length}`);
