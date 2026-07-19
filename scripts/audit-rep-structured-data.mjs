import fs from "node:fs/promises";
import path from "node:path";
import { flattenDetailedMatchFile, flattenPlayerStatsFile } from "./lib/nrl-json.mjs";
import { DOCS_DIR } from "./lib/project-paths.mjs";

const REP_DIR = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data", "REP");
const OUTPUT_ROOT = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data");
const PAYLOAD_PATH = path.join(REP_DIR, "rep_match_payloads.json");

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function roundNumberFromFixture(fixture) {
  return Number(fixture?.gameNumber ?? 0);
}

function playerMatchKey(fixture) {
  const home = normalizeText(fixture.homeTeam).replace(/\s+/g, "-");
  const away = normalizeText(fixture.awayTeam).replace(/\s+/g, "-");
  return `${fixture.season}-${fixture.gameNumber}-${home}-v-${away}`;
}

function detailMatchKey(fixture) {
  return `${normalizeName(fixture.homeTeam)} v ${normalizeName(fixture.awayTeam)}`;
}

function numericValue(value) {
  if (value === null || value === undefined || value === "" || value === "na" || value === -1) return null;
  const text = String(value).trim();
  if (/^\d+\/\d+$/.test(text)) return Number(text.split("/")[0]);
  const compact = text.replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(compact)) return Number(compact);
  return null;
}

function scoringValue(scoring, key) {
  const raw = scoring?.[key];
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "object") {
    return Number(raw.made ?? raw.value ?? 0) || 0;
  }
  return Number(raw) || 0;
}

function extractStructuredMatches(json, competitionCode, season) {
  const rows = [];
  const blocks = json?.[competitionCode]?.[0]?.[String(season)] ?? [];
  for (const roundEntry of blocks) {
    for (const [roundKey, matches] of Object.entries(roundEntry)) {
      for (const match of matches ?? []) {
        rows.push({
          roundNumber: Number(roundKey),
          roundLabel: normalizeText(match.Round),
          home: normalizeName(match.Home),
          away: normalizeName(match.Away),
          homeScore: Number(match.Home_Score ?? 0),
          awayScore: Number(match.Away_Score ?? 0),
          url: normalizeText(match.Match_Centre_URL),
        });
      }
    }
  }
  return rows;
}

function extractStructuredPlayers(json) {
  const map = new Map();
  for (const yearBlock of json?.PlayerStats ?? []) {
    for (const [season, rounds] of Object.entries(yearBlock)) {
      for (const roundEntry of rounds ?? []) {
        for (const [roundKey, matchEntries] of Object.entries(roundEntry)) {
          for (const matchEntry of matchEntries ?? []) {
            for (const [sourceMatchKey, playerRows] of Object.entries(matchEntry)) {
              map.set(`${season}|${roundKey}|${sourceMatchKey}`, playerRows ?? []);
            }
          }
        }
      }
    }
  }
  return map;
}

function extractStructuredDetailKeys(json, competitionCode) {
  const map = new Map();
  for (const roundEntry of json?.[competitionCode] ?? []) {
    for (const [roundKey, matches] of Object.entries(roundEntry)) {
      for (const wrapper of matches ?? []) {
        for (const [matchLabel, payload] of Object.entries(wrapper)) {
          map.set(`${roundKey}|${matchLabel}`, payload);
        }
      }
    }
  }
  return map;
}

const raw = JSON.parse(await fs.readFile(PAYLOAD_PATH, "utf8"));
const payloads = raw.payloads ?? [];

const failures = [];
const summary = [];

