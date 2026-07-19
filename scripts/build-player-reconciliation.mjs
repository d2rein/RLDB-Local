import fs from "node:fs/promises";
import path from "node:path";
import { NRL_DATA_ROOT, RECONCILED_MATCHES_CSV } from "./lib/paths.mjs";
import { parseCsv } from "./lib/csv.mjs";
import { loadLegacyScoringRows } from "./lib/legacy-supplements.mjs";
import { normalizeWhitespace } from "./lib/normalize.mjs";
import { DOCS_DIR, LOCAL_SOURCE_ROOT } from "./lib/project-paths.mjs";

const TEAM_MASTER_LIST_CSV =
  process.env.TEAM_MASTER_LIST_CSV_OVERRIDE ?? path.join(LOCAL_SOURCE_ROOT, "team_master_list.csv");
const PLAYER_RECONCILIATION_OVERRIDES_CSV =
  process.env.PLAYER_RECONCILIATION_OVERRIDES_CSV_OVERRIDE ?? path.join(DOCS_DIR, "player_reconciliation_overrides.csv");

function addTeamMapping(mappings, sourceName, canonicalName, firstYear = 0, lastYear = 9999) {
  if (!sourceName || !canonicalName) {
    return;
  }
  if (!mappings.has(sourceName)) {
    mappings.set(sourceName, []);
  }
  mappings.get(sourceName).push({ firstYear, lastYear, canonicalName });
}

function buildFallbackTeamMappings() {
  const mappings = new Map();
  const identities = [
    "Adelaide Rams",
    "Annandale",
    "Balmain Tigers",
    "Brisbane Broncos",
    "Canberra Raiders",
    "Canterbury-Bankstown Bulldogs",
    "Cronulla-Sutherland Sharks",
    "Cumberland",
    "Dolphins",
    "Glebe Dirty Reds",
    "Gold Coast Chargers",
    "Gold Coast Titans",
    "Hunter",
    "Illawarra Steelers",
    "Manly-Warringah Sea Eagles",
    "Melbourne Storm",
    "New Zealand Warriors",
    "Newcastle Knights",
    "Newcastle Rebels",
    "Newtown Jets",
    "North Queensland Cowboys",
    "North Sydney Bears",
    "Northern Eagles",
    "Parramatta Eels",
    "Penrith Panthers",
    "Perth",
    "South Queensland Crushers",
    "South Sydney Rabbitohs",
    "St George Dragons",
    "St George Illawarra Dragons",
    "Sydney Roosters",
    "University",
    "Western Reds",
    "Western Suburbs Magpies",
    "Blues",
    "Maroons",
    "Sky Blues",
  ];

  for (const team of identities) {
    addTeamMapping(mappings, team, team);
  }

  addTeamMapping(mappings, "Eastern Suburbs", "Sydney Roosters");
  addTeamMapping(mappings, "Eastern Suburbs Roosters", "Sydney Roosters");
  addTeamMapping(mappings, "Canterbury", "Canterbury-Bankstown Bulldogs");
  addTeamMapping(mappings, "Canterbury-Bankstown", "Canterbury-Bankstown Bulldogs");
  addTeamMapping(mappings, "Cronulla", "Cronulla-Sutherland Sharks");
  addTeamMapping(mappings, "St George-Illawarra Dragons", "St George Illawarra Dragons");
  addTeamMapping(mappings, "St George Illawarra", "St George Illawarra Dragons");
  addTeamMapping(mappings, "Souths", "South Sydney Rabbitohs");
  addTeamMapping(mappings, "Wests", "Western Suburbs Magpies");
  addTeamMapping(mappings, "Western Suburbs", "Western Suburbs Magpies");
  addTeamMapping(mappings, "Maroons Women", "Maroons");
  addTeamMapping(mappings, "Blues Women", "Blues");
  addTeamMapping(mappings, "Sky Blues", "Blues");

  return mappings;
}

