import fs from "node:fs/promises";
import path from "node:path";
import { NRL_COM_DATASETS } from "./lib/paths.mjs";
import { parseCsv } from "./lib/csv.mjs";
import { DOCS_DIR, SEED_DIR } from "./lib/project-paths.mjs";
import { sqlNumber, sqlString } from "./lib/sql.mjs";
import { slugifyStatKey } from "./lib/normalize.mjs";
import { loadLegacyScoringRows } from "./lib/legacy-supplements.mjs";
import { buildSeasonalAliasLookup, resolveSeasonalAlias } from "./lib/player-splits.mjs";
import { STAT_DEFINITIONS } from "../src/server/config/stat-definitions.mjs";

const bundlePath = path.join(SEED_DIR, "core_import_bundle.json");
const sqlOutputPath = path.join(SEED_DIR, "0005_match_summaries_seed.sql");
const teamSeasonAggregateOutputPath = path.join(SEED_DIR, "0006_team_season_aggregates_seed.sql");
const AFLTABLES_SCORER_REVIEW_CSV = path.join(DOCS_DIR, "players_afltables_scorers.csv");
const GRAND_FINAL_LABEL = "Grand Final";

const PLAYER_STAT_ALIASES = new Map([
  ["mins_played", "minutes_played"],
  ["1_point_field_goals", "field_goals_1pt"],
  ["2_point_field_goals", "field_goals_2pt"],
]);

const TEAM_STAT_ALIASES = new Map([
  ["bombs", "bomb_kicks"],
  ["penalties_conceded", "penalties"],
  ["average_play_ball_speed", "average_play_the_ball_speed"],
  ["referee", "referee"],
]);

const LEGACY_PSEUDO_TEAM_LABELS = new Set(["final", "finals", "major", "minor"]);

const SUPPORTED_PLAYER_KEYS = new Map(
  STAT_DEFINITIONS.filter((stat) => stat.scope === "player").map((stat) => [stat.statKey, stat])
);
const SUPPORTED_TEAM_KEYS = new Map(
  STAT_DEFINITIONS.filter((stat) => stat.scope === "team").map((stat) => [stat.statKey, stat])
);
const TEAM_ZERO_IF_MISSING = new Set(
  STAT_DEFINITIONS.filter((stat) => stat.scope === "team" && stat.missingValueStrategy === "zero_if_missing")
    .map((stat) => stat.statKey)
);
const TEAM_DERIVED_RECIPES = {
  kick_defusal: ["kick_defusal_weighted_numerator", "opposition_kicks"],
  average_play_the_ball_speed: ["average_play_the_ball_speed_weighted_numerator", "opposition_tackles_made"],
  average_set_distance: ["all_run_metres", "sets"],
  completion_rate: ["completed_sets", "sets"],
  effective_tackle: ["tackles_made", "tackle_attempts"],
  goal_conversion_rate: ["conversions_with_attempts", "conversion_attempts"],
};

function normalizeStatKey(rawKey, scope) {
  const slug = slugifyStatKey(rawKey);
  const aliasMap = scope === "team" ? TEAM_STAT_ALIASES : PLAYER_STAT_ALIASES;
  return aliasMap.get(slug) ?? slug;
}

function parseStatValue(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "" || rawValue === "-" || rawValue === "None" || rawValue === -1) {
    return null;
  }

  const text = String(rawValue).trim();
  if (/^\d+:\d{2}$/.test(text)) {
    const [minutes, seconds] = text.split(":").map(Number);
    return minutes + (seconds / 60);
  }
  if (/^\d+(\.\d+)?s$/.test(text)) {
    return Number(text.slice(0, -1));
  }
  if (/^\d+(\.\d+)?%$/.test(text)) {
    return Number(text.slice(0, -1));
  }
  if (/^\d+\/\d+$/.test(text)) {
    const [made] = text.split("/").map(Number);
    return made;
  }
  const cleaned = text.replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return Number(cleaned);
  }
  return null;
}

function parseTeamStatValue(statKey, rawValue) {
  if (statKey === "time_in_possession") {
    if (rawValue === null || rawValue === undefined || rawValue === "" || rawValue === "-" || rawValue === "None" || rawValue === -1) {
      return null;
    }
    const text = String(rawValue).trim();
    const compact = text.replace(/,/g, "");
    if (/^\d{3,4}$/.test(compact)) {
      return Number(compact) / 60;
    }
    return parseStatValue(rawValue);
  }

  if (statKey === "average_play_the_ball_speed") {
    if (rawValue === null || rawValue === undefined || rawValue === "" || rawValue === "-" || rawValue === "None" || rawValue === -1) {
      return null;
    }
    const text = String(rawValue).trim();
    if (/^\d+(\.\d+)?%$/.test(text)) {
      return null;
    }
    if (/^\d+(\.\d+)?s$/.test(text)) {
      return Number(text.slice(0, -1));
    }
    return null;
  }

  return parseStatValue(rawValue);
}

function addHalfScoreStats(teamStats, opponentStats, teamScore, opponentScore) {
  const teamHalf = parseTeamStatValue("half_time", teamStats?.half_time);
  const opponentHalf = parseTeamStatValue("half_time", opponentStats?.half_time);

  teamStats.points_for_first_half = teamHalf;
  teamStats.points_against_first_half = opponentHalf;
  teamStats.margin_first_half =
    teamHalf !== null && opponentHalf !== null ? teamHalf - opponentHalf : null;

  teamStats.points_for_second_half =
    teamHalf !== null ? Number(teamScore ?? 0) - teamHalf : null;
  teamStats.points_against_second_half =
    opponentHalf !== null ? Number(opponentScore ?? 0) - opponentHalf : null;
  teamStats.margin_second_half =
    teamStats.points_for_second_half !== null && teamStats.points_against_second_half !== null
      ? teamStats.points_for_second_half - teamStats.points_against_second_half
      : null;
}

function isMissingRawValue(rawValue) {
  return rawValue === null || rawValue === undefined || rawValue === "" || rawValue === "-" || rawValue === "None" || rawValue === -1;
}

function toCompactNumber(rawValue) {
  if (isMissingRawValue(rawValue)) return null;
  const compact = String(rawValue).trim().replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(compact)) {
    return Number(compact);
  }
  return null;
}

function isMalformedTeamPayload(payload) {
  if (!payload || typeof payload !== "object") return true;

  const averagePlayBallSpeed = String(payload.Average_Play_Ball_Speed ?? "").trim();
  const effectiveTackle = String(payload.Effective_Tackle ?? "").trim();

  if (/^\d+(\.\d+)?%$/.test(averagePlayBallSpeed) || /^\d+(\.\d+)?s$/.test(effectiveTackle)) {
    return true;
  }

  const lineBreaks = toCompactNumber(payload.line_breaks);
  const allRunMetres = toCompactNumber(payload.all_run_metres);
  const timeInPossession = toCompactNumber(payload.time_in_possession);
  const defensiveBlockMissing = [payload.tackles_made, payload.missed_tackles, payload.ineffective_tackles].every(isMissingRawValue);

  if (
    defensiveBlockMissing &&
    lineBreaks !== null &&
    lineBreaks >= 100 &&
    allRunMetres !== null &&
    allRunMetres <= 40 &&
    timeInPossession !== null &&
    timeInPossession <= 250
  ) {
    return true;
  }

  return false;
}

function deriveHistoricalPoints(row) {
  const year = Number(row.year);
  const tries = Number(row.tries) || 0;
  const goals = Number(row.goals) || 0;
  const fg1 = Number(row.fg1) || 0;
  const fg2 = Number(row.fg2) || 0;

  const tryValue = year >= 1983 ? 4 : 3;
  const legacyFieldGoalValue = year <= 1970 ? 2 : 1;

  return (tries * tryValue) + (goals * 2) + (fg1 * legacyFieldGoalValue) + (fg2 * 2);
}

function slugFromUrl(url) {
  if (!url) return null;
  const trimmed = String(url).replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase();
}

