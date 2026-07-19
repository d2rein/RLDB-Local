import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./lib/csv.mjs";
import { DOCS_DIR, SEED_DIR } from "./lib/project-paths.mjs";
import { LEGACY_PLAYER_SCORING_CSV, STRUCTURED_COMPETITION_DATASETS } from "./lib/paths.mjs";
import { loadReconciledMatches } from "./lib/reconciled-matches.mjs";
import { loadLegacyMatchSupplementRows, loadLegacyScoringRows } from "./lib/legacy-supplements.mjs";
import { loadLegacyPlayerSplitDefinitions, seasonRangeOverlaps } from "./lib/player-splits.mjs";

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function finalsFlag(roundLabel) {
  return /final/i.test(String(roundLabel ?? ""));
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function isIsoTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T/.test(normalizeText(value));
}

function appendNote(existingNotes, note) {
  const parts = new Set(
    String(existingNotes ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
  );
  if (note) parts.add(note);
  return [...parts].join("; ");
}

function legacyMatchIdentity(matchKey, date) {
  const key = normalizeText(matchKey);
  const matchDate = normalizeText(date);
  return matchDate ? `${key}|${matchDate}` : key;
}

function addLegacyTotal(targetMap, key, row) {
  const team = normalizeText(row.team);
  if (!key || !team) return;
  if (!targetMap.has(key)) {
    targetMap.set(key, new Map());
  }
  const matchTeams = targetMap.get(key);
  if (!matchTeams.has(team)) {
    matchTeams.set(team, {
      tries: 0,
      goals: 0,
      fg1: 0,
      fg2: 0,
      points: 0,
    });
  }
  const totals = matchTeams.get(team);
  totals.tries += Number(row.tries) || 0;
  totals.goals += Number(row.goals) || 0;
  totals.fg1 += Number(row.fg1) || 0;
  totals.fg2 += Number(row.fg2) || 0;
  totals.points += deriveHistoricalPoints({
    season: row.year,
    tries: row.tries,
    goals: row.goals,
    fg1: row.fg1,
    fg2: row.fg2,
  });
}

function historicalTryValue(season) {
  return Number(season) >= 1983 ? 4 : 3;
}

function historicalFg1Value(season) {
  return Number(season) <= 1970 ? 2 : 1;
}

function deriveHistoricalPoints({ season, tries, goals, fg1, fg2 }) {
  return ((Number(tries) || 0) * historicalTryValue(season))
    + ((Number(goals) || 0) * 2)
    + ((Number(fg1) || 0) * historicalFg1Value(season))
    + ((Number(fg2) || 0) * 2);
}

function repairScoreFromLegacyScoring(originalScore, legacyTotals) {
  const legacyScore = legacyTotals?.points ?? null;
  if (legacyScore === null || legacyScore === undefined) {
    return originalScore;
  }
  if (originalScore === null || originalScore === undefined) {
    return legacyScore;
  }

  // Legacy scorer rows occasionally omit goal-kickers even when the match score
  // is correct. Use scorer totals to fill/lift scores, but never to downgrade a
  // known AFLTables score from incomplete player detail.
  return legacyScore > originalScore ? legacyScore : originalScore;
}

const NRLW_TEAM_CANONICAL_NAMES = new Map([
  ["Broncos", "Brisbane Broncos"],
  ["Roosters", "Sydney Roosters"],
  ["Wests Tigers", "Wests Tigers"],
  ["Eels", "Parramatta Eels"],
  ["Raiders", "Canberra Raiders"],
  ["Knights", "Newcastle Knights"],
  ["Dragons", "St George Illawarra Dragons"],
  ["Sharks", "Cronulla-Sutherland Sharks"],
  ["Titans", "Gold Coast Titans"],
  ["Cowboys", "North Queensland Cowboys"],
  ["Warriors", "New Zealand Warriors"],
  ["Bulldogs", "Canterbury-Bankstown Bulldogs"],
]);

function canonicalNrlwTeamName(rawName) {
  const normalized = normalizeText(rawName);
  return NRLW_TEAM_CANONICAL_NAMES.get(normalized) ?? normalized;
}

function canonicalStructuredTeamName(competitionCode, rawName) {
  const normalized = normalizeText(rawName);
  if (competitionCode === "NRLW") {
    return canonicalNrlwTeamName(rawName);
  }
  if (competitionCode === "WSOO") {
    if (normalized === "Sky Blues") return "Blues Women";
    return normalized;
  }
  return normalized;
}

function nrlwSourceMatchKey(season, roundIndex, homeTeam, awayTeam) {
  return [
    season,
    roundIndex,
    normalizeText(homeTeam).replace(/\s+/g, "-"),
    "v",
    normalizeText(awayTeam).replace(/\s+/g, "-"),
  ].join("-");
}

async function listYearDirectories(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a) - Number(b));
  } catch {
    return [];
  }
}