for (const competitionCode of [...new Set(payloads.map((row) => row.fixture?.competitionCode).filter(Boolean))].sort()) {
  const competitionRows = payloads.filter((row) => row.fixture?.competitionCode === competitionCode);
  const seasons = [...new Set(competitionRows.map((row) => row.fixture?.season))].sort((a, b) => a - b);

  let fixtureCount = 0;
  let matchFileCount = 0;
  let richMatchCount = 0;
  let playerFixtureCount = 0;
  let playerChecksumCount = 0;
  let flattenDetailRows = 0;
  let flattenPlayerRows = 0;

  for (const season of seasons) {
    const seasonRows = competitionRows.filter((row) => row.fixture?.season === season);
    fixtureCount += seasonRows.length;

    const seasonDir = path.join(OUTPUT_ROOT, competitionCode, String(season));
    const matchFilePath = path.join(seasonDir, `${competitionCode}_data_${season}.json`);
    const detailFilePath = path.join(seasonDir, `${competitionCode}_detailed_match_data_${season}.json`);
    const playerFilePath = path.join(seasonDir, `${competitionCode}_player_statistics_${season}.json`);

    const [matchJson, detailJson, playerJson] = await Promise.all([
      fs.readFile(matchFilePath, "utf8").then(JSON.parse),
      fs.readFile(detailFilePath, "utf8").then(JSON.parse),
      fs.readFile(playerFilePath, "utf8").then(JSON.parse),
    ]);

    matchFileCount += extractStructuredMatches(matchJson, competitionCode, season).length;
    flattenDetailRows += (await flattenDetailedMatchFile(detailFilePath)).length;
    flattenPlayerRows += (await flattenPlayerStatsFile(playerFilePath)).length;

    const structuredMatches = extractStructuredMatches(matchJson, competitionCode, season);
    const structuredMatchByUrl = new Map(structuredMatches.map((row) => [row.url, row]));
    const structuredPlayers = extractStructuredPlayers(playerJson);
    const structuredDetails = extractStructuredDetailKeys(detailJson, competitionCode);

    for (const row of seasonRows) {
      const fixture = row.fixture;
      const match = row.payload?.match ?? {};
      const rawStats = match.stats ?? {};
      const richDetail = (rawStats.groups?.length ?? 0) > 0;
      const richPlayers = ((rawStats.players?.homeTeam?.length ?? 0) + (rawStats.players?.awayTeam?.length ?? 0)) > 0;

      const structuredMatch = structuredMatchByUrl.get(normalizeText(fixture.url));
      if (!structuredMatch) {
        failures.push(`Missing match row for ${competitionCode} ${season} ${fixture.url}`);
        continue;
      }
      const rawHomeScore = Number(match.homeTeam?.score ?? 0);
      const rawAwayScore = Number(match.awayTeam?.score ?? 0);
      if (
        structuredMatch.roundNumber !== roundNumberFromFixture(fixture)
        || structuredMatch.home !== normalizeName(fixture.homeTeam)
        || structuredMatch.away !== normalizeName(fixture.awayTeam)
        || structuredMatch.homeScore !== rawHomeScore
        || structuredMatch.awayScore !== rawAwayScore
      ) {
        failures.push(`Mismatch in match row for ${competitionCode} ${season} ${fixture.url}`);
      }

      if (richDetail) {
        richMatchCount += 1;
        const detailKey = `${fixture.gameNumber}|${detailMatchKey(fixture)}`;
        if (!structuredDetails.has(detailKey)) {
          failures.push(`Missing detailed entry for ${competitionCode} ${season} ${fixture.url}`);
        }
      }

      if (richPlayers) {
        playerFixtureCount += 1;
        const playerKey = `${season}|${fixture.gameNumber}|${playerMatchKey(fixture)}`;
        const playerRows = structuredPlayers.get(playerKey);
        if (!playerRows) {
          failures.push(`Missing player rows for ${competitionCode} ${season} ${fixture.url}`);
          continue;
        }

        const sums = {
          tries: 0,
          goals: 0,
          fg1: 0,
          fg2: 0,
          points: 0,
        };
        for (const playerRow of playerRows) {
          sums.tries += numericValue(playerRow["Tries"]) ?? 0;
          sums.goals += numericValue(playerRow["Conversions"]) ?? 0;
          sums.fg1 += numericValue(playerRow["1 Point Field Goals"]) ?? 0;
          sums.fg2 += numericValue(playerRow["2 Point Field Goals"]) ?? 0;
          sums.points += numericValue(playerRow["Points"]) ?? 0;
        }

        const expected = {
          tries: scoringValue(match.homeTeam?.scoring, "tries") + scoringValue(match.awayTeam?.scoring, "tries"),
          goals: scoringValue(match.homeTeam?.scoring, "conversions") + scoringValue(match.awayTeam?.scoring, "conversions"),
          fg1: scoringValue(match.homeTeam?.scoring, "onePointFieldGoals") + scoringValue(match.awayTeam?.scoring, "onePointFieldGoals"),
          fg2: scoringValue(match.homeTeam?.scoring, "twoPointFieldGoals") + scoringValue(match.awayTeam?.scoring, "twoPointFieldGoals"),
          points: rawHomeScore + rawAwayScore,
        };

        if (
          sums.tries !== expected.tries
          || sums.goals !== expected.goals
          || sums.fg1 !== expected.fg1
          || sums.fg2 !== expected.fg2
          || sums.points !== expected.points
        ) {
          failures.push(
            `Player checksum mismatch for ${competitionCode} ${season} ${fixture.url} `
            + `(structured=${JSON.stringify(sums)} expected=${JSON.stringify(expected)})`
          );
        } else {
          playerChecksumCount += 1;
        }
      }
    }
  }

  summary.push({
    competitionCode,
    seasons: seasons.length,
    fixtureCount,
    matchFileCount,
    richMatchCount,
    playerFixtureCount,
    playerChecksumCount,
    flattenDetailRows,
    flattenPlayerRows,
  });
}

console.log(JSON.stringify({ ok: failures.length === 0, summary, failures }, null, 2));
if (failures.length > 0) {
  process.exitCode = 1;
}