function slugFromMatchLabel(label) {
  return String(label)
    .trim()
    .toLowerCase()
    .replace(/\s+v\s+/g, "-v-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function compactSlugFromSourceKey(sourceMatchKey) {
  const parts = String(sourceMatchKey).split("-");
  if (parts.length < 4) return null;
  return parts.slice(2).join("-").toLowerCase();
}

function normalizeTeamAliasKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlayerLookupKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function deriveTeamAliases(teamName) {
  const aliases = new Set();
  const normalized = normalizeTeamAliasKey(teamName);
  if (!normalized) return aliases;

  aliases.add(normalized);

  const words = normalized.split(" ").filter(Boolean);
  if (words.length >= 2) {
    aliases.add(words.slice(-2).join(" "));
  }
  if (words.length >= 1) {
    aliases.add(words.at(-1));
  }

  return aliases;
}

function parseSourceTeams(sourceMatchKey) {
  const compactSlug = compactSlugFromSourceKey(sourceMatchKey);
  if (!compactSlug) return null;
  const divider = compactSlug.indexOf("-v-");
  if (divider === -1) return null;
  return {
    homeLabel: compactSlug.slice(0, divider),
    awayLabel: compactSlug.slice(divider + 3),
  };
}

function parseMatchLabelTeams(matchLabel) {
  const normalized = String(matchLabel ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+v\s+/g, "-v-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const divider = normalized.indexOf("-v-");
  if (divider === -1) return null;
  return {
    homeLabel: normalized.slice(0, divider),
    awayLabel: normalized.slice(divider + 3),
  };
}

function addTeamAlias(aliasGroups, alias, canonicalName) {
  const key = normalizeTeamAliasKey(alias);
  if (!key || !canonicalName) return;
  if (!aliasGroups.has(key)) {
    aliasGroups.set(key, new Set());
  }
  aliasGroups.get(key).add(canonicalName);
}

const TEAM_ALIAS_OVERRIDES = {
  "Sydney Roosters": ["Easts", "Eastern Suburbs", "Sydney City", "Roosters"],
  "South Sydney Rabbitohs": ["Souths", "South Sydney", "Rabbitohs"],
  "Canterbury-Bankstown Bulldogs": ["Canterbury", "Bulldogs"],
  "Cronulla-Sutherland Sharks": ["Cronulla", "Sharks"],
  "Manly-Warringah Sea Eagles": ["Manly", "Sea Eagles"],
  "Parramatta Eels": ["Parramatta", "Eels"],
  "Penrith Panthers": ["Penrith", "Panthers"],
  "Canberra Raiders": ["Canberra", "Raiders"],
  "Brisbane Broncos": ["Brisbane", "Broncos"],
  "Melbourne Storm": ["Storm"],
  "New Zealand Warriors": ["Warriors"],
  "North Queensland Cowboys": ["North Queensland", "Cowboys"],
  "Newcastle Knights": ["Newcastle", "Knights"],
  "Balmain Tigers": ["Balmain"],
  "Wests Tigers": ["Wests Tigers"],
  "Western Suburbs Magpies": ["Wests", "Western Suburbs", "Magpies"],
  "North Sydney Bears": ["Norths", "North Sydney", "Bears"],
  "South Queensland Crushers": ["South Queensland", "Crushers"],
  "Newtown Jets": ["Newtown", "Jets"],
  "Gold Coast Titans": ["Titans"],
  "Gold Coast Chargers": ["Gold Coast"],
  "Illawarra Steelers": ["Illawarra", "Steelers"],
  "St George Dragons": ["St George"],
  "St George Illawarra Dragons": ["St George Illawarra"],
  "Blues Women": ["Sky Blues", "NSW Women", "New South Wales Women"],
};

function buildTeamAliasMap(bundle) {
  const aliasGroups = new Map();

  for (const team of bundle.teams) {
    for (const alias of deriveTeamAliases(team.canonicalName)) {
      addTeamAlias(aliasGroups, alias, team.canonicalName);
    }
    for (const alias of TEAM_ALIAS_OVERRIDES[team.canonicalName] ?? []) {
      addTeamAlias(aliasGroups, alias, team.canonicalName);
    }
  }

  const resolvedAliases = new Map();
  for (const [alias, canonicalNames] of aliasGroups.entries()) {
    if (canonicalNames.size === 1) {
      resolvedAliases.set(alias, [...canonicalNames][0]);
    }
  }
  return resolvedAliases;
}

function buildMatchIndexes(bundle) {
  const byNrlSlug = new Map();
  const byCanonicalTeams = new Map();
  const bySeasonTeams = new Map();
  const bySeasonTeamPairs = new Map();
  const teamAliasMap = buildTeamAliasMap(bundle);

  for (const match of bundle.matches) {
    const roundIndex = match.sources?.nrl?.roundIndex ?? match.roundIndex;
    const slug = slugFromUrl(match.sources?.nrl?.url);
    if (!slug || !roundIndex) continue;
    byNrlSlug.set(`${match.competitionCode}|${match.season}|${roundIndex}|${slug}`, { match, isFlipped: false });
  }

  for (const match of bundle.matches) {
    const normalizedHome = normalizeTeamAliasKey(match.homeTeam);
    const normalizedAway = normalizeTeamAliasKey(match.awayTeam);
    const canonicalKey = [match.competitionCode, match.season, match.roundIndex, normalizedHome, normalizedAway].join("|");
    byCanonicalTeams.set(canonicalKey, { match, isFlipped: false });

    const seasonTeamsKey = [match.competitionCode, match.season, normalizedHome, normalizedAway].join("|");
    if (!bySeasonTeams.has(seasonTeamsKey)) {
      bySeasonTeams.set(seasonTeamsKey, []);
    }
    bySeasonTeams.get(seasonTeamsKey).push({ match, isFlipped: false });

    const pairKey = [match.competitionCode, match.season, [normalizedHome, normalizedAway].sort().join("|")].join("|");
    if (!bySeasonTeamPairs.has(pairKey)) {
      bySeasonTeamPairs.set(pairKey, []);
    }
    bySeasonTeamPairs.get(pairKey).push({
      match,
      normalizedHome,
      normalizedAway,
    });
  }

  function resolveCanonicalMatch(competitionCode, season, roundLabel, homeCanonical, awayCanonical) {
    const normalizedHome = normalizeTeamAliasKey(homeCanonical);
    const normalizedAway = normalizeTeamAliasKey(awayCanonical);
    const exactMatch =
      byCanonicalTeams.get([competitionCode, Number(season), Number(roundLabel), normalizedHome, normalizedAway].join("|")) ?? null;
    if (exactMatch) return exactMatch;

    const reversedExactMatch =
      byCanonicalTeams.get([competitionCode, Number(season), Number(roundLabel), normalizedAway, normalizedHome].join("|")) ?? null;
    if (reversedExactMatch) {
      return { match: reversedExactMatch.match, isFlipped: true };
    }

    const nearbyOrderedCandidates =
      bySeasonTeams.get([competitionCode, Number(season), normalizedHome, normalizedAway].join("|")) ?? [];
    const nearbyReversedCandidates =
      bySeasonTeams.get([competitionCode, Number(season), normalizedAway, normalizedHome].join("|")) ?? [];

    const pairCandidates = [
      ...nearbyOrderedCandidates.map((candidate) => ({ match: candidate.match, isFlipped: false })),
      ...nearbyReversedCandidates.map((candidate) => ({ match: candidate.match, isFlipped: true })),
    ];

    const normalizedPairKey = [competitionCode, Number(season), [normalizedHome, normalizedAway].sort().join("|")].join("|");
    const fallbackPairCandidates =
      bySeasonTeamPairs.get(normalizedPairKey)?.map((candidate) => ({
        match: candidate.match,
        isFlipped: candidate.normalizedHome !== normalizedHome,
      })) ?? [];

    const candidates = (pairCandidates.length > 0 ? pairCandidates : fallbackPairCandidates)
      .filter((candidate) => Math.abs(Number(candidate.match.roundIndex ?? 0) - Number(roundLabel ?? 0)) <= 2)
      .sort((left, right) => {
        const leftDistance = Math.abs(Number(left.match.roundIndex ?? 0) - Number(roundLabel ?? 0));
        const rightDistance = Math.abs(Number(right.match.roundIndex ?? 0) - Number(roundLabel ?? 0));
        if (leftDistance !== rightDistance) return leftDistance - rightDistance;
        if (left.isFlipped !== right.isFlipped) return Number(left.isFlipped) - Number(right.isFlipped);
        if (Number(left.match.isFinals ?? 0) !== Number(right.match.isFinals ?? 0)) {
          return Number(right.match.isFinals ?? 0) - Number(left.match.isFinals ?? 0);
        }
        return Number(right.match.matchId ?? 0) - Number(left.match.matchId ?? 0);
      });

    return candidates[0] ?? null;
  }

  function resolveMatch(season, roundLabel, sourceMatchKey, competitionCode = "NRL") {
    const compactSlug = compactSlugFromSourceKey(sourceMatchKey);
    if (compactSlug) {
      const directMatch = byNrlSlug.get(`${competitionCode}|${season}|${roundLabel}|${compactSlug}`);
      if (directMatch) return directMatch;
    }

    const sourceTeams = parseSourceTeams(sourceMatchKey);
    if (!sourceTeams) return null;

    const homeCanonical = teamAliasMap.get(normalizeTeamAliasKey(sourceTeams.homeLabel.replace(/-/g, " ")));
    const awayCanonical = teamAliasMap.get(normalizeTeamAliasKey(sourceTeams.awayLabel.replace(/-/g, " ")));
    if (!homeCanonical || !awayCanonical) return null;
    return resolveCanonicalMatch(competitionCode, season, roundLabel, homeCanonical, awayCanonical);
  }

  function resolveDetailedMatch(season, roundLabel, matchLabel, competitionCode = "NRL") {
    const slug = slugFromMatchLabel(matchLabel);
    const directMatch = byNrlSlug.get(`${competitionCode}|${season}|${roundLabel}|${slug}`);
    if (directMatch) return directMatch;

    const sourceTeams = parseMatchLabelTeams(matchLabel);
    if (!sourceTeams) return null;

    const homeCanonical = teamAliasMap.get(normalizeTeamAliasKey(sourceTeams.homeLabel.replace(/-/g, " ")));
    const awayCanonical = teamAliasMap.get(normalizeTeamAliasKey(sourceTeams.awayLabel.replace(/-/g, " ")));
    if (!homeCanonical || !awayCanonical) return null;
    return resolveCanonicalMatch(competitionCode, season, roundLabel, homeCanonical, awayCanonical);
  }

  return { byNrlSlug, resolveMatch, resolveDetailedMatch };
}

function buildPlayerAliasMap(bundle) {
  const playerIdByName = new Map(bundle.players.map((player, index) => [player.displayName, index + 1]));
  const aliasMap = buildSeasonalAliasLookup(bundle.playerAliases, ["nrl", "nrlw"]);
  for (const alias of bundle.playerAliases) {
    if (!["nrl", "nrlw"].includes(alias.source)) continue;
    const playerId = playerIdByName.get(alias.canonicalName);
    const entries = aliasMap.get(alias.sourceName) ?? [];
    const target = entries.find((entry) =>
      entry.canonicalName === alias.canonicalName
      && Number(entry.firstSeason) === Number(alias.firstSeason)
      && Number(entry.lastSeason) === Number(alias.lastSeason)
    );
    if (target) {
      target.playerId = playerId ?? null;
      target.canonicalName = alias.canonicalName;
    }
  }
  return aliasMap;
}

function buildAflPlayerAliasMap(bundle) {
  const playerIdByName = new Map(bundle.players.map((player, index) => [player.displayName, index + 1]));
  const aliasMap = buildSeasonalAliasLookup(bundle.playerAliases, ["afltables"]);
  for (const alias of bundle.playerAliases) {
    if (alias.source !== "afltables") continue;
    const playerId = playerIdByName.get(alias.canonicalName);
    const entries = aliasMap.get(alias.sourceName) ?? [];
    const target = entries.find((entry) =>
      entry.canonicalName === alias.canonicalName
      && Number(entry.firstSeason) === Number(alias.firstSeason)
      && Number(entry.lastSeason) === Number(alias.lastSeason)
    );
    if (target) {
      target.playerId = playerId ?? null;
      target.canonicalName = alias.canonicalName;
    }
  }
  return aliasMap;
}

function resolveLegacyTeams(row, match, teamIdByName, teamAliasMap) {
  const rowTeam = String(row.team ?? "").trim();
  const rowHome = String(row.home ?? "").trim();
  const rowAway = String(row.away ?? "").trim();
  const canonicalHome = String(match.homeTeam ?? "").trim();
  const canonicalAway = String(match.awayTeam ?? "").trim();
  const aflHome = String(match.sources?.afltables?.homeTeam ?? "").trim();
  const aflAway = String(match.sources?.afltables?.awayTeam ?? "").trim();

  function canonicalizeTeamName(rawValue) {
    const trimmed = String(rawValue ?? "").trim();
    if (!trimmed) return null;
    if (teamIdByName.has(trimmed)) return trimmed;
    return teamAliasMap.get(normalizeTeamAliasKey(trimmed)) ?? null;
  }

  function canonicalSideFromName(rawValue) {
    const canonicalName = canonicalizeTeamName(rawValue);
    if (!canonicalName) return null;
    if (canonicalName === canonicalHome) return "home";
    if (canonicalName === canonicalAway) return "away";
    return null;
  }

  function resultForCanonicalSide(side) {
    return side === "home"
      ? {
          teamId: teamIdByName.get(match.homeTeam) ?? null,
          opponentTeamId: teamIdByName.get(match.awayTeam) ?? null,
          isHome: 1,
        }
      : {
          teamId: teamIdByName.get(match.awayTeam) ?? null,
          opponentTeamId: teamIdByName.get(match.homeTeam) ?? null,
          isHome: 0,
        };
  }

  const sourceHomeSide = canonicalSideFromName(aflHome) ?? canonicalSideFromName(rowHome);
  const sourceAwaySide = canonicalSideFromName(aflAway) ?? canonicalSideFromName(rowAway);
  const rowTeamSide = canonicalSideFromName(rowTeam);

  if (rowTeamSide) {
    return resultForCanonicalSide(rowTeamSide);
  }

  if (rowTeam && normalizeTeamAliasKey(rowTeam) === normalizeTeamAliasKey(rowHome) && sourceHomeSide) {
    return resultForCanonicalSide(sourceHomeSide);
  }

  if (rowTeam && normalizeTeamAliasKey(rowTeam) === normalizeTeamAliasKey(rowAway) && sourceAwaySide) {
    return resultForCanonicalSide(sourceAwaySide);
  }

  if (sourceHomeSide && !sourceAwaySide) return resultForCanonicalSide(sourceHomeSide);
  if (sourceAwaySide && !sourceHomeSide) return resultForCanonicalSide(sourceAwaySide);

  return {
    teamId: canonicalizeTeamName(row.team) ? teamIdByName.get(canonicalizeTeamName(row.team)) ?? null : null,
    opponentTeamId: null,
    isHome: null,
  };
}

function buildLegacyReferenceTeamHints(rows, teamAliasMap) {
  const hints = new Map();

  for (const row of rows) {
    const key = normalizePlayerLookupKey(row.player_name);
    if (!key) continue;
    const rawTeams = String(row.teams ?? "")
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean);
    const canonicalTeams = new Set();

    for (const rawTeam of rawTeams) {
      const normalized = normalizeTeamAliasKey(rawTeam);
      if (!normalized || LEGACY_PSEUDO_TEAM_LABELS.has(normalized)) continue;
      const canonicalTeam = teamAliasMap.get(normalized) ?? rawTeam;
      if (canonicalTeam) {
        canonicalTeams.add(canonicalTeam);
      }
    }

    if (canonicalTeams.size > 0) {
      hints.set(key, canonicalTeams);
    }
  }

  return hints;
}

function splitRuns(players) {
  const runs = [];
  let currentRun = [];
  let previousNumber = null;
  for (const player of players) {
    const number = Number(player.Number ?? 999);
    if (currentRun.length > 0 && number < previousNumber) {
      runs.push(currentRun);
      currentRun = [];
    }
    currentRun.push(player);
    previousNumber = number;
  }
  if (currentRun.length > 0) runs.push(currentRun);
  return runs;
}

function assignRuns(runs) {
  if (runs.length <= 1) return { homeRuns: runs, awayRuns: [] };
  if (runs.length === 2) return { homeRuns: [runs[0]], awayRuns: [runs[1]] };
  if (runs.length === 4) return { homeRuns: [runs[0], runs[1]], awayRuns: [runs[2], runs[3]] };
  const split = Math.ceil(runs.length / 2);
  return { homeRuns: runs.slice(0, split), awayRuns: runs.slice(split) };
}

function mergeTeamRuns(runs) {
  const merged = new Map();
  for (const run of runs) {
    for (const player of run) {
      const key = `${player.Name}|${player.Number}`;
      if (!merged.has(key)) {
        merged.set(key, { ...player });
        continue;
      }
      const existing = merged.get(key);
      for (const [rawKey, rawValue] of Object.entries(player)) {
        if ((existing[rawKey] === "-" || existing[rawKey] === null || existing[rawKey] === undefined || existing[rawKey] === "") && rawValue !== "-" && rawValue !== null && rawValue !== undefined && rawValue !== "") {
          existing[rawKey] = rawValue;
        }
      }
    }
  }
  return [...merged.values()];
}

function buildPlayerStats(row) {
  const stats = { games_played: 1 };
  for (const definition of SUPPORTED_PLAYER_KEYS.values()) {
    if (definition.statKey === "games_played") continue;
    stats[definition.statKey] = definition.missingValueStrategy === "zero_if_missing" ? 0 : null;
  }

  for (const [rawKey, rawValue] of Object.entries(row)) {
    if (["Name", "Number", "Position"].includes(rawKey)) continue;
    const statKey = normalizeStatKey(rawKey, "player");
    const definition = SUPPORTED_PLAYER_KEYS.get(statKey);
    if (!definition) continue;
    const parsedValue = parseStatValue(rawValue);
    if (parsedValue === null) {
      if (definition.missingValueStrategy === "zero_if_missing") {
        stats[statKey] = 0;
      }
      continue;
    }
    stats[statKey] = parsedValue;
  }

  if (stats.points === null && (stats.tries !== null || stats.conversions !== null || stats.penalty_goals !== null || stats.field_goals_1pt !== null || stats.field_goals_2pt !== null)) {
    stats.points =
      (Number(stats.tries ?? 0) * 4) +
      (Number(stats.conversions ?? 0) * 2) +
      (Number(stats.penalty_goals ?? 0) * 2) +
      Number(stats.field_goals_1pt ?? 0) +
      (Number(stats.field_goals_2pt ?? 0) * 2);
  }
  stats.goals = Number(stats.conversions ?? 0) + Number(stats.penalty_goals ?? 0);

  if (stats.total_points === null && stats.points !== null) {
    stats.total_points = Number(stats.points);
  }
  if (stats.average_play_the_ball_speed !== null) {
    let playTheBallDenominator = stats.play_the_ball;
    if (playTheBallDenominator === null || playTheBallDenominator === undefined) {
      const estimated = Number(stats.receipts ?? 0) - (Number(stats.passes ?? 0) + Number(stats.kicks ?? 0));
      playTheBallDenominator = Math.max(1, estimated);
      stats.play_the_ball = playTheBallDenominator;
    }
    if (Number(playTheBallDenominator) > 0) {
      stats.play_the_ball_total_seconds = Number(playTheBallDenominator) * Number(stats.average_play_the_ball_speed);
    }
  }
  if (stats.conversion_attempts !== null && Number(stats.conversion_attempts) > 0 && stats.conversions !== null) {
    stats.conversions_with_attempts = Number(stats.conversions);
    stats.goal_conversion_rate = (Number(stats.conversions) * 100) / Number(stats.conversion_attempts);
  }
  stats.goals = Number(stats.conversions ?? 0) + Number(stats.penalty_goals ?? 0);
  if ([stats.tackles_made, stats.missed_tackles, stats.ineffective_tackles].some((value) => value !== null)) {
    stats.tackle_attempts =
      Number(stats.tackles_made ?? 0) +
      Number(stats.missed_tackles ?? 0) +
      Number(stats.ineffective_tackles ?? 0);
  }
  if (stats.passes !== null && stats.all_runs !== null && Number(stats.all_runs) > 0) {
    stats.passes_to_run_ratio = Number(stats.passes) / Number(stats.all_runs);
  }
  if (stats.tackle_attempts && Number(stats.tackle_attempts) > 0 && stats.tackles_made !== null) {
    stats.tackle_efficiency = (Number(stats.tackles_made) * 100) / Number(stats.tackle_attempts);
  }

  return stats;
}

function buildTeamStats(payload) {
  const stats = {};
  for (const [rawKey, rawValue] of Object.entries(payload)) {
    const statKey = normalizeStatKey(rawKey, "team");
    const parsedValue = parseTeamStatValue(statKey, rawValue);
    stats[statKey] = parsedValue;
  }
  if (stats.conversions !== null && payload.conversions && typeof payload.conversions === "string" && /^\d+\/\d+$/.test(payload.conversions)) {
    const [, attempts] = payload.conversions.split("/").map(Number);
    stats.conversion_attempts = attempts;
  }
  if ([stats.tackles_made, stats.missed_tackles, stats.ineffective_tackles].some((value) => value !== null)) {
    stats.tackle_attempts =
      Number(stats.tackles_made ?? 0) +
      Number(stats.missed_tackles ?? 0) +
      Number(stats.ineffective_tackles ?? 0);
  }
  if (stats.conversion_attempts !== null && Number(stats.conversion_attempts) > 0 && stats.conversions !== null) {
    stats.conversions_with_attempts = Number(stats.conversions);
    stats.goal_conversion_rate = (Number(stats.conversions) * 100) / Number(stats.conversion_attempts);
  }
  if (stats.average_set_distance !== null && Number(stats.average_set_distance) > 0 && stats.all_run_metres !== null) {
    stats.sets = Number(stats.all_run_metres) / Number(stats.average_set_distance);
  }
  if (stats.sets !== null && stats.completion_rate !== null) {
    stats.completed_sets = Number(stats.sets) * (Number(stats.completion_rate) / 100);
  }
  if (stats.kick_defusal !== null && stats.kicks !== null) {
    stats.kick_defusal_weighted_numerator = Number(stats.kick_defusal) * Number(stats.kicks) / 100;
  }
  if (stats.average_play_the_ball_speed !== null && stats.tackles_made !== null) {
    stats.average_play_the_ball_speed_weighted_numerator = Number(stats.average_play_the_ball_speed) * Number(stats.tackles_made);
  }
  if (stats.tackle_attempts && Number(stats.tackle_attempts) > 0 && stats.tackles_made !== null) {
    stats.effective_tackle = (Number(stats.tackles_made) * 100) / Number(stats.tackle_attempts);
  }
  return stats;
}

function seasonPhaseForRow(row, match) {
  if (!Number(row.isFinals)) return "regular";
  const roundLabel = String(match?.roundLabel ?? "").trim();
  return roundLabel === GRAND_FINAL_LABEL ? "grand_final" : "finals";
}

function addSeasonAggregateValue(target, key, payload) {
  if (!target.has(key)) {
    target.set(key, {
      teamId: payload.teamId,
      teamNameRaw: payload.teamNameRaw,
      source: payload.source,
      season: payload.season,
      seasonPhase: payload.seasonPhase,
      statKey: payload.statKey,
      totalValue: 0,
      recordedGames: 0,
      totalGames: 0,
      firstSeason: payload.season,
      lastSeason: payload.season,
    });
  }
  const aggregate = target.get(key);
  aggregate.totalValue += Number(payload.value ?? 0);
  aggregate.recordedGames += Number(payload.recorded ?? 0);
}

function buildTeamSeasonAggregates(teamSummaries, matchById, bundle) {
  const seasonGameCounts = new Map();
  const aggregateRows = new Map();
  const teamNameById = new Map(bundle.teams.map((team, index) => [index + 1, team.canonicalName]));

  for (const row of teamSummaries) {
    if (!row.teamId) continue;
    const match = matchById.get(row.matchId);
    if (!match) continue;
    const seasonPhase = seasonPhaseForRow(row, match);
    const source = String(match.competitionCode ?? "").trim().toLowerCase();
    const teamNameRaw = teamNameById.get(row.teamId) ?? `Team ${row.teamId}`;
    const seasonKey = `${row.teamId}|${source}|${row.season}|${seasonPhase}`;
    seasonGameCounts.set(seasonKey, (seasonGameCounts.get(seasonKey) ?? 0) + 1);

    const stats = JSON.parse(String(row.statsJson ?? "{}"));
    const scoreValues = {
      games: { value: 1, recorded: 1 },
      wins: { value: row.resultCode === "W" ? 1 : 0, recorded: 1 },
      losses: { value: row.resultCode === "L" ? 1 : 0, recorded: 1 },
      draws: { value: row.resultCode === "T" ? 1 : 0, recorded: 1 },
      points_for: { value: Number(row.teamScore ?? 0), recorded: 1 },
      points_against: { value: Number(row.opponentScore ?? 0), recorded: 1 },
      total_points: { value: Number(row.teamScore ?? 0) + Number(row.opponentScore ?? 0), recorded: 1 },
      margin: { value: Number(row.teamScore ?? 0) - Number(row.opponentScore ?? 0), recorded: 1 },
    };

    for (const [statKey, { value, recorded }] of Object.entries(scoreValues)) {
      addSeasonAggregateValue(
        aggregateRows,
        `${seasonKey}|${statKey}`,
        { teamId: row.teamId, teamNameRaw, source, season: row.season, seasonPhase, statKey, value, recorded }
      );
    }

    for (const [rawStatKey, rawValue] of Object.entries(stats)) {
      if (rawValue === null || rawValue === undefined || Number.isNaN(Number(rawValue))) {
        if (!TEAM_ZERO_IF_MISSING.has(rawStatKey)) continue;
      }
      const numericValue = rawValue === null || rawValue === undefined ? 0 : Number(rawValue);
      const definition = SUPPORTED_TEAM_KEYS.get(rawStatKey) ?? null;
      const recorded = rawValue === null || rawValue === undefined
        ? (TEAM_ZERO_IF_MISSING.has(rawStatKey) ? 1 : 0)
        : 1;
      if (!definition && !TEAM_DERIVED_RECIPES[rawStatKey]) {
        if (![
          "conversion_attempts",
          "conversions_with_attempts",
          "tackle_attempts",
          "sets",
          "completed_sets",
          "kick_defusal_weighted_numerator",
          "opposition_kicks",
          "average_play_the_ball_speed_weighted_numerator",
          "opposition_tackles_made",
          "points_for_first_half",
          "points_against_first_half",
          "margin_first_half",
          "points_for_second_half",
          "points_against_second_half",
          "margin_second_half",
        ].includes(rawStatKey)) {
          continue;
        }
      }
      addSeasonAggregateValue(
        aggregateRows,
        `${seasonKey}|${rawStatKey}`,
        {
          teamId: row.teamId,
          teamNameRaw,
          source,
          season: row.season,
          seasonPhase,
          statKey: rawStatKey,
          value: numericValue,
          recorded,
        }
      );
    }
  }

  const aggregates = [...aggregateRows.values()].sort((left, right) =>
    left.teamNameRaw.localeCompare(right.teamNameRaw)
    || left.season - right.season
    || left.seasonPhase.localeCompare(right.seasonPhase)
    || left.statKey.localeCompare(right.statKey)
  );

  for (const aggregate of aggregates) {
    aggregate.totalGames = seasonGameCounts.get(`${aggregate.teamId}|${aggregate.source}|${aggregate.season}|${aggregate.seasonPhase}`) ?? 0;
  }

  return aggregates;
}

const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
const { byNrlSlug, resolveMatch, resolveDetailedMatch } = buildMatchIndexes(bundle);
const playerAliasMap = buildPlayerAliasMap(bundle);
const aflPlayerAliasMap = buildAflPlayerAliasMap(bundle);
const teamIdByName = new Map(bundle.teams.map((team, index) => [team.canonicalName, index + 1]));
const teamAliasMap = buildTeamAliasMap(bundle);
const matchById = new Map(bundle.matches.map((match) => [match.matchId, match]));
function legacyMatchIdentity(matchKey, date) {
  const key = String(matchKey ?? "").trim();
  const matchDate = String(date ?? "").trim();
  return matchDate ? `${key}|${matchDate}` : key;
}

const matchIdsByAflKey = new Map();
const matchIdByAflIdentity = new Map();
for (const match of bundle.matches) {
  const aflKey = match.sources?.afltables?.matchKey;
  if (!aflKey) continue;
  if (!matchIdsByAflKey.has(aflKey)) {
    matchIdsByAflKey.set(aflKey, []);
  }
  matchIdsByAflKey.get(aflKey).push(match.matchId);
  matchIdByAflIdentity.set(
    legacyMatchIdentity(aflKey, match.sources?.afltables?.date ?? match.matchDateUtc),
    match.matchId
  );
}
const legacyRows = await loadLegacyScoringRows();
const legacyReferenceRows = parseCsv(await fs.readFile(AFLTABLES_SCORER_REVIEW_CSV, "utf8"));

function resolveLegacyMatchId(row) {
  const identityMatchId = matchIdByAflIdentity.get(legacyMatchIdentity(row.match_key, row.date));
  if (identityMatchId) return identityMatchId;

  const keyMatches = matchIdsByAflKey.get(row.match_key) ?? [];
  return keyMatches.length === 1 ? keyMatches[0] : null;
}

async function listDatasetYears(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a) - Number(b));
  } catch {
    return [];
  }
}