function parseMatchKeySides(matchKey, season, roundLabel) {
  const key = normalizeText(matchKey);
  const round = normalizeText(roundLabel);
  const prefix = `${season}-${round}-`;
  if (!key.startsWith(prefix)) {
    return null;
  }
  const remainder = key.slice(prefix.length);
  const separatorIndex = remainder.indexOf("-v-");
  if (separatorIndex === -1) {
    return null;
  }
  return {
    homeAlias: remainder.slice(0, separatorIndex),
    awayAlias: remainder.slice(separatorIndex + 3),
  };
}

await fs.mkdir(SEED_DIR, { recursive: true });

const matches = await loadReconciledMatches();
const reconciliations = parseCsv(
  await fs.readFile(path.join(DOCS_DIR, "players_reconciliation_candidates.csv"), "utf8")
);
const nrlPlayers = parseCsv(await fs.readFile(path.join(DOCS_DIR, "players_nrl_player_stats.csv"), "utf8"));
const aflPlayers = parseCsv(await fs.readFile(path.join(DOCS_DIR, "players_afltables_scorers.csv"), "utf8"));
const legacyScoringRows = await loadLegacyScoringRows();
const legacyMatchSupplementRows = await loadLegacyMatchSupplementRows();

const legacyTotalsByMatchIdentity = new Map();
const legacyTotalsByMatchKey = new Map();
for (const row of legacyScoringRows) {
  const matchKey = normalizeText(row.match_key);
  if (!matchKey) continue;
  addLegacyTotal(legacyTotalsByMatchIdentity, legacyMatchIdentity(matchKey, row.date), row);
  addLegacyTotal(legacyTotalsByMatchKey, matchKey, row);
}

const legacyMatchSupplementByNrlUrl = new Map();
for (const row of legacyMatchSupplementRows) {
  const url = normalizeText(row.url_nrl);
  if (url) {
    legacyMatchSupplementByNrlUrl.set(url, row);
  }
}

const teams = new Map();
const venues = new Map();

for (const match of matches) {
  for (const teamName of [match.home_team, match.away_team]) {
    if (!teamName) continue;
    if (!teams.has(teamName)) {
      teams.set(teamName, {
        canonicalName: teamName,
        competitionCode: "NRL",
        firstSeason: numberOrNull(match.season),
        lastSeason: numberOrNull(match.season),
      });
    } else {
      const team = teams.get(teamName);
      const season = numberOrNull(match.season);
      if (season !== null) {
        team.firstSeason = team.firstSeason === null ? season : Math.min(team.firstSeason, season);
        team.lastSeason = team.lastSeason === null ? season : Math.max(team.lastSeason, season);
      }
    }
  }

  const venueName = normalizeText(match.venue);
  if (venueName) {
    if (!venues.has(venueName)) {
      venues.set(venueName, {
        canonicalName: venueName,
        afltablesName: normalizeText(match.venue_afltables),
        nrlName: normalizeText(match.venue_nrl),
      });
    }
  }
}

const players = new Map();
const playerAliases = [];
const legacyPlayerSplits = await loadLegacyPlayerSplitDefinitions();

const nrlByName = new Map(nrlPlayers.map((row) => [row.player_name, row]));
const aflByName = new Map(aflPlayers.map((row) => [row.player_name, row]));

