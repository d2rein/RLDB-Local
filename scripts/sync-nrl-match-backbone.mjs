import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./lib/csv.mjs";
import { NRL_DATA_ROOT, RECONCILED_MATCHES_CSV } from "./lib/paths.mjs";

const CSV_HEADER = [
  "match_id",
  "season",
  "match_key",
  "round",
  "round_index",
  "date",
  "home_team",
  "away_team",
  "home_score",
  "away_score",
  "venue",
  "round_afltables",
  "round_nrl",
  "round_index_afltables",
  "round_index_nrl",
  "date_afltables",
  "date_nrl",
  "home_team_afltables",
  "away_team_afltables",
  "home_team_nrl",
  "away_team_nrl",
  "home_tries_afltables",
  "home_goals_afltables",
  "home_fg_afltables",
  "away_tries_afltables",
  "away_goals_afltables",
  "away_fg_afltables",
  "home_score_afltables",
  "away_score_afltables",
  "home_score_nrl",
  "away_score_nrl",
  "venue_afltables",
  "venue_nrl",
  "crowd_afltables",
  "url_afltables",
  "url_nrl",
  "source_afltables",
  "source_nrl",
  "notes",
];

const TEAM_NAME_MAP = new Map([
  ["broncos", "Brisbane Broncos"],
  ["bulldogs", "Canterbury-Bankstown Bulldogs"],
  ["raiders", "Canberra Raiders"],
  ["sharks", "Cronulla-Sutherland Sharks"],
  ["dolphins", "Dolphins"],
  ["titans", "Gold Coast Titans"],
  ["sea eagles", "Manly-Warringah Sea Eagles"],
  ["storm", "Melbourne Storm"],
  ["warriors", "New Zealand Warriors"],
  ["knights", "Newcastle Knights"],
  ["cowboys", "North Queensland Cowboys"],
  ["eels", "Parramatta Eels"],
  ["panthers", "Penrith Panthers"],
  ["rabbitohs", "South Sydney Rabbitohs"],
  ["dragons", "St George Illawarra Dragons"],
  ["roosters", "Sydney Roosters"],
  ["wests tigers", "Wests Tigers"],
]);

const MATCH_KEY_ALIAS_MAP = new Map([
  ["Brisbane Broncos", "Brisbane"],
  ["Canterbury-Bankstown Bulldogs", "Canterbury"],
  ["Canberra Raiders", "Canberra"],
  ["Cronulla-Sutherland Sharks", "Cronulla"],
  ["Dolphins", "Dolphins"],
  ["Gold Coast Titans", "Gold Coast Titans"],
  ["Manly-Warringah Sea Eagles", "Manly"],
  ["Melbourne Storm", "Melbourne"],
  ["New Zealand Warriors", "New Zealand"],
  ["Newcastle Knights", "Newcastle"],
  ["North Queensland Cowboys", "North Queensland"],
  ["Parramatta Eels", "Parramatta"],
  ["Penrith Panthers", "Penrith"],
  ["South Sydney Rabbitohs", "Souths"],
  ["St George Illawarra Dragons", "St George Illawarra"],
  ["Sydney Roosters", "Sydney Roosters"],
  ["Wests Tigers", "Wests Tigers"],
]);

function normalizeLabel(value) {
  return String(value ?? "").trim().toLowerCase();
}

function canonicalTeamName(label) {
  return TEAM_NAME_MAP.get(normalizeLabel(label)) ?? String(label ?? "").trim();
}

