import fs from "node:fs/promises";
import path from "node:path";
import { DOCS_DIR } from "./lib/project-paths.mjs";

const REP_DIR = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data", "REP");
const PAYLOAD_PATH = path.join(REP_DIR, "rep_match_payloads.json");
const OUTPUT_ROOT = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data");

const PLAYER_STAT_KEY_MAP = {
  "Mins Played": "minutesPlayed",
  "Points": "points",
  "Tries": "tries",
  "Conversions": "conversions",
  "Conversion Attempts": "conversionAttempts",
  "Penalty Goals": "penaltyGoals",
  "Goal Conversion Rate": "goalConversionRate",
  "1 Point Field Goals": "onePointFieldGoals",
  "2 Point Field Goals": "twoPointFieldGoals",
  "Total Points": "fantasyPointsTotal",
  "All Runs": "allRuns",
  "All Run Metres": "allRunMetres",
  "Kick Return Metres": "kickReturnMetres",
  "Post Contact Metres": "postContactMetres",
  "Line Breaks": "lineBreaks",
  "Line Break Assists": "lineBreakAssists",
  "Try Assists": "tryAssists",
  "Line Engaged Runs": "lineEngagedRuns",
  "Tackle Breaks": "tackleBreaks",
  "Hit Ups": "hitUps",
  "Play The Ball": "playTheBallTotal",
  "Average Play The Ball Speed": "playTheBallAverageSpeed",
  "Dummy Half Runs": "dummyHalfRuns",
  "Dummy Half Run Metres": "dummyHalfRunMetres",
  "One on One Steal": "oneOnOneSteal",
  "Offloads": "offloads",
  "Dummy Passes": "dummyPasses",
  "Passes": "passes",
  "Receipts": "receipts",
  "Passes To Run Ratio": "passesToRunRatio",
  "Tackle Efficiency": "tackleEfficiency",
  "Tackles Made": "tacklesMade",
  "Missed Tackles": "missedTackles",
  "Ineffective Tackles": "ineffectiveTackles",
  "Intercepts": "intercepts",
  "Kicks Defused": "kicksDefused",
  "Kicks": "kicks",
  "Kicking Metres": "kickMetres",
  "Forced Drop Outs": "forcedDropOutKicks",
  "Bomb Kicks": "bombKicks",
  "Grubbers": "grubberKicks",
  "40/20": "fortyTwentyKicks",
  "20/40": "twentyFortyKicks",
  "Cross Field Kicks": "crossFieldKicks",
  "Kicked Dead": "kicksDead",
  "Errors": "errors",
  "Handling Errors": "handlingErrors",
  "One on One Lost": "oneOnOneLost",
  "Penalties": "penalties",
  "Ruck Infringements": "ruckInfringements",
  "Inside 10 Metres": "offsideWithinTenMetres",
  "On Report": "onReport",
  "Sin Bins": "sinBins",
  "Send Offs": "sendOffs",
  "Stint One": "stintOne",
  "Stint Two": "stintTwo",
};

const BARS_DATA = {
  time_in_possession: -1, all_runs: -1, all_run_metres: -1, post_contact_metres: -1,
  line_breaks: -1, tackle_breaks: -1, average_set_distance: -1, kick_return_metres: -1,
  offloads: -1, receipts: -1, total_passes: -1, dummy_passes: -1, kicks: -1, kicking_metres: -1,
  forced_drop_outs: -1, bombs: -1, grubbers: -1, tackles_made: -1, missed_tackles: -1,
  intercepts: -1, ineffective_tackles: -1, errors: -1, penalties_conceded: -1, ruck_infringements: -1,
  inside_10_metres: -1, interchanges_used: -1,
};

const DONUT_DATA = {
  Completion_Rate: -1,
  Average_Play_Ball_Speed: -1,
  Kick_Defusal: -1,
  Effective_Tackle: -1,
};

const DONUT_DATA_2 = {
  tries: -1,
  conversions: -1,
  penalty_goals: -1,
  sin_bins: -1,
  send_offs: -1,
  "1_point_field_goals": -1,
  "2_point_field_goals": -1,
  half_time: -1,
};