for (const row of reconciliations) {
  const status = row.suggested_status;
  const canonicalName =
    row.suggested_canonical_name ||
    row.nrl_player_name ||
    row.afl_player_name;
  if (!canonicalName) continue;

  if (!players.has(canonicalName)) {
    const sourceRow = nrlByName.get(canonicalName) ?? aflByName.get(canonicalName) ?? null;
    players.set(canonicalName, {
      displayName: canonicalName,
      firstSeason:
        numberOrNull(row.nrl_first_season) ??
        numberOrNull(row.afl_first_season) ??
        numberOrNull(sourceRow?.first_season),
      lastSeason:
        numberOrNull(row.nrl_last_season) ??
        numberOrNull(row.afl_last_season) ??
        numberOrNull(sourceRow?.last_season),
      isUnresolved: status === "nrl_only" || status === "afltables_only" ? 1 : 0,
      reconciliationStatus: status,
    });
  }

  if (row.nrl_player_name) {
    playerAliases.push({
      canonicalName,
      source: "nrl",
      sourceName: row.nrl_player_name,
      firstSeason: numberOrNull(row.nrl_first_season),
      lastSeason: numberOrNull(row.nrl_last_season),
      confidence:
        status === "matched_normalized" || status === "matched_manual_override"
          ? 1
          : 0.5,
    });
  }

  if (row.afl_player_name) {
    playerAliases.push({
      canonicalName,
      source: "afltables",
      sourceName: row.afl_player_name,
      firstSeason: numberOrNull(row.afl_first_season),
      lastSeason: numberOrNull(row.afl_last_season),
      confidence:
        status === "matched_normalized" || status === "matched_manual_override"
          ? 1
          : 0.5,
    });
  }
}

const structuredDatasetYears = new Map();
const structuredPlayersByDataset = new Map();

for (const dataset of STRUCTURED_COMPETITION_DATASETS) {
  const yearDirectories = await listYearDirectories(dataset.root);
  structuredDatasetYears.set(dataset.competitionCode, yearDirectories);
  const playersByName = new Map();

  for (const year of yearDirectories) {
    const season = Number(year);
    const playerFilePath = path.join(dataset.root, year, `${dataset.sourceKey}_player_statistics_${year}.json`);
    try {
      const playerJson = JSON.parse(await fs.readFile(playerFilePath, "utf8"));
      for (const yearBlock of playerJson.PlayerStats ?? []) {
        for (const rounds of Object.values(yearBlock)) {
          for (const roundEntry of rounds ?? []) {
            for (const matchEntries of Object.values(roundEntry)) {
              for (const matchEntry of matchEntries ?? []) {
                for (const playerRows of Object.values(matchEntry)) {
                  for (const playerRow of playerRows ?? []) {
                    const displayName = normalizeText(playerRow.Name);
                    if (!displayName) continue;
                    const existing = playersByName.get(displayName) ?? {
                      displayName,
                      firstSeason: season,
                      lastSeason: season,
                    };
                    existing.firstSeason = Math.min(existing.firstSeason, season);
                    existing.lastSeason = Math.max(existing.lastSeason, season);
                    playersByName.set(displayName, existing);
                  }
                }
              }
            }
          }
        }
      }
    } catch {}
  }

  structuredPlayersByDataset.set(dataset.competitionCode, playersByName);
}

for (const dataset of STRUCTURED_COMPETITION_DATASETS) {
  const playersByName = structuredPlayersByDataset.get(dataset.competitionCode) ?? new Map();
  for (const player of playersByName.values()) {
    const existing = players.get(player.displayName);
    if (existing) {
      existing.firstSeason = existing.firstSeason === null ? player.firstSeason : Math.min(existing.firstSeason, player.firstSeason);
      existing.lastSeason = existing.lastSeason === null ? player.lastSeason : Math.max(existing.lastSeason, player.lastSeason);
    } else {
      players.set(player.displayName, {
        displayName: player.displayName,
        firstSeason: player.firstSeason,
        lastSeason: player.lastSeason,
        isUnresolved: 0,
        reconciliationStatus: `${dataset.sourceKey.toLowerCase()}_only`,
      });
    }

    playerAliases.push({
      canonicalName: player.displayName,
      source: dataset.sourceKey.toLowerCase(),
      sourceName: player.displayName,
      firstSeason: player.firstSeason,
      lastSeason: player.lastSeason,
      confidence: 1,
    });
  }
}