const playerSummaryMap = new Map();
const teamSummaries = [];
const teamSummaryKeys = new Set();
const matchMetaById = new Map();
const unresolvedPlayerMatches = [];
const unresolvedDetailedMatches = [];
let legacyRowsInserted = 0;
let legacyRowsSkippedMissingTeam = 0;
let legacyRowsInferredBySeason = 0;
let legacyRowsInferredByCareer = 0;
let legacyRowsInferredByReference = 0;
let legacyRowsInferredByScoreBalance = 0;

function teamSummaryKey(row) {
  return [row.matchId ?? "match:null", row.teamId ?? "team:null"].join("|");
}

function pushTeamSummary(row) {
  const key = teamSummaryKey(row);
  if (teamSummaryKeys.has(key)) return;
  teamSummaryKeys.add(key);
  teamSummaries.push(row);
}

function buildTeamScoringRollups(playerSummaryRows) {
  const rollups = new Map();
  for (const row of playerSummaryRows) {
    if (!row.matchId || !row.teamId) continue;
    const key = `${row.matchId}|${row.teamId}`;
    if (!rollups.has(key)) {
      rollups.set(key, {
        tries: 0,
        goals: 0,
        field_goals_1pt: 0,
        field_goals_2pt: 0,
        points: 0,
        playerCount: 0,
      });
    }
    const target = rollups.get(key);
    target.tries += Number(row.stats?.tries ?? 0);
    target.goals += Number(row.stats?.goals ?? 0);
    target.field_goals_1pt += Number(row.stats?.field_goals_1pt ?? 0);
    target.field_goals_2pt += Number(row.stats?.field_goals_2pt ?? 0);
    target.points += Number(row.stats?.points ?? 0);
    target.playerCount += 1;
  }
  return rollups;
}

