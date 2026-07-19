import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./lib/csv.mjs";
import { LEGACY_PLAYER_SCORING_CSV } from "./lib/paths.mjs";

const PROJECT_ROOT = "C:\\Users\\d2rei\\Rugby-League-Stats-Database";
const bundlePath = path.join(PROJECT_ROOT, "seed", "core_import_bundle.json");

function normalizeText(value) {
  return String(value ?? "").trim();
}

function legacyMatchIdentity(matchKey, date) {
  return `${normalizeText(matchKey)}|${normalizeText(date)}`;
}

function historicalTryValue(season) {
  return Number(season) >= 1983 ? 4 : 3;
}

function historicalFg1Value(season) {
  return Number(season) <= 1970 ? 2 : 1;
}

function scorerPoints(row) {
  return ((Number(row.tries) || 0) * historicalTryValue(row.year))
    + ((Number(row.goals) || 0) * 2)
    + ((Number(row.fg1) || 0) * historicalFg1Value(row.year))
    + ((Number(row.fg2) || 0) * 2);
}

function parseMatchKeySides(matchKey, season, roundLabel) {
  const key = normalizeText(matchKey);
  const prefix = `${season}-${normalizeText(roundLabel)}-`;
  if (!key.startsWith(prefix)) return null;
  const remainder = key.slice(prefix.length);
  const separatorIndex = remainder.indexOf("-v-");
  if (separatorIndex === -1) return null;
  return {
    homeAlias: remainder.slice(0, separatorIndex),
    awayAlias: remainder.slice(separatorIndex + 3),
  };
}

function repeatedPairKey(match) {
  const [teamA, teamB] = [match.homeTeam, match.awayTeam].sort();
  return `${match.season}|${teamA}|${teamB}`;
}

function sideMatchesScore(scorerTotal, score) {
  if (scorerTotal === undefined && Number(score) === 0) return true;
  if (scorerTotal === undefined) return false;

  // Some AFLTables round-page scorer detail is incomplete for older matches
  // even when the match score is correct. For the repeated-finals audit, the
  // dangerous signal is a scorer total that exceeds the matched score, because
  // that usually means we attached the wrong table/date. A lower scorer total
  // is an incompleteness issue, not a repeated-final disambiguation failure.
  return scorerTotal <= Number(score);
}

const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
const scorerRows = parseCsv(await fs.readFile(LEGACY_PLAYER_SCORING_CSV, "utf8"));

const scorerTotalsByIdentity = new Map();
for (const row of scorerRows) {
  const identity = legacyMatchIdentity(row.match_key, row.date);
  const team = normalizeText(row.team);
  if (!identity || !team) continue;
  if (!scorerTotalsByIdentity.has(identity)) {
    scorerTotalsByIdentity.set(identity, new Map());
  }
  const teamTotals = scorerTotalsByIdentity.get(identity);
  teamTotals.set(team, (teamTotals.get(team) ?? 0) + scorerPoints(row));
}

const finalsPairs = new Map();
for (const match of bundle.matches) {
  if (match.competitionCode !== "NRL") continue;
  if (Number(match.season) >= 1998) continue;
  if (!match.isFinals) continue;
  const pairKey = repeatedPairKey(match);
  if (!finalsPairs.has(pairKey)) finalsPairs.set(pairKey, []);
  finalsPairs.get(pairKey).push(match);
}

const repeatedMatchIds = new Set(
  [...finalsPairs.values()]
    .filter((matches) => matches.length > 1)
    .flat()
    .map((match) => match.matchId)
);

const issues = [];
let checked = 0;

for (const match of bundle.matches) {
  if (!repeatedMatchIds.has(match.matchId)) continue;
  checked += 1;

  const source = match.sources?.afltables;
  const sides = parseMatchKeySides(source?.matchKey, match.season, source?.round || match.roundLabel);
  const scorerTotals = scorerTotalsByIdentity.get(legacyMatchIdentity(source?.matchKey, source?.date));
  const homeScorerTotal = sides ? scorerTotals?.get(sides.homeAlias) : undefined;
  const awayScorerTotal = sides ? scorerTotals?.get(sides.awayAlias) : undefined;

  if (!sides || !sideMatchesScore(homeScorerTotal, match.homeScore) || !sideMatchesScore(awayScorerTotal, match.awayScore)) {
    issues.push({
      match,
      homeScorerTotal,
      awayScorerTotal,
      matchKey: source?.matchKey,
      date: source?.date,
    });
  }
}

console.log(`Repeated pre-1998 finals matches checked: ${checked}`);
console.log(`Score mismatches: ${issues.length}`);

for (const issue of issues) {
  const { match } = issue;
  console.log(
    [
      `${match.matchId}`,
      match.season,
      match.roundLabel,
      match.matchDateLocalText ?? "",
      `${match.homeTeam} ${match.homeScore}-${match.awayScore} ${match.awayTeam}`,
      `scorer=${issue.homeScorerTotal ?? "missing"}-${issue.awayScorerTotal ?? "missing"}`,
      issue.matchKey,
      issue.date,
    ].join(" | ")
  );
}

if (issues.length > 0) {
  process.exitCode = 1;
}