function applyLegacyPlayerSplits(playersMap, aliases, splitDefinitions) {
  const redistributedAliases = [];
  const aliasesByCanonical = new Map();

  for (const alias of aliases) {
    if (!aliasesByCanonical.has(alias.canonicalName)) {
      aliasesByCanonical.set(alias.canonicalName, []);
    }
    aliasesByCanonical.get(alias.canonicalName).push(alias);
  }

  for (const [baseDisplayName, splits] of splitDefinitions) {
    const basePlayer = playersMap.get(baseDisplayName);
    const baseAliases = aliasesByCanonical.get(baseDisplayName) ?? [];
    if (!basePlayer && baseAliases.length === 0) continue;

    playersMap.delete(baseDisplayName);

    for (const split of splits) {
      const existing = playersMap.get(split.splitDisplayName);
      if (existing) {
        existing.firstSeason = Math.min(existing.firstSeason ?? split.firstSeason, split.firstSeason);
        existing.lastSeason = Math.max(existing.lastSeason ?? split.lastSeason, split.lastSeason);
        existing.afltablesPlayerUrl = split.afltablesPlayerUrl || existing.afltablesPlayerUrl || null;
        existing.isUnresolved = 0;
        continue;
      }

      playersMap.set(split.splitDisplayName, {
        displayName: split.splitDisplayName,
        firstSeason: split.firstSeason,
        lastSeason: split.lastSeason,
        afltablesPlayerUrl: split.afltablesPlayerUrl || null,
        isUnresolved: 0,
        reconciliationStatus: "afltables_split",
      });
    }

    for (const alias of baseAliases) {
      const aliasFirst = Number(alias.firstSeason);
      const aliasLast = Number(alias.lastSeason);
      for (const split of splits) {
        if (
          Number.isFinite(aliasFirst) &&
          Number.isFinite(aliasLast) &&
          !seasonRangeOverlaps(aliasFirst, aliasLast, split.firstSeason, split.lastSeason)
        ) {
          continue;
        }

        redistributedAliases.push({
          canonicalName: split.splitDisplayName,
          source: alias.source,
          sourceName: alias.sourceName,
          firstSeason: Number.isFinite(aliasFirst) ? Math.max(aliasFirst, split.firstSeason) : split.firstSeason,
          lastSeason: Number.isFinite(aliasLast) ? Math.min(aliasLast, split.lastSeason) : split.lastSeason,
          confidence: alias.confidence,
          allowedTeams: Array.isArray(split.allowedTeams) ? [...split.allowedTeams] : [],
        });
      }
    }
  }

  const unsplitAliases = aliases.filter((alias) => !splitDefinitions.has(alias.canonicalName));
  aliases.length = 0;
  aliases.push(...unsplitAliases, ...redistributedAliases);
}

applyLegacyPlayerSplits(players, playerAliases, legacyPlayerSplits);

let repairedAflScoreCount = 0;