function matchKeyTeamName(canonicalName) {
  return MATCH_KEY_ALIAS_MAP.get(canonicalName) ?? canonicalName;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes("\"") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function toCsv(rows) {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(CSV_HEADER.map((key) => csvEscape(row[key] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function mergeNotes(existingNotes, note) {
  const parts = new Set(
    String(existingNotes ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
  );
  if (note) parts.add(note);
  return [...parts].join("; ");
}

function buildBlankRow() {
  return Object.fromEntries(CSV_HEADER.map((key) => [key, ""]));
}

function roundIndexFromLabel(roundLabel) {
  const match = String(roundLabel ?? "").match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function scoreOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasRealScore(homeScore, awayScore) {
  if (homeScore === null || awayScore === null) {
    return false;
  }
  return !(homeScore === 0 && awayScore === 0);
}

function formatScore(value) {
  return value === null ? "" : String(value);
}

function buildMatchKey(season, roundLabel, homeTeam, awayTeam) {
  return `${season}-${roundLabel}-${matchKeyTeamName(homeTeam)}-v-${matchKeyTeamName(awayTeam)}`;
}

function buildLookupKey(season, roundLabel, url) {
  return `${season}|${roundLabel}|${String(url ?? "").trim()}`;
}

async function loadSeasonRows(season) {
  const filePath = path.join(NRL_DATA_ROOT, String(season), `NRL_data_${season}.json`);
  const json = JSON.parse(await fs.readFile(filePath, "utf8"));
  const seasonBlocks = json.NRL?.find((entry) => Object.prototype.hasOwnProperty.call(entry, String(season)));
  const rounds = seasonBlocks?.[String(season)] ?? [];
  const rows = [];

  for (const roundEntry of rounds) {
    for (const [roundIndexText, matches] of Object.entries(roundEntry)) {
      for (const match of matches) {
        rows.push({
          season: Number(season),
          roundLabel: String(match.Round ?? `Round ${roundIndexText}`),
          roundIndex: Number(roundIndexText),
          date: String(match.Date ?? "").trim(),
          homeTeam: canonicalTeamName(match.Home),
          awayTeam: canonicalTeamName(match.Away),
          homeScore: scoreOrNull(match.Home_Score),
          awayScore: scoreOrNull(match.Away_Score),
          venue: String(match.Venue ?? "").trim(),
          url: String(match.Match_Centre_URL ?? "").trim(),
        });
      }
    }
  }

  return rows;
}

const seasonArg = process.argv.find((arg) => arg.startsWith("--season="));
const targetSeason = seasonArg ? Number(seasonArg.split("=")[1]) : new Date().getUTCFullYear();

if (!Number.isFinite(targetSeason)) {
  throw new Error("Expected a numeric --season value.");
}

const existingRows = parseCsv(await fs.readFile(RECONCILED_MATCHES_CSV, "utf8"));
const seasonRows = await loadSeasonRows(targetSeason);

const lookup = new Map();
let maxMatchId = 0;

for (const row of existingRows) {
  const matchId = Number(row.match_id ?? 0);
  if (Number.isFinite(matchId)) {
    maxMatchId = Math.max(maxMatchId, matchId);
  }

  if (Number(row.season) === targetSeason && row.url_nrl) {
    lookup.set(buildLookupKey(row.season, row.round, row.url_nrl), row);
  }
}

let created = 0;
let updated = 0;

for (const match of seasonRows) {
  const lookupKey = buildLookupKey(match.season, match.roundLabel, match.url);
  const existing = lookup.get(lookupKey);
  const row = existing ?? buildBlankRow();

  if (!existing) {
    maxMatchId += 1;
    row.match_id = String(maxMatchId);
    row.source_afltables = "0";
    row.source_nrl = "1";
    created += 1;
    existingRows.push(row);
    lookup.set(lookupKey, row);
  } else {
    updated += 1;
  }

  const roundIndex = match.roundIndex ?? roundIndexFromLabel(match.roundLabel);

  row.season = String(match.season);
  row.match_key = buildMatchKey(match.season, match.roundLabel, match.homeTeam, match.awayTeam);
  row.round = match.roundLabel;
  row.round_index = String(roundIndex ?? "");
  row.date = match.date;
  row.home_team = match.homeTeam;
  row.away_team = match.awayTeam;
  const incomingHasRealScore = hasRealScore(match.homeScore, match.awayScore);
  const existingHomeScore = scoreOrNull(row.home_score);
  const existingAwayScore = scoreOrNull(row.away_score);
  const existingHasRealScore = hasRealScore(existingHomeScore, existingAwayScore);
  const homeScore = incomingHasRealScore ? match.homeScore : existingHasRealScore ? existingHomeScore : null;
  const awayScore = incomingHasRealScore ? match.awayScore : existingHasRealScore ? existingAwayScore : null;

  row.home_score = formatScore(homeScore);
  row.away_score = formatScore(awayScore);
  row.venue = match.venue;

  row.round_nrl = String(roundIndex ?? "");
  row.round_index_nrl = String(roundIndex ?? "");
  row.date_nrl = match.date;
  row.home_team_nrl = match.homeTeam;
  row.away_team_nrl = match.awayTeam;
  row.home_score_nrl = formatScore(homeScore);
  row.away_score_nrl = formatScore(awayScore);
  row.venue_nrl = match.venue;
  row.url_nrl = match.url;
  row.source_nrl = "1";

  row.notes = mergeNotes(row.notes, existing ? "" : "nrl_backbone_auto_added");
}

existingRows.sort((left, right) => Number(left.match_id) - Number(right.match_id));

await fs.writeFile(RECONCILED_MATCHES_CSV, toCsv(existingRows), "utf8");

console.log("Reconciled match backbone:", RECONCILED_MATCHES_CSV);
console.log("Season synced:", targetSeason);
console.log("Season rows seen:", seasonRows.length);
console.log("Rows created:", created);
console.log("Rows updated:", updated);