function enrichTeamSummariesFromPlayerScoring(teamSummaryRows, playerSummaryRows) {
  const scoringRollups = buildTeamScoringRollups(playerSummaryRows);
  let enrichedCount = 0;
  let skippedMismatchCount = 0;

  for (const row of teamSummaryRows) {
    if (!row.matchId || !row.teamId) continue;
    const rollup = scoringRollups.get(`${row.matchId}|${row.teamId}`);
    if (!rollup || rollup.playerCount === 0) continue;

    const stats = JSON.parse(String(row.statsJson ?? "{}"));
    const hasExistingScoring =
      stats.tries !== null && stats.tries !== undefined
      || stats.goals !== null && stats.goals !== undefined
      || stats.field_goals_1pt !== null && stats.field_goals_1pt !== undefined
      || stats.field_goals_2pt !== null && stats.field_goals_2pt !== undefined;

    if (hasExistingScoring) continue;

    const teamScore = Number(row.teamScore ?? 0);
    if (Number(rollup.points ?? 0) !== teamScore) {
      skippedMismatchCount += 1;
      continue;
    }

    stats.tries = rollup.tries;
    stats.goals = rollup.goals;
    stats.field_goals_1pt = rollup.field_goals_1pt;
    stats.field_goals_2pt = rollup.field_goals_2pt;
    stats.points = rollup.points;
    row.statsJson = JSON.stringify(stats);
    enrichedCount += 1;
  }

  return { enrichedCount, skippedMismatchCount };
}