const matchRows = matches.map((match) => {
  const season = numberOrNull(match.season);
  const afltablesPresent = match.source_afltables === "1";
  const nrlPresent = match.source_nrl === "1";
  const afltablesRound = normalizeText(match.round_afltables || match.round);
  const parsedSides = afltablesPresent ? parseMatchKeySides(match.match_key, season, afltablesRound) : null;
  const legacyMatchTotals = afltablesPresent
    ? (
        legacyTotalsByMatchIdentity.get(legacyMatchIdentity(match.match_key, match.date_afltables || match.date))
        ?? legacyTotalsByMatchKey.get(normalizeText(match.match_key))
      )
    : null;
  const homeLegacyTotals = parsedSides ? legacyMatchTotals?.get(parsedSides.homeAlias) ?? null : null;
  const awayLegacyTotals = parsedSides ? legacyMatchTotals?.get(parsedSides.awayAlias) ?? null : null;
  const canRepairAflScore = afltablesPresent && (homeLegacyTotals || awayLegacyTotals);

  const originalAflHomeScore = numberOrNull(match.home_score_afltables);
  const originalAflAwayScore = numberOrNull(match.away_score_afltables);
  const correctedAflHomeScore = canRepairAflScore
    ? repairScoreFromLegacyScoring(originalAflHomeScore, homeLegacyTotals)
    : originalAflHomeScore;
  const correctedAflAwayScore = canRepairAflScore
    ? repairScoreFromLegacyScoring(originalAflAwayScore, awayLegacyTotals)
    : originalAflAwayScore;
  const aflScoreWasRepaired =
    canRepairAflScore &&
    (correctedAflHomeScore !== originalAflHomeScore || correctedAflAwayScore !== originalAflAwayScore);

  if (aflScoreWasRepaired) {
    repairedAflScoreCount += 1;
  }

  const canonicalHomeScore = nrlPresent
    ? (numberOrNull(match.home_score_nrl) ?? correctedAflHomeScore ?? numberOrNull(match.home_score))
    : (correctedAflHomeScore ?? numberOrNull(match.home_score));
  const canonicalAwayScore = nrlPresent
    ? (numberOrNull(match.away_score_nrl) ?? correctedAflAwayScore ?? numberOrNull(match.away_score))
    : (correctedAflAwayScore ?? numberOrNull(match.away_score));

  let notes = normalizeText(match.notes);
  if (aflScoreWasRepaired) {
    notes = appendNote(
      notes,
      `afltables_score_rebuilt_from_player_scoring:${correctedAflHomeScore}-${correctedAflAwayScore}`
    );
  }

  return {
    matchId: numberOrNull(match.match_id),
    competitionCode: "NRL",
    season,
    roundLabel: match.round,
    roundIndex: numberOrNull(match.round_index),
    matchDateUtc: isIsoTimestamp(match.date) ? normalizeText(match.date) : null,
    matchDateLocalText: isIsoTimestamp(match.date) ? null : normalizeText(match.date),
    isFinals: finalsFlag(match.round) ? 1 : 0,
    homeTeam: match.home_team,
    awayTeam: match.away_team,
    homeScore: canonicalHomeScore,
    awayScore: canonicalAwayScore,
    venue: match.venue,
    notes,
    sources: {
      afltables: {
        present: afltablesPresent,
        matchKey: match.match_key,
        round: match.round_afltables,
        roundIndex: numberOrNull(match.round_index_afltables),
        date: match.date_afltables,
        homeTeam: match.home_team_afltables,
        awayTeam: match.away_team_afltables,
        homeScore: correctedAflHomeScore,
        awayScore: correctedAflAwayScore,
        venue: match.venue_afltables,
        url: match.url_afltables,
      },
      nrl: {
        present: nrlPresent,
        round: match.round_nrl,
        roundIndex: numberOrNull(match.round_index_nrl),
        date: match.date_nrl,
        homeTeam: match.home_team_nrl,
        awayTeam: match.away_team_nrl,
        homeScore: numberOrNull(match.home_score_nrl),
        awayScore: numberOrNull(match.away_score_nrl),
        venue: match.venue_nrl,
        url: match.url_nrl,
      },
    },
  };
});

let nextMatchId = Math.max(0, ...matchRows.map((match) => Number(match.matchId) || 0)) + 1;