function normalizePlayerName(name) {
  return normalizeWhitespace(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['.`’]/g, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function slugifyMatchComponent(value) {
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['.`’]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sortTeamList(set) {
  return [...set].sort((a, b) => a.localeCompare(b)).join(" | ");
}

function sortYearList(set) {
  return [...set].sort((a, b) => a - b).join(" | ");
}

function makeSourceRecord(name) {
  return {
    player_name: name,
    normalized_name: normalizePlayerName(name),
    observed_names: new Map([[name, 0]]),
    teams: new Set(),
    seasons: new Set(),
    first_season: null,
    last_season: null,
    first_match_date: null,
    last_match_date: null,
    match_keys: new Set(),
    total_tries: 0,
    total_goals: 0,
    total_fg1: 0,
    total_fg2: 0,
  };
}

async function loadTeamMappings() {
  const mappings = buildFallbackTeamMappings();
  let text = null;
  try {
    text = await fs.readFile(TEAM_MASTER_LIST_CSV, "utf8");
  } catch {
    return mappings;
  }

  const rows = parseCsv(text);

  for (const row of rows) {
    const sourceName = normalizeWhitespace(row.source_name);
    const canonicalName = normalizeWhitespace(row.canonical_name);
    if (!sourceName || !canonicalName) {
      continue;
    }

    addTeamMapping(mappings, sourceName, canonicalName, Number(row.first_year), Number(row.last_year));
  }

  return mappings;
}

async function loadManualOverrides() {
  const text = await fs.readFile(PLAYER_RECONCILIATION_OVERRIDES_CSV, "utf8");
  const rows = parseCsv(text);
  const approvedByNrl = new Map();
  const approvedByAfl = new Map();
  const approvedAflNames = new Set();
  const allRows = [];

  for (const row of rows) {
    const status = normalizeWhitespace(row.status).toLowerCase();
    const nrlPlayerName = normalizeWhitespace(row.nrl_player_name);
    const aflPlayerName = normalizeWhitespace(row.afl_player_name);
    const notes = normalizeWhitespace(row.notes);
    const record = { status, nrlPlayerName, aflPlayerName, notes };
    allRows.push(record);

    if (status === "approved" && nrlPlayerName && aflPlayerName) {
      approvedByNrl.set(nrlPlayerName, record);
      approvedByAfl.set(aflPlayerName, record);
      approvedAflNames.add(aflPlayerName);
    }
  }

  return { approvedByNrl, approvedByAfl, approvedAflNames, allRows };
}

function canonicalizeTeam(teamMappings, teamName, season) {
  const sourceName = normalizeWhitespace(teamName);
  if (!sourceName) {
    return "";
  }

  const options = teamMappings.get(sourceName) ?? [];
  const seasonInt = Number(season);

  for (const option of options) {
    if (Number.isFinite(seasonInt) && seasonInt >= option.firstYear && seasonInt <= option.lastYear) {
      return option.canonicalName;
    }
  }

  return options[0]?.canonicalName ?? sourceName;
}

function updateSourceRecord(record, { season, team, matchKey, matchDate, tries = 0, goals = 0, fg1 = 0, fg2 = 0 }) {
  record.observed_names.set(record.player_name, (record.observed_names.get(record.player_name) ?? 0) + 1);
  if (team) {
    record.teams.add(team);
  }
  if (season !== null && season !== undefined && season !== "") {
    const seasonInt = Number(season);
    record.seasons.add(seasonInt);
    if (record.first_season === null || seasonInt < record.first_season) {
      record.first_season = seasonInt;
    }
    if (record.last_season === null || seasonInt > record.last_season) {
      record.last_season = seasonInt;
    }
  }
  if (matchKey) {
    record.match_keys.add(matchKey);
  }
  if (matchDate) {
    if (record.first_match_date === null || matchDate < record.first_match_date) {
      record.first_match_date = matchDate;
    }
    if (record.last_match_date === null || matchDate > record.last_match_date) {
      record.last_match_date = matchDate;
    }
  }
  record.total_tries += Number(tries) || 0;
  record.total_goals += Number(goals) || 0;
  record.total_fg1 += Number(fg1) || 0;
  record.total_fg2 += Number(fg2) || 0;
}

function mergeSourceRecords(records) {
  const merged = new Map();

  for (const record of records.values()) {
    const key = record.normalized_name;
    if (!merged.has(key)) {
      merged.set(key, {
        player_name: record.player_name,
        normalized_name: record.normalized_name,
        observed_names: new Map(record.observed_names),
        teams: new Set(record.teams),
        seasons: new Set(record.seasons),
        first_season: record.first_season,
        last_season: record.last_season,
        first_match_date: record.first_match_date,
        last_match_date: record.last_match_date,
        match_keys: new Set(record.match_keys),
        total_tries: record.total_tries,
        total_goals: record.total_goals,
        total_fg1: record.total_fg1,
        total_fg2: record.total_fg2,
      });
      continue;
    }

    const target = merged.get(key);
    for (const [name, count] of record.observed_names.entries()) {
      target.observed_names.set(name, (target.observed_names.get(name) ?? 0) + count);
    }
    for (const team of record.teams) {
      target.teams.add(team);
    }
    for (const season of record.seasons) {
      target.seasons.add(season);
    }
    for (const matchKey of record.match_keys) {
      target.match_keys.add(matchKey);
    }

    if (target.first_season === null || (record.first_season !== null && record.first_season < target.first_season)) {
      target.first_season = record.first_season;
    }
    if (target.last_season === null || (record.last_season !== null && record.last_season > target.last_season)) {
      target.last_season = record.last_season;
    }
    if (target.first_match_date === null || (record.first_match_date !== null && record.first_match_date < target.first_match_date)) {
      target.first_match_date = record.first_match_date;
    }
    if (target.last_match_date === null || (record.last_match_date !== null && record.last_match_date > target.last_match_date)) {
      target.last_match_date = record.last_match_date;
    }
    target.total_tries += record.total_tries;
    target.total_goals += record.total_goals;
    target.total_fg1 += record.total_fg1;
    target.total_fg2 += record.total_fg2;
  }

  for (const record of merged.values()) {
    const preferredName = [...record.observed_names.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) {
          return b[1] - a[1];
        }
        return a[0].localeCompare(b[0]);
      })[0]?.[0];
    if (preferredName) {
      record.player_name = preferredName;
    }
  }

  return merged;
}

async function loadReconciledMatchesByKey() {
  const text = await fs.readFile(RECONCILED_MATCHES_CSV, "utf8");
  const rows = parseCsv(text);
  const byMatchKey = new Map();
  for (const row of rows) {
    byMatchKey.set(row.match_key, row);
  }
  return byMatchKey;
}

async function loadNrlMatchLookup() {
  const lookup = new Map();
  const yearDirs = (await fs.readdir(NRL_DATA_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const year of yearDirs) {
    const filePath = path.join(NRL_DATA_ROOT, year, `NRL_data_${year}.json`);
    try {
      await fs.access(filePath);
    } catch {
      continue;
    }

    const data = JSON.parse(await fs.readFile(filePath, "utf8"));
    for (const outer of data.NRL ?? []) {
      for (const seasonRounds of Object.values(outer)) {
        for (const roundEntry of seasonRounds) {
          for (const [roundLabel, matches] of Object.entries(roundEntry)) {
            for (const match of matches) {
              const sourceMatchKey = [
                year,
                roundLabel,
                slugifyMatchComponent(match.Home),
                "v",
                slugifyMatchComponent(match.Away),
              ].join("-");

              lookup.set(sourceMatchKey, {
                season: year,
                round_label: roundLabel,
                home_team: match.Home,
                away_team: match.Away,
                date: match.Date ?? "",
              });
            }
          }
        }
      }
    }
  }

  return lookup;
}

async function buildAflPlayers(teamMappings) {
  const rows = await loadLegacyScoringRows();
  const players = new Map();

  for (const row of rows) {
    const name = row.player;
    if (!players.has(name)) {
      players.set(name, makeSourceRecord(name));
    }
    updateSourceRecord(players.get(name), {
      season: row.year,
      team: canonicalizeTeam(teamMappings, row.team, row.year),
      matchKey: row.match_key,
      matchDate: null,
      tries: row.tries,
      goals: row.goals,
      fg1: row.fg1,
      fg2: row.fg2,
    });
  }

  return players;
}

async function buildNrlPlayers(teamMappings) {
  const matchByKey = await loadReconciledMatchesByKey();
  const nrlLookup = await loadNrlMatchLookup();
  const players = new Map();
  const yearDirs = (await fs.readdir(NRL_DATA_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const year of yearDirs) {
    const filePath = path.join(NRL_DATA_ROOT, year, `NRL_player_statistics_${year}.json`);
    try {
      await fs.access(filePath);
    } catch {
      continue;
    }

    const data = JSON.parse(await fs.readFile(filePath, "utf8"));
    for (const yearBlock of data.PlayerStats ?? []) {
      for (const [season, rounds] of Object.entries(yearBlock)) {
        for (const roundEntry of rounds) {
          for (const [, matchEntries] of Object.entries(roundEntry)) {
            for (const matchEntry of matchEntries) {
              for (const [sourceMatchKey, playerRows] of Object.entries(matchEntry)) {
                const match =
                  matchByKey.get(sourceMatchKey) ??
                  nrlLookup.get(sourceMatchKey) ??
                  null;
                const midpoint = Math.ceil(playerRows.length / 2);

                for (let index = 0; index < playerRows.length; index += 1) {
                  const playerRow = playerRows[index];
                  const name = playerRow.Name;
                  if (!players.has(name)) {
                    players.set(name, makeSourceRecord(name));
                  }

                  let team = "";
                  if (match) {
                    team = canonicalizeTeam(
                      teamMappings,
                      index < midpoint ? match.home_team : match.away_team,
                      season
                    );
                  }

                  updateSourceRecord(players.get(name), {
                    season,
                    team,
                    matchKey: sourceMatchKey,
                    matchDate: match?.date ?? null,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return players;
}

function toCsvRowsFromMap(source, players, teamMeaning) {
  return [...players.values()]
    .sort((a, b) => a.player_name.localeCompare(b.player_name))
    .map((record) => ({
      source,
      player_name: record.player_name,
      normalized_name: record.normalized_name,
      observed_names: [...record.observed_names.keys()].sort((a, b) => a.localeCompare(b)).join(" | "),
      first_season: record.first_season ?? "",
      last_season: record.last_season ?? "",
      seasons: sortYearList(record.seasons),
      teams: sortTeamList(record.teams),
      first_match_date: record.first_match_date ?? "",
      last_match_date: record.last_match_date ?? "",
      match_count: record.match_keys.size,
      total_tries: record.total_tries,
      total_goals: record.total_goals,
      total_fg1: record.total_fg1,
      total_fg2: record.total_fg2,
      team_meaning: teamMeaning,
    }));
}

function parseNameParts(name) {
  const clean = normalizeWhitespace(name)
    .replace(/['.`]/g, "")
    .replace(/-/g, " ");
  const parts = clean.split(" ").filter(Boolean);
  const surname = parts.at(-1)?.toLowerCase() ?? "";
  const givenNames = parts.slice(0, -1);
  const firstName = givenNames[0]?.toLowerCase() ?? "";
  const initials = givenNames.map((part) => part[0]?.toLowerCase() ?? "").join("");
  return { surname, firstName, initials };
}

function seasonsOverlap(a, b) {
  if (a.first_season === null || a.last_season === null || b.first_season === null || b.last_season === null) {
    return false;
  }
  return a.first_season <= b.last_season && b.first_season <= a.last_season;
}

function teamIntersectionSize(a, b) {
  let count = 0;
  for (const team of a.teams) {
    if (b.teams.has(team)) {
      count += 1;
    }
  }
  return count;
}

function isSignificant(record, sourceLabel) {
  if (sourceLabel === "nrl") {
    return record.match_keys.size > 10;
  }
  return record.total_tries > 0 || record.match_keys.size > 10;
}

function scoreCandidate(sourceRecord, candidateRecord, candidateSourceLabel) {
  const sourceParts = parseNameParts(sourceRecord.player_name);
  const candidateParts = parseNameParts(candidateRecord.player_name);
  if (!sourceParts.surname || sourceParts.surname !== candidateParts.surname) {
    return null;
  }

  let score = 100;
  const reasons = ["same surname"];

  if (sourceParts.initials && sourceParts.initials === candidateParts.initials) {
    score += 25;
    reasons.push("same initials");
  }
  if (sourceParts.firstName && sourceParts.firstName === candidateParts.firstName) {
    score += 25;
    reasons.push("same first name");
  } else if (
    sourceParts.firstName &&
    candidateParts.firstName &&
    (sourceParts.firstName.startsWith(candidateParts.firstName) ||
      candidateParts.firstName.startsWith(sourceParts.firstName))
  ) {
    score += 18;
    reasons.push("first name prefix match");
  }

  const overlap = seasonsOverlap(sourceRecord, candidateRecord);
  if (overlap) {
    score += 10;
    reasons.push("season overlap");
  }

  const sharedTeams = teamIntersectionSize(sourceRecord, candidateRecord);
  if (sharedTeams > 0) {
    score += sharedTeams * 8;
    reasons.push(`shared teams=${sharedTeams}`);
  }

  if (candidateSourceLabel === "nrl" && candidateRecord.match_keys.size > 10) {
    score += 5;
    reasons.push("10+ NRL games");
  }
  if (candidateSourceLabel === "afl" && candidateRecord.total_tries > 0) {
    score += 5;
    reasons.push("scored a try");
  }

  return { score, reasons };
}

function formatCandidate(candidateRecord, candidateSourceLabel, scoreInfo) {
  const significance = isSignificant(candidateRecord, candidateSourceLabel) ? "significant" : "minor";
  const span = [candidateRecord.first_season, candidateRecord.last_season].filter(Boolean).join("-");
  const teams = sortTeamList(candidateRecord.teams);
  const extras =
    candidateSourceLabel === "nrl"
      ? `${candidateRecord.match_keys.size} games`
      : `${candidateRecord.match_keys.size} scoring matches, ${candidateRecord.total_tries} tries`;

  return `${candidateRecord.player_name} [score=${scoreInfo.score}; ${significance}; ${extras}; ${span}; ${teams}; ${scoreInfo.reasons.join("; ")}]`;
}

function findClosestCandidates(sourceRecord, oppositeRecords, oppositeSourceLabel, limit = 5) {
  return [...oppositeRecords.values()]
    .map((candidate) => {
      const scoreInfo = scoreCandidate(sourceRecord, candidate, oppositeSourceLabel);
      if (!scoreInfo) {
        return null;
      }
      return { candidate, scoreInfo };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.scoreInfo.score !== a.scoreInfo.score) {
        return b.scoreInfo.score - a.scoreInfo.score;
      }
      return a.candidate.player_name.localeCompare(b.candidate.player_name);
    })
    .slice(0, limit)
    .map(({ candidate, scoreInfo }) => formatCandidate(candidate, oppositeSourceLabel, scoreInfo))
    .join(" || ");
}

function reconcilePlayers(aflPlayers, nrlPlayers, manualOverrides) {
  const eligibleAflPlayers = new Map(aflPlayers.entries());
  const aflByNormalized = new Map();

  for (const record of eligibleAflPlayers.values()) {
    if (!aflByNormalized.has(record.normalized_name)) {
      aflByNormalized.set(record.normalized_name, []);
    }
    aflByNormalized.get(record.normalized_name).push(record);
  }

  const usedAfl = new Set();
  const rows = [];

  for (const nrlRecord of [...nrlPlayers.values()].sort((a, b) => a.player_name.localeCompare(b.player_name))) {
    const manualOverride = manualOverrides.approvedByNrl.get(nrlRecord.player_name) ?? null;
    const candidates = aflByNormalized.has(nrlRecord.normalized_name)
      ? (aflByNormalized.get(nrlRecord.normalized_name) ?? [])
      : [];

    let matchedAfl = null;
    let status = "nrl_only";
    let reasoning = "No AFLTables scorer record matched this normalized name.";

    if (manualOverride) {
      matchedAfl = eligibleAflPlayers.get(normalizePlayerName(manualOverride.aflPlayerName)) ?? null;
      if (matchedAfl) {
        usedAfl.add(matchedAfl.player_name);
        status = "matched_manual_override";
        reasoning = manualOverride.notes
          ? `Manual override approved. ${manualOverride.notes}`
          : "Manual override approved.";
      }
    }

    const available = candidates.filter((candidate) => !usedAfl.has(candidate.player_name));
    if (!matchedAfl && available.length === 1) {
      matchedAfl = available[0];
      usedAfl.add(matchedAfl.player_name);
      const overlap = seasonsOverlap(matchedAfl, nrlRecord);
      const sharedTeams = teamIntersectionSize(matchedAfl, nrlRecord);
      status = overlap || sharedTeams > 0 ? "matched_normalized" : "matched_name_only_review";
      reasoning = overlap || sharedTeams > 0
        ? `Normalized-name match; season overlap=${overlap}; shared teams=${sharedTeams}.`
        : "Normalized-name match only; no season overlap or shared teams detected.";
    } else if (!matchedAfl && available.length > 1) {
      status = "ambiguous_multiple_afltables";
      reasoning = `Multiple AFLTables scorer names share normalized form '${nrlRecord.normalized_name}'.`;
    }

    rows.push({
      suggested_status: status,
      suggested_reasoning: reasoning,
      suggested_canonical_name: matchedAfl?.player_name ?? nrlRecord.player_name,
      possible_afl_matches: !matchedAfl ? findClosestCandidates(nrlRecord, eligibleAflPlayers, "afl") : "",
      possible_nrl_matches: "",
      nrl_player_name: nrlRecord.player_name,
      nrl_observed_names: [...nrlRecord.observed_names.keys()].sort((a, b) => a.localeCompare(b)).join(" | "),
      nrl_first_season: nrlRecord.first_season ?? "",
      nrl_last_season: nrlRecord.last_season ?? "",
      nrl_teams: sortTeamList(nrlRecord.teams),
      nrl_match_count: nrlRecord.match_keys.size,
      afl_player_name: matchedAfl?.player_name ?? "",
      afl_observed_names: matchedAfl ? [...matchedAfl.observed_names.keys()].sort((a, b) => a.localeCompare(b)).join(" | ") : "",
      afl_first_season: matchedAfl?.first_season ?? "",
      afl_last_season: matchedAfl?.last_season ?? "",
      afl_teams: matchedAfl ? sortTeamList(matchedAfl.teams) : "",
      afl_scoring_match_count: matchedAfl?.match_keys.size ?? "",
      afl_total_tries: matchedAfl?.total_tries ?? "",
      normalized_name: nrlRecord.normalized_name,
    });
  }

  for (const aflRecord of [...eligibleAflPlayers.values()].sort((a, b) => a.player_name.localeCompare(b.player_name))) {
    if (usedAfl.has(aflRecord.player_name) || manualOverrides.approvedAflNames.has(aflRecord.player_name)) {
      continue;
    }

    const manualOverride = manualOverrides.approvedByAfl.get(aflRecord.player_name) ?? null;
    if (manualOverride) {
      continue;
    }

    rows.push({
      suggested_status: "afltables_only",
      suggested_reasoning: "No NRL player-stat record matched this AFLTables scorer name.",
      suggested_canonical_name: aflRecord.player_name,
      possible_afl_matches: "",
      possible_nrl_matches: findClosestCandidates(aflRecord, nrlPlayers, "nrl"),
      nrl_player_name: "",
      nrl_observed_names: "",
      nrl_first_season: "",
      nrl_last_season: "",
      nrl_teams: "",
      nrl_match_count: "",
      afl_player_name: aflRecord.player_name,
      afl_observed_names: [...aflRecord.observed_names.keys()].sort((a, b) => a.localeCompare(b)).join(" | "),
      afl_first_season: aflRecord.first_season ?? "",
      afl_last_season: aflRecord.last_season ?? "",
      afl_teams: sortTeamList(aflRecord.teams),
      afl_scoring_match_count: aflRecord.match_keys.size,
      afl_total_tries: aflRecord.total_tries,
      normalized_name: aflRecord.normalized_name,
    });
  }

  return rows;
}

async function writeCsv(filePath, rows) {
  if (rows.length === 0) {
    await fs.writeFile(filePath, "", "utf8");
    return;
  }

  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const raw = String(value ?? "");
    if (/[",\n]/.test(raw)) {
      return `"${raw.replace(/"/g, "\"\"")}"`;
    }
    return raw;
  };

  const text = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(",")),
  ].join("\n");

  await fs.writeFile(filePath, text, "utf8");
}

const outputDir = DOCS_DIR;
const teamMappings = await loadTeamMappings();
const manualOverrides = await loadManualOverrides();
const aflPlayers = mergeSourceRecords(await buildAflPlayers(teamMappings));
const nrlPlayers = mergeSourceRecords(await buildNrlPlayers(teamMappings));

const aflRows = toCsvRowsFromMap(
  "AFLTables scorer data",
  aflPlayers,
  "Teams listed are teams the player scored for in scorer data."
);
const nrlRows = toCsvRowsFromMap(
  "NRL player stats data",
  nrlPlayers,
  "Teams listed are inferred from match structure in player-stat JSON."
);
const reconciledRows = reconcilePlayers(aflPlayers, nrlPlayers, manualOverrides);

await writeCsv(path.join(outputDir, "players_afltables_scorers.csv"), aflRows);
await writeCsv(path.join(outputDir, "players_nrl_player_stats.csv"), nrlRows);
await writeCsv(path.join(outputDir, "players_reconciliation_candidates.csv"), reconciledRows);

const counts = reconciledRows.reduce((acc, row) => {
  acc[row.suggested_status] = (acc[row.suggested_status] ?? 0) + 1;
  return acc;
}, {});

console.log("AFLTables players:", aflRows.length);
console.log("NRL players:", nrlRows.length);
console.log("Reconciliation counts:", counts);