function getLegacyHintTeamIds(item, match, teamIdByName, playerSeasonTeamHints, playerCareerTeamHints, legacyReferenceTeamHints) {
  const homeTeamId = teamIdByName.get(match.homeTeam) ?? null;
  const awayTeamId = teamIdByName.get(match.awayTeam) ?? null;
  const validTeamIds = new Set([homeTeamId, awayTeamId].filter(Boolean));
  const hintTeamIds = new Set();

  for (const teamId of playerSeasonTeamHints.get(`${item.playerLookupKey}|${item.season}`) ?? []) {
    if (validTeamIds.has(teamId)) hintTeamIds.add(teamId);
  }
  for (const teamId of playerCareerTeamHints.get(item.playerLookupKey) ?? []) {
    if (validTeamIds.has(teamId)) hintTeamIds.add(teamId);
  }
  for (const teamName of legacyReferenceTeamHints.get(item.playerLookupKey) ?? []) {
    const teamId = teamIdByName.get(teamName) ?? null;
    if (teamId && validTeamIds.has(teamId)) hintTeamIds.add(teamId);
  }

  return hintTeamIds;
}

function inferLegacyRowsByScoreBalance(unresolvedRows, resolvedRows, teamIdByName, playerSeasonTeamHints, playerCareerTeamHints, legacyReferenceTeamHints) {
  const resolvedByMatch = new Map();
  for (const item of resolvedRows) {
    if (!resolvedByMatch.has(item.matchId)) {
      resolvedByMatch.set(item.matchId, []);
    }
    resolvedByMatch.get(item.matchId).push(item);
  }

  const unresolvedByMatch = new Map();
  for (const item of unresolvedRows) {
    if (!unresolvedByMatch.has(item.matchId)) {
      unresolvedByMatch.set(item.matchId, []);
    }
    unresolvedByMatch.get(item.matchId).push(item);
  }

  const inferredRows = [];
  const stillUnresolved = [];

  for (const matchItems of unresolvedByMatch.values()) {
    const match = matchItems[0]?.match;
    if (!match) {
      stillUnresolved.push(...matchItems);
      continue;
    }

    const homeTeamId = teamIdByName.get(match.homeTeam) ?? null;
    const awayTeamId = teamIdByName.get(match.awayTeam) ?? null;
    if (!homeTeamId || !awayTeamId) {
      stillUnresolved.push(...matchItems);
      continue;
    }

    const resolvedMatchItems = resolvedByMatch.get(match.matchId) ?? [];
    let knownHomePoints = 0;
    let knownAwayPoints = 0;
    for (const item of resolvedMatchItems) {
      const points = deriveHistoricalPoints(item.row);
      if (item.teamId === homeTeamId) knownHomePoints += points;
      if (item.teamId === awayTeamId) knownAwayPoints += points;
    }

    const unresolvedPoints = matchItems.reduce((total, item) => total + deriveHistoricalPoints(item.row), 0);
    const targetHomePoints = Number(match.homeScore) - knownHomePoints;
    const targetAwayPoints = Number(match.awayScore) - knownAwayPoints;

    if (
      !Number.isFinite(targetHomePoints) ||
      !Number.isFinite(targetAwayPoints) ||
      targetHomePoints < 0 ||
      targetAwayPoints < 0 ||
      (targetHomePoints + targetAwayPoints) !== unresolvedPoints
    ) {
      stillUnresolved.push(...matchItems);
      continue;
    }

    const annotatedItems = matchItems.map((item) => {
      const allowedTeamIds = getLegacyHintTeamIds(
        item,
        match,
        teamIdByName,
        playerSeasonTeamHints,
        playerCareerTeamHints,
        legacyReferenceTeamHints
      );
      return {
        ...item,
        points: deriveHistoricalPoints(item.row),
        allowedHome: allowedTeamIds.size === 0 || allowedTeamIds.has(homeTeamId),
        allowedAway: allowedTeamIds.size === 0 || allowedTeamIds.has(awayTeamId),
      };
    });

    if (annotatedItems.some((item) => !item.allowedHome && !item.allowedAway)) {
      stillUnresolved.push(...matchItems);
      continue;
    }

    const solutions = [];
    const assignment = new Array(annotatedItems.length);

    function search(index, remainingHome, remainingAway) {
      if (solutions.length > 1) return;
      if (index === annotatedItems.length) {
        if (remainingHome === 0 && remainingAway === 0) {
          solutions.push([...assignment]);
        }
        return;
      }

      const item = annotatedItems[index];
      if (item.allowedHome && item.points <= remainingHome) {
        assignment[index] = homeTeamId;
        search(index + 1, remainingHome - item.points, remainingAway);
      }
      if (item.allowedAway && item.points <= remainingAway) {
        assignment[index] = awayTeamId;
        search(index + 1, remainingHome, remainingAway - item.points);
      }
    }

    search(0, targetHomePoints, targetAwayPoints);

    if (solutions.length !== 1) {
      stillUnresolved.push(...matchItems);
      continue;
    }

    const [solution] = solutions;
    for (let index = 0; index < annotatedItems.length; index += 1) {
      const item = annotatedItems[index];
      const teamId = solution[index];
      inferredRows.push({
        ...item,
        teamId,
        opponentTeamId: teamId === homeTeamId ? awayTeamId : homeTeamId,
        isHome: teamId === homeTeamId ? 1 : 0,
      });
    }
  }

  return { inferredRows, stillUnresolved };
}