const TEAM_STATS_TITLE_MAP = {
  "Time In Possession": "time_in_possession",
  "Completion Rate": "Completion_Rate",
  "All Runs": "all_runs",
  "All Run Metres": "all_run_metres",
  "Post Contact Metres": "post_contact_metres",
  "Line Breaks": "line_breaks",
  "Tackle Breaks": "tackle_breaks",
  "Average Set Distance": "average_set_distance",
  "Kick Return Metres": "kick_return_metres",
  "Average Play The Ball Speed": "Average_Play_Ball_Speed",
  "Offloads": "offloads",
  "Receipts": "receipts",
  "Total Passes": "total_passes",
  "Dummy Passes": "dummy_passes",
  "Kicks": "kicks",
  "Kicking Metres": "kicking_metres",
  "Forced Drop Outs": "forced_drop_outs",
  "Kick Defusal %": "Kick_Defusal",
  Bombs: "bombs",
  Grubbers: "grubbers",
  "Effective Tackle %": "Effective_Tackle",
  "Tackles Made": "tackles_made",
  "Missed Tackles": "missed_tackles",
  Intercepts: "intercepts",
  "Ineffective Tackles": "ineffective_tackles",
  Errors: "errors",
  "Penalties Conceded": "penalties_conceded",
  "Ruck Infringements": "ruck_infringements",
  "Inside 10 Metres": "inside_10_metres",
  "Sin Bins": "sin_bins",
  "Send Offs": "send_offs",
  Used: "interchanges_used",
};

function normalizeText(value) {
  return String(value ?? "").trim();
}

function isCompletedMatch(matchPayload) {
  const mode = normalizeText(matchPayload?.matchMode).toLowerCase();
  const state = normalizeText(matchPayload?.matchState).toLowerCase();
  if (mode === "pre") return false;
  if (state === "upcoming") return false;
  return true;
}

function roundLabelFromFixture(fixture) {
  return normalizeText(fixture.roundLabel || `${fixture.roundKind} ${fixture.gameNumber}`);
}

function ensureSeasonContainer(store, competitionCode, season) {
  if (!store.has(competitionCode)) store.set(competitionCode, new Map());
  const bySeason = store.get(competitionCode);
  if (!bySeason.has(season)) {
    bySeason.set(season, {
      matchRounds: new Map(),
      detailedRounds: new Map(),
      playerRounds: new Map(),
    });
  }
  return bySeason.get(season);
}

function formatPlayerStatValue(value) {
  if (value === null || value === undefined) return "na";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2).replace(/\.?0+$/, "");
  }
  const text = normalizeText(value);
  return text || "na";
}

function formatPercentage(value) {
  if (value === null || value === undefined || value === -1) return -1;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return -1;
  return Number.isInteger(numeric) ? `${numeric}%` : `${numeric.toFixed(2).replace(/\.?0+$/, "")}%`;
}

function formatSecondsAsMmss(value) {
  if (value === null || value === undefined || value === -1) return -1;
  const totalSeconds = Math.round(Number(value));
  if (!Number.isFinite(totalSeconds)) return -1;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatNumberish(value) {
  if (value === null || value === undefined || value === -1) return -1;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return -1;
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2).replace(/\.?0+$/, "");
}

function extractSideValue(stat, side) {
  const sideKey = side === "home" ? "homeValue" : "awayValue";
  const sideValue = stat?.[sideKey];
  if (!sideValue || sideValue.value === null || sideValue.value === undefined) {
    return -1;
  }

  const value = sideValue.value;
  const statType = stat.type;
  const units = stat.units;

  if (stat.title === "Completion Rate") {
    return formatPercentage(value);
  }
  if (units === "Minutes" && stat.title === "Time In Possession") {
    return formatSecondsAsMmss(value);
  }
  if (units === "Seconds") {
    const text = `${Number(value).toFixed(2).replace(/\.?0+$/, "")}s`;
    return text;
  }
  if (["Percentage", "PercentageCombined", "PercentageAndFraction"].includes(statType)) {
    return formatPercentage(value);
  }
  return formatNumberish(value);
}

function buildTeamStatsFromPayload(matchPayload) {
  const homeBars = { ...BARS_DATA };
  const awayBars = { ...BARS_DATA };
  const homeDonut = { ...DONUT_DATA };
  const awayDonut = { ...DONUT_DATA };
  const homeGameStats = { ...DONUT_DATA_2 };
  const awayGameStats = { ...DONUT_DATA_2 };

  for (const group of matchPayload?.stats?.groups ?? []) {
    for (const stat of group?.stats ?? []) {
      const mappedKey = TEAM_STATS_TITLE_MAP[stat?.title];
      if (!mappedKey) continue;
      const homeValue = extractSideValue(stat, "home");
      const awayValue = extractSideValue(stat, "away");

      if (mappedKey in homeBars) {
        homeBars[mappedKey] = homeValue;
        awayBars[mappedKey] = awayValue;
      } else if (mappedKey in homeDonut) {
        homeDonut[mappedKey] = homeValue;
        awayDonut[mappedKey] = awayValue;
      } else if (mappedKey in homeGameStats) {
        homeGameStats[mappedKey] = homeValue;
        awayGameStats[mappedKey] = awayValue;
      }
    }
  }

  for (const [teamKey, target] of [["homeTeam", homeGameStats], ["awayTeam", awayGameStats]]) {
    const scoring = matchPayload?.[teamKey]?.scoring ?? {};
    const directMap = {
      tries: "tries",
      conversions: "conversions",
      penaltyGoals: "penalty_goals",
      sinBins: "sin_bins",
      sendOffs: "send_offs",
      onePointFieldGoals: "1_point_field_goals",
      twoPointFieldGoals: "2_point_field_goals",
      halfTimeScore: "half_time",
    };
    for (const [inputKey, outputKey] of Object.entries(directMap)) {
      const payload = scoring[inputKey];
      if (payload === null || payload === undefined) continue;
      if (typeof payload === "object" && payload !== null) {
        const made = payload.made;
        const attempts = payload.attempts;
        if (attempts !== null && attempts !== undefined && attempts > 0) {
          target[outputKey] = made === null || made === undefined ? -1 : `${made}/${attempts}`;
        } else if (made !== null && made !== undefined) {
          target[outputKey] = String(made);
        }
      } else {
        target[outputKey] = String(payload);
      }
    }
  }

  return {
    home: { ...homeBars, ...homeDonut, ...homeGameStats },
    away: { ...awayBars, ...awayDonut, ...awayGameStats },
  };
}

