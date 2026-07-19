import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseCsv } from "./lib/csv.mjs";

const PROJECT_ROOT = "C:\\Users\\d2rei\\Rugby-League-Stats-Database";
const D1_DIR = path.join(PROJECT_ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const DOCS_DIR = path.join(PROJECT_ROOT, "docs");
const REVIEW_CSV_PATH = path.join(DOCS_DIR, "legacy_unresolved_scorers_review.csv");
const AFLTABLES_SCORER_REVIEW_CSV = path.join(DOCS_DIR, "players_afltables_scorers.csv");

async function findDatabaseFile() {
  const entries = await fs.readdir(D1_DIR);
  const sqliteFiles = entries.filter((entry) => entry.endsWith(".sqlite")).sort();
  if (sqliteFiles.length === 0) {
    throw new Error(`No local D1 sqlite file found in ${D1_DIR}`);
  }
  return path.join(D1_DIR, sqliteFiles[0]);
}

function deriveHistoricalPoints(row) {
  const year = Number(row.season);
  const tries = Number(row.tries) || 0;
  const goals = Number(row.goals) || 0;
  const fg1 = Number(row.fg1) || 0;
  const fg2 = Number(row.fg2) || 0;

  const tryValue = year >= 1983 ? 4 : 3;
  const legacyFieldGoalValue = year <= 1970 ? 2 : 1;

  return (tries * tryValue) + (goals * 2) + (fg1 * legacyFieldGoalValue) + (fg2 * 2);
}

function normalizePlayerLookupKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function joinScorerRows(rows) {
  return rows.map((row) => {
    const team = row.team_name ? ` [${row.team_name}]` : "";
    return `${row.player_name}${team} T:${Number(row.tries ?? 0)} G:${Number(row.goals ?? 0)} FG1:${Number(row.fg1 ?? 0)} FG2:${Number(row.fg2 ?? 0)} P:${Number(row.points ?? 0)}`;
  }).join(" | ");
}

const dbPath = await findDatabaseFile();
const db = new DatabaseSync(dbPath);
const scorerReferenceRows = parseCsv(await fs.readFile(AFLTABLES_SCORER_REVIEW_CSV, "utf8"));
const scorerReferenceTeams = new Map(
  scorerReferenceRows.map((row) => [normalizePlayerLookupKey(row.player_name), String(row.teams ?? "").trim()])
);

const unresolvedRows = db.prepare(`
  SELECT
    lps.legacy_player_scoring_id,
    lps.match_id,
    lps.season,
    lps.player_id,
    lps.player_name_raw,
    lps.tries,
    lps.goals,
    lps.fg1,
    lps.fg2,
    m.round_label,
    m.match_date_utc,
    m.match_date_local_text,
    m.home_team_id,
    ht.canonical_name AS home_team,
    m.home_score,
    m.away_team_id,
    at.canonical_name AS away_team,
    m.away_score,
    ms.source_match_key AS legacy_match_key,
    lps.team_id AS raw_team_id,
    lps.player_name_raw AS unresolved_player_name
  FROM legacy_player_scoring lps
  JOIN matches m ON m.match_id = lps.match_id
  LEFT JOIN teams ht ON ht.team_id = m.home_team_id
  LEFT JOIN teams at ON at.team_id = m.away_team_id
  LEFT JOIN match_sources ms ON ms.match_id = m.match_id AND ms.source = 'afltables'
  WHERE lps.season < 1998
    AND NOT EXISTS (
      SELECT 1
      FROM player_match_summary pms
      WHERE pms.match_id = lps.match_id
        AND COALESCE(pms.player_id, -1) = COALESCE(lps.player_id, -1)
        AND LOWER(COALESCE(pms.player_name_raw, '')) = LOWER(COALESCE(lps.player_name_raw, ''))
        AND CAST(json_extract(pms.stats_json, '$.tries') AS REAL) = lps.tries
        AND CAST(json_extract(pms.stats_json, '$.field_goals_1pt') AS REAL) = lps.fg1
        AND CAST(json_extract(pms.stats_json, '$.field_goals_2pt') AS REAL) = lps.fg2
    )
  ORDER BY lps.season, lps.match_id, lps.player_name_raw
`).all();

const sameSeasonHintStmt = db.prepare(`
  SELECT DISTINCT t.canonical_name AS team_name
  FROM player_match_summary pms
  LEFT JOIN teams t ON t.team_id = pms.team_id
  WHERE LOWER(COALESCE(pms.player_name_raw, '')) = LOWER(?)
    AND pms.season = ?
    AND pms.team_id IS NOT NULL
  ORDER BY t.canonical_name
`);

const careerHintStmt = db.prepare(`
  SELECT DISTINCT t.canonical_name AS team_name
  FROM player_match_summary pms
  LEFT JOIN teams t ON t.team_id = pms.team_id
  WHERE LOWER(COALESCE(pms.player_name_raw, '')) = LOWER(?)
    AND pms.team_id IS NOT NULL
  ORDER BY t.canonical_name
`);

const mappedScorersStmt = db.prepare(`
  SELECT
    COALESCE(p.display_name, pms.player_name_raw) AS player_name,
    t.canonical_name AS team_name,
    COALESCE(CAST(json_extract(pms.stats_json, '$.tries') AS REAL), 0) AS tries,
    0 AS goals,
    COALESCE(CAST(json_extract(pms.stats_json, '$.field_goals_1pt') AS REAL), 0) AS fg1,
    COALESCE(CAST(json_extract(pms.stats_json, '$.field_goals_2pt') AS REAL), 0) AS fg2,
    COALESCE(CAST(json_extract(pms.stats_json, '$.points') AS REAL), 0) AS points
  FROM player_match_summary pms
  LEFT JOIN players p ON p.player_id = pms.player_id
  LEFT JOIN teams t ON t.team_id = pms.team_id
  WHERE pms.match_id = ?
    AND (
      COALESCE(CAST(json_extract(pms.stats_json, '$.tries') AS REAL), 0) > 0
      OR COALESCE(CAST(json_extract(pms.stats_json, '$.field_goals_1pt') AS REAL), 0) > 0
      OR COALESCE(CAST(json_extract(pms.stats_json, '$.field_goals_2pt') AS REAL), 0) > 0
      OR COALESCE(CAST(json_extract(pms.stats_json, '$.points') AS REAL), 0) > 0
    )
  ORDER BY team_name, player_name
`);

const rawScorersStmt = db.prepare(`
  SELECT
    lps.player_name_raw AS player_name,
    COALESCE(t.canonical_name, lps.player_name_raw) AS _ignored_name,
    lps.tries,
    lps.goals,
    lps.fg1,
    lps.fg2,
    lps.points,
    COALESCE(t.canonical_name, CASE WHEN lps.team_id IS NULL THEN NULL ELSE 'Unknown' END) AS team_name,
    lps.legacy_player_scoring_id
  FROM legacy_player_scoring lps
  LEFT JOIN teams t ON t.team_id = lps.team_id
  WHERE lps.match_id = ?
  ORDER BY lps.player_name_raw
`);

const headers = [
  "season",
  "round_label",
  "match_date",
  "match_id",
  "legacy_match_key",
  "home_team",
  "home_score",
  "away_team",
  "away_score",
  "unresolved_player",
  "tries",
  "goals",
  "fg1",
  "fg2",
  "derived_points",
  "reference_teams",
  "same_season_resolved_teams",
  "career_resolved_teams",
  "mapped_match_scorers",
  "raw_match_scorers",
];

const lines = [headers.join(",")];

for (const row of unresolvedRows) {
  const sameSeasonTeams = sameSeasonHintStmt.all(row.player_name_raw, row.season).map((item) => item.team_name).filter(Boolean);
  const careerTeams = careerHintStmt.all(row.player_name_raw).map((item) => item.team_name).filter(Boolean);
  const mappedScorers = mappedScorersStmt.all(row.match_id);
  const rawScorers = rawScorersStmt.all(row.match_id).map((item) => ({
    ...item,
    team_name: item.team_name,
  }));

  const values = [
    row.season,
    row.round_label,
    row.match_date_local_text ?? row.match_date_utc ?? "",
    row.match_id,
    row.legacy_match_key ?? "",
    row.home_team ?? "",
    row.home_score ?? "",
    row.away_team ?? "",
    row.away_score ?? "",
    row.unresolved_player_name,
    row.tries,
    row.goals,
    row.fg1,
    row.fg2,
    deriveHistoricalPoints({
      season: row.season,
      tries: row.tries,
      goals: row.goals,
      fg1: row.fg1,
      fg2: row.fg2,
    }),
    scorerReferenceTeams.get(normalizePlayerLookupKey(row.unresolved_player_name)) ?? "",
    sameSeasonTeams.join(" | "),
    careerTeams.join(" | "),
    joinScorerRows(mappedScorers),
    joinScorerRows(rawScorers),
  ];

  lines.push(values.map(csvEscape).join(","));
}

await fs.writeFile(REVIEW_CSV_PATH, `${lines.join("\n")}\n`, "utf8");

console.log("Legacy unresolved scorer review CSV:", REVIEW_CSV_PATH);
console.log("Rows:", unresolvedRows.length);