function playerSummaryKey(row) {
  const playerToken = row.playerId ?? `name:${String(row.playerNameRaw ?? "").toLowerCase()}`;
  return [
    row.matchId ?? "match:null",
    row.teamId ?? "team:null",
    playerToken,
  ].join("|");
}

function upsertPlayerSummary(row, options = {}) {
  const { scoringOverride = false } = options;
  const key = playerSummaryKey(row);
  const incomingStats = row.stats;
  const existing = playerSummaryMap.get(key);

  if (!existing) {
    playerSummaryMap.set(key, {
      ...row,
      stats: { ...incomingStats },
    });
    return;
  }

  existing.playerId ??= row.playerId ?? null;
  existing.playerNameRaw ??= row.playerNameRaw ?? null;
  existing.teamId ??= row.teamId ?? null;
  existing.opponentTeamId ??= row.opponentTeamId ?? null;
  existing.season ??= row.season ?? null;
  existing.roundIndex ??= row.roundIndex ?? null;
  existing.isFinals ??= row.isFinals ?? null;
  existing.matchDateUtc ??= row.matchDateUtc ?? null;
  existing.isHome ??= row.isHome ?? null;
  existing.jumperNumber ??= row.jumperNumber ?? null;
  existing.positionLabel ??= row.positionLabel ?? null;

  for (const [statKey, statValue] of Object.entries(incomingStats)) {
    if (statValue === null || statValue === undefined) continue;

    if (scoringOverride && ["tries", "points", "field_goals_1pt", "field_goals_2pt"].includes(statKey)) {
      existing.stats[statKey] = statValue;
      continue;
    }

    if (existing.stats[statKey] === null || existing.stats[statKey] === undefined) {
      existing.stats[statKey] = statValue;
    }
  }
}

function comparePlayerSummaryOrder(left, right) {
  const leftDate = left.matchDateUtc ?? "";
  const rightDate = right.matchDateUtc ?? "";
  if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
  const leftSeason = Number(left.season ?? 0);
  const rightSeason = Number(right.season ?? 0);
  if (leftSeason !== rightSeason) return leftSeason - rightSeason;
  const leftRound = Number(left.roundIndex ?? 0);
  const rightRound = Number(right.roundIndex ?? 0);
  if (leftRound !== rightRound) return leftRound - rightRound;
  const leftMatch = Number(left.matchId ?? 0);
  const rightMatch = Number(right.matchId ?? 0);
  return leftMatch - rightMatch;
}

function playerIdentityKey(row) {
  return row.playerId ?? `name:${String(row.playerNameRaw ?? "").toLowerCase()}`;
}

function recordUnresolvedMatch(collection, payload) {
  if (collection.length >= 100) return;
  collection.push(payload);
}

for (const dataset of NRL_COM_DATASETS) {
  const yearDirectories = await listDatasetYears(dataset.root);
  for (const year of yearDirectories) {
    const playerFilePath = path.join(dataset.root, year, `${dataset.sourceKey}_player_statistics_${year}.json`);
    const detailFilePath = path.join(dataset.root, year, `${dataset.sourceKey}_detailed_match_data_${year}.json`);

    try {
      const playerJson = JSON.parse(await fs.readFile(playerFilePath, "utf8"));
      for (const yearBlock of playerJson.PlayerStats ?? []) {
        for (const [season, rounds] of Object.entries(yearBlock)) {
          for (const roundEntry of rounds) {
            for (const [roundLabel, matchEntries] of Object.entries(roundEntry)) {
              for (const matchEntry of matchEntries) {
                for (const [sourceMatchKey, players] of Object.entries(matchEntry)) {
                  if (!Array.isArray(players) || players.length === 0) {
                    continue;
                  }
                  const resolvedMatch = resolveMatch(season, roundLabel, sourceMatchKey, dataset.competitionCode);
                  if (!resolvedMatch) {
                    recordUnresolvedMatch(unresolvedPlayerMatches, {
                      competitionCode: dataset.competitionCode,
                      season: Number(season),
                      roundLabel: Number(roundLabel),
                      sourceMatchKey,
                      playerCount: players.length,
                    });
                    continue;
                  }

                const { match, isFlipped } = resolvedMatch;
                const runs = splitRuns(players);
                const { homeRuns, awayRuns } = assignRuns(runs);
                const homePlayers = mergeTeamRuns(homeRuns);
                const awayPlayers = mergeTeamRuns(awayRuns);

                const rosterAssignments = isFlipped
                  ? [
                      [0, homePlayers, match.awayTeam, match.homeTeam],
                      [1, awayPlayers, match.homeTeam, match.awayTeam],
                    ]
                  : [
                      [1, homePlayers, match.homeTeam, match.awayTeam],
                      [0, awayPlayers, match.awayTeam, match.homeTeam],
                    ];

                for (const [isHome, roster, teamName, opponentName] of rosterAssignments) {
                  for (const player of roster) {
                    const alias = resolveSeasonalAlias(playerAliasMap, player.Name, season);
                    upsertPlayerSummary({
                      matchId: match.matchId,
                      playerId: alias?.playerId ?? null,
                      playerNameRaw: alias?.canonicalName ?? player.Name,
                      teamId: teamIdByName.get(teamName) ?? null,
                      opponentTeamId: teamIdByName.get(opponentName) ?? null,
                      season: Number(season),
                      roundIndex: Number(match.roundIndex),
                      isFinals: match.isFinals,
                      matchDateUtc: match.matchDateUtc,
                      isHome,
                      jumperNumber: parseStatValue(player.Number),
                      positionLabel: player.Position ?? null,
                      stats: buildPlayerStats(player),
                    });
                  }
                }
                }
              }
            }
          }
        }
      }
    } catch {}

    try {
      const detailJson = JSON.parse(await fs.readFile(detailFilePath, "utf8"));
      for (const roundBlock of detailJson[dataset.sourceKey] ?? []) {
        for (const [roundLabel, matches] of Object.entries(roundBlock)) {
          for (const wrapper of matches) {
            for (const [matchLabel, payload] of Object.entries(wrapper)) {
              const resolvedMatch = resolveDetailedMatch(year, roundLabel, matchLabel, dataset.competitionCode);
              if (!resolvedMatch) {
                recordUnresolvedMatch(unresolvedDetailedMatches, {
                  competitionCode: dataset.competitionCode,
                  season: Number(year),
                  roundLabel: Number(roundLabel),
                  matchLabel,
                });
                continue;
              }
            const { match, isFlipped } = resolvedMatch;
            const matchMeta = {
              ground_condition: payload.match?.ground_condition ?? null,
              weather_condition: payload.match?.weather_condition ?? null,
              referee: payload.match?.main_ref ?? null,
            };
            matchMetaById.set(match.matchId, matchMeta);
            const sourceHomeStats = isMalformedTeamPayload(payload.home ?? {}) ? null : buildTeamStats(payload.home ?? {});
            const sourceAwayStats = isMalformedTeamPayload(payload.away ?? {}) ? null : buildTeamStats(payload.away ?? {});
            const homeStats = isFlipped ? sourceAwayStats : sourceHomeStats;
            const awayStats = isFlipped ? sourceHomeStats : sourceAwayStats;

            if (homeStats && awayStats) {
              homeStats.opposition_kicks = Number(awayStats.kicks ?? 0);
              awayStats.opposition_kicks = Number(homeStats.kicks ?? 0);
              homeStats.opposition_tackles_made = Number(awayStats.tackles_made ?? 0);
              awayStats.opposition_tackles_made = Number(homeStats.tackles_made ?? 0);
              addHalfScoreStats(homeStats, awayStats, match.homeScore, match.awayScore);
              addHalfScoreStats(awayStats, homeStats, match.awayScore, match.homeScore);

              if (homeStats.kick_defusal !== null && homeStats.opposition_kicks > 0) {
                homeStats.kick_defusal_weighted_numerator = Number(homeStats.kick_defusal) * Number(homeStats.opposition_kicks) / 100;
              }
              if (awayStats.kick_defusal !== null && awayStats.opposition_kicks > 0) {
                awayStats.kick_defusal_weighted_numerator = Number(awayStats.kick_defusal) * Number(awayStats.opposition_kicks) / 100;
              }
              if (homeStats.average_play_the_ball_speed !== null && homeStats.opposition_tackles_made > 0) {
                homeStats.average_play_the_ball_speed_weighted_numerator = Number(homeStats.average_play_the_ball_speed) * Number(homeStats.opposition_tackles_made);
              }
              if (awayStats.average_play_the_ball_speed !== null && awayStats.opposition_tackles_made > 0) {
                awayStats.average_play_the_ball_speed_weighted_numerator = Number(awayStats.average_play_the_ball_speed) * Number(awayStats.opposition_tackles_made);
              }
            }

            for (const [isHome, teamName, opponentName, teamScore, opponentScore, teamStats] of [
              [1, match.homeTeam, match.awayTeam, match.homeScore, match.awayScore, homeStats],
              [0, match.awayTeam, match.homeTeam, match.awayScore, match.homeScore, awayStats],
            ]) {
              if (!teamStats) continue;
              teamStats.ground_condition = matchMeta.ground_condition;
              teamStats.weather_condition = matchMeta.weather_condition;
              teamStats.referee = matchMeta.referee;
              pushTeamSummary({
                matchId: match.matchId,
                teamId: teamIdByName.get(teamName) ?? null,
                opponentTeamId: teamIdByName.get(opponentName) ?? null,
                season: Number(match.season),
                roundIndex: Number(match.roundIndex),
                isFinals: match.isFinals,
                matchDateUtc: match.matchDateUtc,
                isHome,
                teamScore,
                opponentScore,
                resultCode: teamScore > opponentScore ? "W" : teamScore < opponentScore ? "L" : "T",
                statsJson: JSON.stringify(teamStats),
              });
            }
            }
          }
        }
      }
    } catch {}
  }
}