for (const dataset of STRUCTURED_COMPETITION_DATASETS) {
  const yearDirectories = structuredDatasetYears.get(dataset.competitionCode) ?? [];
  for (const year of yearDirectories) {
    const season = Number(year);
    const matchFilePath = path.join(dataset.root, year, `${dataset.sourceKey}_data_${year}.json`);
    try {
      const matchJson = JSON.parse(await fs.readFile(matchFilePath, "utf8"));
      const roundBlocks = matchJson[dataset.sourceKey]?.[0]?.[year] ?? [];

      for (const roundEntry of roundBlocks) {
        for (const [roundIndexText, games] of Object.entries(roundEntry)) {
          const roundIndex = Number(roundIndexText);
          for (const game of games ?? []) {
            const homeTeam = canonicalStructuredTeamName(dataset.competitionCode, game.Home);
            const awayTeam = canonicalStructuredTeamName(dataset.competitionCode, game.Away);
            const venueName = normalizeText(game.Venue);
            const sourceMatchKey = nrlwSourceMatchKey(season, roundIndex, game.Home, game.Away);

            for (const teamName of [homeTeam, awayTeam]) {
              if (!teamName) continue;
              if (!teams.has(teamName)) {
                teams.set(teamName, {
                  canonicalName: teamName,
                  competitionCode: dataset.competitionCode,
                  firstSeason: season,
                  lastSeason: season,
                });
              } else {
                const team = teams.get(teamName);
                team.firstSeason = team.firstSeason === null ? season : Math.min(team.firstSeason, season);
                team.lastSeason = team.lastSeason === null ? season : Math.max(team.lastSeason, season);
              }
            }

            if (venueName && !venues.has(venueName)) {
              venues.set(venueName, {
                canonicalName: venueName,
                afltablesName: "",
                nrlName: venueName,
              });
            }

            matchRows.push({
              matchId: nextMatchId,
              competitionCode: dataset.competitionCode,
              season,
              roundLabel: normalizeText(game.Round) || `Round ${roundIndex}`,
              roundIndex,
              matchDateUtc: normalizeText(game.Date) || null,
              matchDateLocalText: null,
              isFinals: finalsFlag(game.Round) ? 1 : 0,
              homeTeam,
              awayTeam,
              homeScore: numberOrNull(game.Home_Score),
              awayScore: numberOrNull(game.Away_Score),
              venue: venueName,
              notes: "",
              sources: {
                nrl: {
                  present: true,
                  matchKey: sourceMatchKey,
                  round: normalizeText(game.Round),
                  roundIndex,
                  date: normalizeText(game.Date),
                  homeTeam: game.Home,
                  awayTeam: game.Away,
                  homeScore: numberOrNull(game.Home_Score),
                  awayScore: numberOrNull(game.Away_Score),
                  venue: venueName,
                  url: game.Match_Centre_URL,
                },
              },
            });
            const createdMatch = matchRows.at(-1);
            const legacySupplement = legacyMatchSupplementByNrlUrl.get(normalizeText(game.Match_Centre_URL));
            if (createdMatch && legacySupplement) {
              createdMatch.sources.afltables = {
                present: true,
                matchKey: normalizeText(legacySupplement.match_key),
                round: normalizeText(legacySupplement.round_label),
                roundIndex: numberOrNull(legacySupplement.round_index),
                date: normalizeText(legacySupplement.date),
                homeTeam: normalizeText(legacySupplement.home),
                awayTeam: normalizeText(legacySupplement.away),
                homeScore: numberOrNull(legacySupplement.home_score),
                awayScore: numberOrNull(legacySupplement.away_score),
                venue: normalizeText(legacySupplement.venue),
                url: normalizeText(legacySupplement.url_afltables),
              };
            }
            nextMatchId += 1;
          }
        }
      }
    } catch {}
  }
}

const bundle = {
  generatedAtUtc: new Date().toISOString(),
  counts: {
    teams: teams.size,
    venues: venues.size,
    matches: matchRows.length,
    players: players.size,
    playerAliases: playerAliases.length,
    repairedAflScoreMatches: repairedAflScoreCount,
  },
  competitions: [
    { code: "NRL", name: "National Rugby League" },
    { code: "NRLW", name: "National Rugby League Women" },
    { code: "SOO", name: "State of Origin" },
    { code: "WSOO", name: "Women's State of Origin" },
  ],
  teams: [...teams.values()].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)),
  venues: [...venues.values()].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)),
  players: [...players.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
  playerAliases: playerAliases.sort((a, b) => {
    if (a.canonicalName !== b.canonicalName) {
      return a.canonicalName.localeCompare(b.canonicalName);
    }
    return a.source.localeCompare(b.source);
  }),
  matches: matchRows,
};

const outputPath = path.join(SEED_DIR, "core_import_bundle.json");
await fs.writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

console.log("Core import bundle:", outputPath);
console.log("Counts:", bundle.counts);
