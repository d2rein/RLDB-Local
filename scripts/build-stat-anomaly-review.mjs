import fs from "node:fs/promises";
import path from "node:path";
import { flattenDetailedMatchFile, flattenPlayerStatsFile } from "./lib/nrl-json.mjs";
import { NRL_DATA_ROOT } from "./lib/paths.mjs";
import { STAT_DEFINITIONS } from "../src/server/config/stat-definitions.mjs";

const PROJECT_ROOT = "C:\\Users\\d2rei\\Rugby-League-Stats-Database";
const DOCS_DIR = path.join(PROJECT_ROOT, "docs");

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

const definitionsByScopeAndKey = new Map(
  STAT_DEFINITIONS.filter((stat) => !stat.isDerived).map((stat) => [`${stat.scope}|${stat.statKey}`, stat])
);

function numericSort(a, b) {
  return Number(a) - Number(b);
}

function normalizeStatKey(rawKey, scope) {
  const slug = String(rawKey ?? "")
    .trim()
    .toLowerCase()
    .replace(/[%/]/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const aliasMap = scope === "team" ? TEAM_STAT_ALIASES : PLAYER_STAT_ALIASES;
  return aliasMap.get(slug) ?? slug;
}

function parsePlayerStatValue(rawValue) {
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
  if (rawValue === null || rawValue === undefined || rawValue === "" || rawValue === "-" || rawValue === "None" || rawValue === -1) {
    return null;
  }

  const text = String(rawValue).trim();
  if (statKey === "time_in_possession") {
    const compact = text.replace(/,/g, "");
    if (/^\d{3,4}$/.test(compact)) {
      return Number(compact) / 60;
    }
    return parsePlayerStatValue(rawValue);
  }

  if (statKey === "average_play_the_ball_speed") {
    if (/^\d+(\.\d+)?%$/.test(text)) {
      return null;
    }
    if (/^\d+(\.\d+)?s$/.test(text)) {
      return Number(text.slice(0, -1));
    }
    return null;
  }

  return parsePlayerStatValue(rawValue);
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

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function writeCsv(rows, headers) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * ratio)));
  return sortedValues[index];
}