const legacyReferenceTeamHints = buildLegacyReferenceTeamHints(legacyReferenceRows, teamAliasMap);
const resolvedLegacyRows = [];
const unresolvedLegacyRows = [];
const playerSeasonTeamHints = new Map();
const playerCareerTeamHints = new Map();

function addHint(targetMap, key, teamId) {
  if (!key || !teamId) return;
  if (!targetMap.has(key)) {
    targetMap.set(key, new Set());
  }
  targetMap.get(key).add(teamId);
}

for (const row of legacyRows) {
  const season = Number(row.year);
  if (!Number.isFinite(season)) continue;

  const matchId = resolveLegacyMatchId(row);
  if (!matchId) continue;
  const match = matchById.get(matchId);
  if (!match) continue;

  const alias = resolveSeasonalAlias(aflPlayerAliasMap, row.player, season, { teamName: row.team });
  const playerNameRaw = alias?.canonicalName ?? row.player;
  const playerLookupKey = normalizePlayerLookupKey(playerNameRaw);
  const resolvedTeam = resolveLegacyTeams(row, match, teamIdByName, teamAliasMap);

  if (resolvedTeam.teamId) {
    resolvedLegacyRows.push({
      row,
      match,
      matchId,
      season,
      playerId: alias?.playerId ?? null,
      playerNameRaw,
      playerLookupKey,
      teamId: resolvedTeam.teamId,
      opponentTeamId: resolvedTeam.opponentTeamId,
      isHome: resolvedTeam.isHome,
    });
    addHint(playerSeasonTeamHints, `${playerLookupKey}|${season}`, resolvedTeam.teamId);
    addHint(playerCareerTeamHints, playerLookupKey, resolvedTeam.teamId);
  } else {
    unresolvedLegacyRows.push({
      row,
      match,
      matchId,
      season,
      playerId: alias?.playerId ?? null,
      playerNameRaw,
      playerLookupKey,
    });
  }
}

const stillUnresolvedLegacyRows = [];

for (const item of unresolvedLegacyRows) {
  const seasonHint = playerSeasonTeamHints.get(`${item.playerLookupKey}|${item.season}`) ?? null;
  const careerHint = playerCareerTeamHints.get(item.playerLookupKey) ?? null;
  const referenceHintNames = legacyReferenceTeamHints.get(item.playerLookupKey) ?? null;
  const homeTeamId = teamIdByName.get(item.match.homeTeam) ?? null;
  const awayTeamId = teamIdByName.get(item.match.awayTeam) ?? null;

  let inferredTeamId = null;
  let inferredSource = null;

  if (seasonHint?.size === 1) {
    inferredTeamId = [...seasonHint][0];
    inferredSource = "season";
  } else if (careerHint?.size === 1) {
    inferredTeamId = [...careerHint][0];
    inferredSource = "career";
  } else if (referenceHintNames?.size === 1) {
    const canonicalName = [...referenceHintNames][0];
    inferredTeamId = teamIdByName.get(canonicalName) ?? null;
    inferredSource = inferredTeamId ? "reference" : null;
  }

  if (inferredTeamId !== homeTeamId && inferredTeamId !== awayTeamId) {
    inferredTeamId = null;
    inferredSource = null;
  }

  if (!inferredTeamId) {
    stillUnresolvedLegacyRows.push(item);
    continue;
  }

  const opponentTeamId =
    inferredTeamId === homeTeamId ? awayTeamId
      : inferredTeamId === awayTeamId ? homeTeamId
      : null;
  const isHome =
    inferredTeamId === homeTeamId ? 1
      : inferredTeamId === awayTeamId ? 0
      : null;

  resolvedLegacyRows.push({
    ...item,
    teamId: inferredTeamId,
    opponentTeamId,
    isHome,
  });

  if (inferredSource === "season") legacyRowsInferredBySeason += 1;
  if (inferredSource === "career") legacyRowsInferredByCareer += 1;
  if (inferredSource === "reference") legacyRowsInferredByReference += 1;
}

const scoreBalancedLegacyInference = inferLegacyRowsByScoreBalance(
  stillUnresolvedLegacyRows,
  resolvedLegacyRows,
  teamIdByName,
  playerSeasonTeamHints,
  playerCareerTeamHints,
  legacyReferenceTeamHints
);

for (const item of scoreBalancedLegacyInference.inferredRows) {
  resolvedLegacyRows.push(item);
  legacyRowsInferredByScoreBalance += 1;
}

legacyRowsSkippedMissingTeam += scoreBalancedLegacyInference.stillUnresolved.length;

for (const item of resolvedLegacyRows) {
  upsertPlayerSummary({
    matchId: item.matchId,
    playerId: item.playerId,
    playerNameRaw: item.playerNameRaw,
    teamId: item.teamId,
    opponentTeamId: item.opponentTeamId,
    season: item.season,
    roundIndex: Number(item.match.roundIndex),
    isFinals: item.match.isFinals,
    matchDateUtc: item.match.matchDateUtc,
    isHome: item.isHome,
    jumperNumber: null,
    positionLabel: null,
    stats: {
      games_played: 1,
      tries: Number(item.row.tries) || 0,
      points: deriveHistoricalPoints(item.row),
      goals: Number(item.row.goals) || 0,
      conversions: null,
      conversion_attempts: null,
      penalty_goals: null,
      field_goals_1pt: Number(item.row.fg1) || 0,
      field_goals_2pt: Number(item.row.fg2) || 0,
    },
  }, { scoringOverride: true });
  legacyRowsInserted += 1;
}