function summaryMinute(text) {
  const match = String(text ?? "").match(/(\d+)'/);
  return match ? Number(match[1]) : null;
}

function determineFirstTry(matchPayload, homeLabel, awayLabel) {
  const homeTries = matchPayload?.homeTeam?.scoring?.tries?.summaries ?? [];
  const awayTries = matchPayload?.awayTeam?.scoring?.tries?.summaries ?? [];
  const homeFirst = homeTries[0] ?? null;
  const awayFirst = awayTries[0] ?? null;
  if (!homeFirst && !awayFirst) {
    return { scorer: null, minute: null, team: null };
  }
  if (homeFirst && !awayFirst) {
    const [name, minute] = splitLast(String(homeFirst));
    return { scorer: name, minute, team: homeLabel };
  }
  if (awayFirst && !homeFirst) {
    const [name, minute] = splitLast(String(awayFirst));
    return { scorer: name, minute, team: awayLabel };
  }
  const homeMinute = summaryMinute(homeFirst);
  const awayMinute = summaryMinute(awayFirst);
  if (awayMinute === null || (homeMinute !== null && homeMinute <= awayMinute)) {
    const [name, minute] = splitLast(String(homeFirst));
    return { scorer: name, minute, team: homeLabel };
  }
  const [name, minute] = splitLast(String(awayFirst));
  return { scorer: name, minute, team: awayLabel };
}

function splitLast(text) {
  const index = text.lastIndexOf(" ");
  if (index === -1) return [text, ""];
  return [text.slice(0, index), text.slice(index + 1)];
}

function buildDetailedMatchEntry(fixture, matchPayload) {
  const homeLabel = normalizeText(fixture.homeTeam);
  const awayLabel = normalizeText(fixture.awayTeam);
  const teamStats = buildTeamStatsFromPayload(matchPayload);
  const firstTry = determineFirstTry(matchPayload, homeLabel, awayLabel);

  const officials = matchPayload?.officials ?? [];
  const refNames = [];
  const refPositions = [];
  for (const official of officials) {
    const fullName = normalizeText([official.firstName, official.lastName].filter(Boolean).join(" "));
    if (fullName) refNames.push(fullName);
    refPositions.push(normalizeText(official.position));
  }

  return {
    match: {
      overall_first_try_scorer: firstTry.scorer,
      overall_first_try_minute: firstTry.minute,
      overall_first_try_round: firstTry.team,
      ref_names: refNames,
      ref_positions: refPositions,
      main_ref: refNames[0] ?? "",
      ground_condition: normalizeText(matchPayload?.groundConditions?.surface ?? matchPayload?.groundConditions?.condition ?? ""),
      weather_condition: normalizeText(matchPayload?.weather?.description ?? matchPayload?.weather?.condition ?? ""),
    },
    home: teamStats.home,
    away: teamStats.away,
  };
}

function buildPlayerRows(fixture, matchPayload) {
  const result = [];
  const rosterBySide = {
    homeTeam: new Map((matchPayload?.homeTeam?.players ?? []).map((player) => [player.playerId, player])),
    awayTeam: new Map((matchPayload?.awayTeam?.players ?? []).map((player) => [player.playerId, player])),
  };

  for (const sideKey of ["homeTeam", "awayTeam"]) {
    for (const statRow of matchPayload?.stats?.players?.[sideKey] ?? []) {
      const rosterRow = rosterBySide[sideKey].get(statRow.playerId) ?? {};
      const fullName = normalizeText([rosterRow.firstName, rosterRow.lastName].filter(Boolean).join(" "));
      const row = {
        Name: fullName || "Unknown",
        Number: formatPlayerStatValue(rosterRow.number),
        Position: normalizeText(rosterRow.position) || "na",
      };

      for (const [label, key] of Object.entries(PLAYER_STAT_KEY_MAP)) {
        row[label] = formatPlayerStatValue(statRow[key]);
      }

      result.push(row);
    }
  }

  return result;
}

function buildMatchRecord(fixture, matchPayload) {
  const homeScore = Number(matchPayload?.homeTeam?.score ?? 0);
  const awayScore = Number(matchPayload?.awayTeam?.score ?? 0);
  return {
    Round: roundLabelFromFixture(fixture),
    Home: normalizeText(fixture.homeTeam),
    Home_Score: Number.isFinite(homeScore) ? homeScore : 0,
    Away: normalizeText(fixture.awayTeam),
    Away_Score: Number.isFinite(awayScore) ? awayScore : 0,
    Venue: normalizeText(fixture.venue),
    Date: normalizeText(fixture.kickoff),
    Match_Centre_URL: fixture.url,
  };
}

function playerMatchKey(competitionCode, fixture) {
  const home = normalizeText(fixture.homeTeam).replace(/\s+/g, "-");
  const away = normalizeText(fixture.awayTeam).replace(/\s+/g, "-");
  return `${fixture.season}-${fixture.gameNumber}-${home}-v-${away}`;
}

function toOrderedRoundArray(roundMap) {
  return [...roundMap.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([roundNumber, value]) => ({ [String(roundNumber)]: value }));
}

const raw = JSON.parse(await fs.readFile(PAYLOAD_PATH, "utf8"));
const payloads = raw.payloads ?? [];
const store = new Map();

for (const row of payloads) {
  const fixture = row.fixture;
  const matchPayload = row.payload?.match;
  if (!fixture || !matchPayload) continue;
  if (!isCompletedMatch(matchPayload)) continue;

  const seasonContainer = ensureSeasonContainer(store, fixture.competitionCode, fixture.season);
  const roundNumber = Number(fixture.gameNumber);
  if (!seasonContainer.matchRounds.has(roundNumber)) seasonContainer.matchRounds.set(roundNumber, []);
  seasonContainer.matchRounds.get(roundNumber).push(buildMatchRecord(fixture, matchPayload));

  const hasRichStats = (matchPayload?.stats?.groups?.length ?? 0) > 0;
  const hasPlayers = ((matchPayload?.stats?.players?.homeTeam?.length ?? 0) + (matchPayload?.stats?.players?.awayTeam?.length ?? 0)) > 0;

  if (hasRichStats) {
    if (!seasonContainer.detailedRounds.has(roundNumber)) seasonContainer.detailedRounds.set(roundNumber, []);
    const matchLabel = `${normalizeText(fixture.homeTeam)} v ${normalizeText(fixture.awayTeam)}`;
    seasonContainer.detailedRounds.get(roundNumber).push({
      [matchLabel]: buildDetailedMatchEntry(fixture, matchPayload),
    });
  }

  if (hasPlayers) {
    if (!seasonContainer.playerRounds.has(roundNumber)) seasonContainer.playerRounds.set(roundNumber, []);
    seasonContainer.playerRounds.get(roundNumber).push({
      [playerMatchKey(fixture.competitionCode, fixture)]: buildPlayerRows(fixture, matchPayload),
    });
  }
}

for (const [competitionCode, bySeason] of store.entries()) {
  for (const [season, seasonData] of bySeason.entries()) {
    const seasonDir = path.join(OUTPUT_ROOT, competitionCode, String(season));
    await fs.mkdir(seasonDir, { recursive: true });

    const matchPayload = {
      [competitionCode]: [
        {
          [String(season)]: toOrderedRoundArray(seasonData.matchRounds),
        },
      ],
    };
    await fs.writeFile(
      path.join(seasonDir, `${competitionCode}_data_${season}.json`),
      `${JSON.stringify(matchPayload, null, 4)}\n`,
      "utf8"
    );

    const detailPayload = {
      [competitionCode]: toOrderedRoundArray(seasonData.detailedRounds),
    };
    await fs.writeFile(
      path.join(seasonDir, `${competitionCode}_detailed_match_data_${season}.json`),
      `${JSON.stringify(detailPayload, null, 4)}\n`,
      "utf8"
    );

    const playerPayload = {
      PlayerStats: [
        {
          [String(season)]: toOrderedRoundArray(seasonData.playerRounds),
        },
      ],
    };
    await fs.writeFile(
      path.join(seasonDir, `${competitionCode}_player_statistics_${season}.json`),
      `${JSON.stringify(playerPayload, null, 4)}\n`,
      "utf8"
    );
  }
}

console.log(`Structured rep data written for ${store.size} competition(s).`);