function median(sortedValues) {
  if (sortedValues.length === 0) return null;
  const mid = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[mid];
  return (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function hardRuleReason(scope, statKey, value) {
  if (value === null || value === undefined) return null;

  if (["completion_rate", "kick_defusal", "goal_conversion_rate", "effective_tackle", "tackle_efficiency"].includes(statKey)) {
    if (value < 0 || value > 100) return "percentage_out_of_range";
  }

  if (scope === "team" && statKey === "time_in_possession") {
    if (value < 5 || value > 50) return "time_in_possession_out_of_range";
  }

  if (statKey === "average_play_the_ball_speed") {
    if (value < 1 || value > 10) return "average_play_the_ball_speed_out_of_range";
  }

  if (scope === "team" && statKey === "average_set_distance") {
    if (value < 10 || value > 80) return "average_set_distance_out_of_range";
  }

  if (statKey === "passes_to_run_ratio") {
    if (value < 0 || value > 10) return "passes_to_run_ratio_out_of_range";
  }

  if (["tries", "conversions", "conversion_attempts", "penalty_goals", "field_goals_1pt", "field_goals_2pt"].includes(statKey) && value > 25) {
    return "scoring_count_implausibly_high";
  }

  return null;
}

function buildReviewRow(base, anomalyType, expectedRange, notes = "") {
  return {
    scope: base.scope,
    season: base.season,
    stat_key: base.statKey,
    stat_name: base.displayName,
    anomaly_type: anomalyType,
    match_label: base.matchLabel,
    round_label: base.roundLabel,
    entity_label: base.entityLabel,
    raw_value: base.rawValue,
    parsed_value: base.parsedValue,
    expected_range: expectedRange,
    notes,
  };
}

await fs.mkdir(DOCS_DIR, { recursive: true });

const yearDirectories = (await fs.readdir(NRL_DATA_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
  .map((entry) => entry.name)
  .sort(numericSort);

const rowReviews = [];
const seenReviewKeys = new Set();
const seasonGroups = new Map();

function addReviewRow(row) {
  const key = [
    row.scope,
    row.season,
    row.stat_key,
    row.anomaly_type,
    row.match_label,
    row.round_label,
    row.entity_label,
    row.raw_value,
  ].join("|");
  if (seenReviewKeys.has(key)) return;
  seenReviewKeys.add(key);
  rowReviews.push(row);
}

function recordValue(base) {
  const groupKey = `${base.scope}|${base.statKey}|${base.season}`;
  if (!seasonGroups.has(groupKey)) {
    seasonGroups.set(groupKey, {
      scope: base.scope,
      season: base.season,
      statKey: base.statKey,
      displayName: base.displayName,
      values: [],
      rows: [],
    });
  }
  const group = seasonGroups.get(groupKey);
  group.values.push(Number(base.parsedValue));
  group.rows.push(base);
}

for (const year of yearDirectories) {
  const detailedPath = path.join(NRL_DATA_ROOT, year, `NRL_detailed_match_data_${year}.json`);
  const playerPath = path.join(NRL_DATA_ROOT, year, `NRL_player_statistics_${year}.json`);

  try {
    await fs.access(detailedPath);
    const detailedJson = JSON.parse(await fs.readFile(detailedPath, "utf8"));
    for (const roundBlock of detailedJson.NRL ?? []) {
      for (const [roundLabel, matches] of Object.entries(roundBlock)) {
        for (const wrapper of matches) {
          for (const [matchLabel, payload] of Object.entries(wrapper)) {
            for (const side of ["home", "away"]) {
              const teamPayload = payload[side] ?? {};
              if (isMalformedTeamPayload(teamPayload)) continue;

              for (const [rawKey, rawValue] of Object.entries(teamPayload)) {
                const statKey = normalizeStatKey(rawKey, "team");
                const definition = definitionsByScopeAndKey.get(`team|${statKey}`);
                const season = Number(year);
                if (!definition || season < Number(definition.firstConsistentSeason ?? 9999)) continue;

                const parsedValue = parseTeamStatValue(statKey, rawValue);
                if (parsedValue === null || parsedValue === undefined || Number.isNaN(parsedValue)) continue;

                const base = {
                  scope: "team",
                  season,
                  statKey,
                  displayName: definition.displayName,
                  matchLabel,
                  roundLabel,
                  entityLabel: side,
                  rawValue,
                  parsedValue,
                };

                recordValue(base);

                const reason = hardRuleReason("team", statKey, parsedValue);
                if (reason) {
                  addReviewRow(buildReviewRow(base, reason, "stat-specific sanity range"));
                }
              }
            }
          }
        }
      }
    }
  } catch {}

  try {
    await fs.access(playerPath);
    const playerRows = await flattenPlayerStatsFile(playerPath);
    for (const row of playerRows) {
      const statKey = normalizeStatKey(row.stat_key_raw, "player");
      const definition = definitionsByScopeAndKey.get(`player|${statKey}`);
      const season = Number(row.season);
      if (!definition || season < Number(definition.firstConsistentSeason ?? 9999)) continue;

      const parsedValue = parsePlayerStatValue(row.stat_value_text);
      if (parsedValue === null || parsedValue === undefined || Number.isNaN(parsedValue)) continue;

      const base = {
        scope: "player",
        season,
        statKey,
        displayName: definition.displayName,
        matchLabel: row.source_match_key,
        roundLabel: row.round_label,
        entityLabel: row.player_name,
        rawValue: row.stat_value_text,
        parsedValue,
      };

      recordValue(base);

      const reason = hardRuleReason("player", statKey, parsedValue);
      if (reason) {
        addReviewRow(buildReviewRow(base, reason, "stat-specific sanity range"));
      }
    }
  } catch {}
}

const seasonSummaryRows = [];

for (const group of seasonGroups.values()) {
  const sortedValues = [...group.values].sort((a, b) => a - b);
  const p10 = percentile(sortedValues, 0.1);
  const p50 = median(sortedValues);
  const p90 = percentile(sortedValues, 0.9);
  const minValue = sortedValues[0];
  const maxValue = sortedValues[sortedValues.length - 1];

  seasonSummaryRows.push({
    scope: group.scope,
    season: group.season,
    stat_key: group.statKey,
    stat_name: group.displayName,
    row_count: sortedValues.length,
    min_value: minValue,
    p10_value: p10,
    median_value: p50,
    p90_value: p90,
    max_value: maxValue,
    max_vs_median_ratio: p50 && p50 !== 0 ? (maxValue / p50).toFixed(3) : "",
  });

  if (sortedValues.length < 20 || !p50 || p50 <= 0) {
    continue;
  }

  for (const row of group.rows) {
    const value = Number(row.parsedValue);
    if (group.scope === "team" && p50 >= 10 && value >= p50 * 5) {
      addReviewRow(
        buildReviewRow(
          row,
          "order_of_magnitude_high",
          `season median ~ ${p50}`,
          `Value is ${(value / p50).toFixed(2)}x the season median`
        )
      );
    }
  }
}

rowReviews.sort((a, b) => {
  if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
  if (Number(a.season) !== Number(b.season)) return Number(a.season) - Number(b.season);
  if (a.stat_key !== b.stat_key) return a.stat_key.localeCompare(b.stat_key);
  if (a.match_label !== b.match_label) return a.match_label.localeCompare(b.match_label);
  return a.entity_label.localeCompare(b.entity_label);
});

seasonSummaryRows.sort((a, b) => {
  if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
  if (Number(a.season) !== Number(b.season)) return Number(a.season) - Number(b.season);
  return a.stat_key.localeCompare(b.stat_key);
});

const reviewPath = path.join(DOCS_DIR, "stat_anomalies_review.csv");
const summaryPath = path.join(DOCS_DIR, "stat_anomaly_season_summary.csv");

await fs.writeFile(
  reviewPath,
  writeCsv(rowReviews, [
    "scope",
    "season",
    "stat_key",
    "stat_name",
    "anomaly_type",
    "match_label",
    "round_label",
    "entity_label",
    "raw_value",
    "parsed_value",
    "expected_range",
    "notes",
  ]),
  "utf8"
);

await fs.writeFile(
  summaryPath,
  writeCsv(seasonSummaryRows, [
    "scope",
    "season",
    "stat_key",
    "stat_name",
    "row_count",
    "min_value",
    "p10_value",
    "median_value",
    "p90_value",
    "max_value",
    "max_vs_median_ratio",
  ]),
  "utf8"
);

console.log("Stat anomaly review:", reviewPath);
console.log("Season anomaly summary:", summaryPath);
console.log("Review rows:", rowReviews.length);
console.log("Season summaries:", seasonSummaryRows.length);