for (const match of bundle.matches) {
  const matchMeta = matchMetaById.get(match.matchId) ?? {
    ground_condition: null,
    weather_condition: null,
    referee: null,
  };

  for (const [isHome, teamName, opponentName, teamScore, opponentScore] of [
    [1, match.homeTeam, match.awayTeam, match.homeScore, match.awayScore],
    [0, match.awayTeam, match.homeTeam, match.awayScore, match.homeScore],
  ]) {
    pushTeamSummary({
      matchId: match.matchId,
      teamId: teamIdByName.get(teamName) ?? null,
      opponentTeamId: teamIdByName.get(opponentName) ?? null,
      season: Number(match.season),
      roundIndex: Number(match.roundIndex),
      isFinals: match.isFinals,
      matchDateUtc: match.matchDateUtc,
      isHome,
      teamScore,
      opponentScore,
      resultCode: teamScore > opponentScore ? "W" : teamScore < opponentScore ? "L" : "T",
      statsJson: JSON.stringify({
        ground_condition: matchMeta.ground_condition,
        weather_condition: matchMeta.weather_condition,
        referee: matchMeta.referee,
      }),
    });
  }
}

for (const row of playerSummaryMap.values()) {
  const matchMeta = matchMetaById.get(row.matchId);
  if (!matchMeta) continue;
  row.stats.ground_condition = matchMeta.ground_condition;
  row.stats.weather_condition = matchMeta.weather_condition;
  row.stats.referee = matchMeta.referee;
}

const teamScoringEnrichment = enrichTeamSummariesFromPlayerScoring(
  teamSummaries,
  [...playerSummaryMap.values()]
);

const careerBounds = new Map();
const teamSpellBounds = new Map();

for (const row of playerSummaryMap.values()) {
  if (Number(row.season ?? 0) < 1998) continue;
  const playerKey = playerIdentityKey(row);
  const existingCareer = careerBounds.get(playerKey);
  if (!existingCareer) {
    careerBounds.set(playerKey, { first: row, last: row });
  } else {
    if (comparePlayerSummaryOrder(row, existingCareer.first) < 0) {
      existingCareer.first = row;
    }
    if (comparePlayerSummaryOrder(row, existingCareer.last) > 0) {
      existingCareer.last = row;
    }
  }

  if (row.teamId !== null && row.teamId !== undefined) {
    const teamKey = `${playerKey}|${row.teamId}`;
    const existingTeamSpell = teamSpellBounds.get(teamKey);
    if (!existingTeamSpell) {
      teamSpellBounds.set(teamKey, { first: row, last: row });
    } else {
      if (comparePlayerSummaryOrder(row, existingTeamSpell.first) < 0) {
        existingTeamSpell.first = row;
      }
      if (comparePlayerSummaryOrder(row, existingTeamSpell.last) > 0) {
        existingTeamSpell.last = row;
      }
    }
  }
}

for (const row of playerSummaryMap.values()) {
  const playerKey = playerIdentityKey(row);
  const career = careerBounds.get(playerKey);
  if (career) {
    row.stats.career_first_match_id = career.first.matchId;
    row.stats.career_last_match_id = career.last.matchId;
  }
  if (row.teamId !== null && row.teamId !== undefined) {
    const teamSpell = teamSpellBounds.get(`${playerKey}|${row.teamId}`);
    if (teamSpell) {
      row.stats.team_first_match_id = teamSpell.first.matchId;
      row.stats.team_last_match_id = teamSpell.last.matchId;
    }
  }
}

const statements = [];
statements.push("-- Generated by scripts/build-match-summary-seed-sql.mjs");
statements.push("BEGIN TRANSACTION;");
statements.push("DELETE FROM player_match_summary;");
statements.push("DELETE FROM team_match_summary;");

let playerSummaryId = 1;
for (const row of playerSummaryMap.values()) {
  const statsJson = JSON.stringify(row.stats);
  statements.push(
    `INSERT INTO player_match_summary (player_match_summary_id, match_id, player_id, player_name_raw, team_id, opponent_team_id, season, round_index, is_finals, match_date_utc, is_home, jumper_number, position_label, stats_json) VALUES (${playerSummaryId}, ${sqlNumber(
      row.matchId
    )}, ${sqlNumber(row.playerId)}, ${sqlString(row.playerNameRaw)}, ${sqlNumber(row.teamId)}, ${sqlNumber(
      row.opponentTeamId
    )}, ${sqlNumber(row.season)}, ${sqlNumber(row.roundIndex)}, ${sqlNumber(row.isFinals)}, ${sqlString(
      row.matchDateUtc
    )}, ${sqlNumber(row.isHome)}, ${sqlNumber(row.jumperNumber)}, ${sqlString(row.positionLabel)}, ${sqlString(
      statsJson
    )});`
  );
  playerSummaryId += 1;
}

let teamSummaryId = 1;
for (const row of teamSummaries) {
  statements.push(
    `INSERT INTO team_match_summary (team_match_summary_id, match_id, team_id, opponent_team_id, season, round_index, is_finals, match_date_utc, is_home, team_score, opponent_score, result_code, stats_json) VALUES (${teamSummaryId}, ${sqlNumber(
      row.matchId
    )}, ${sqlNumber(row.teamId)}, ${sqlNumber(row.opponentTeamId)}, ${sqlNumber(row.season)}, ${sqlNumber(
      row.roundIndex
    )}, ${sqlNumber(row.isFinals)}, ${sqlString(row.matchDateUtc)}, ${sqlNumber(row.isHome)}, ${sqlNumber(
      row.teamScore
    )}, ${sqlNumber(row.opponentScore)}, ${sqlString(row.resultCode)}, ${sqlString(row.statsJson)});`
  );
  teamSummaryId += 1;
}

statements.push("COMMIT;");

const teamSeasonAggregates = buildTeamSeasonAggregates(teamSummaries, matchById, bundle);
const teamSeasonAggregateStatements = [];
teamSeasonAggregateStatements.push("-- Generated by scripts/build-match-summary-seed-sql.mjs");
teamSeasonAggregateStatements.push("BEGIN TRANSACTION;");
teamSeasonAggregateStatements.push("DELETE FROM team_season_aggregates;");

let teamSeasonAggregateId = 1;
for (const row of teamSeasonAggregates) {
  teamSeasonAggregateStatements.push(
    `INSERT INTO team_season_aggregates (team_season_aggregate_id, team_id, team_name_raw, source, season, season_phase, stat_key, total_value, recorded_games, total_games, first_season, last_season) VALUES (${teamSeasonAggregateId}, ${sqlNumber(
      row.teamId
    )}, ${sqlString(row.teamNameRaw)}, ${sqlString(row.source)}, ${sqlNumber(row.season)}, ${sqlString(
      row.seasonPhase
    )}, ${sqlString(row.statKey)}, ${sqlNumber(row.totalValue)}, ${sqlNumber(row.recordedGames)}, ${sqlNumber(
      row.totalGames
    )}, ${sqlNumber(row.firstSeason)}, ${sqlNumber(row.lastSeason)});`
  );
  teamSeasonAggregateId += 1;
}

teamSeasonAggregateStatements.push("COMMIT;");

await fs.writeFile(sqlOutputPath, `${statements.join("\n")}\n`, "utf8");
await fs.writeFile(teamSeasonAggregateOutputPath, `${teamSeasonAggregateStatements.join("\n")}\n`, "utf8");

console.log("Match summary seed SQL:", sqlOutputPath);
console.log("Team season aggregate seed SQL:", teamSeasonAggregateOutputPath);
console.log("Player rows:", playerSummaryMap.size);
console.log("Team rows:", teamSummaries.length);
console.log("Team season aggregate rows:", teamSeasonAggregates.length);
console.log("Team scorer rollups applied:", teamScoringEnrichment.enrichedCount);
console.log("Team scorer rollups skipped due to score mismatch:", teamScoringEnrichment.skippedMismatchCount);
console.log("Legacy scoring rows inserted into player summaries:", legacyRowsInserted);
console.log("Legacy scoring rows inferred by same-season team:", legacyRowsInferredBySeason);
console.log("Legacy scoring rows inferred by career-unique team:", legacyRowsInferredByCareer);
console.log("Legacy scoring rows inferred by reference-unique team:", legacyRowsInferredByReference);
console.log("Legacy scoring rows inferred by score-balance:", legacyRowsInferredByScoreBalance);
console.log("Legacy scoring rows skipped for missing team resolution:", legacyRowsSkippedMissingTeam);
console.log("Unresolved player matches:", unresolvedPlayerMatches.length);
if (unresolvedPlayerMatches.length > 0) {
  console.log("Sample unresolved player matches:", JSON.stringify(unresolvedPlayerMatches.slice(0, 10), null, 2));
}
console.log("Unresolved detailed matches:", unresolvedDetailedMatches.length);
if (unresolvedDetailedMatches.length > 0) {
  console.log("Sample unresolved detailed matches:", JSON.stringify(unresolvedDetailedMatches.slice(0, 10), null, 2));
}
