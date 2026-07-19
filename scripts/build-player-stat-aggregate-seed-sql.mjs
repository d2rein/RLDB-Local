import fs from "node:fs/promises";
import path from "node:path";
import { flattenPlayerStatsFile } from "./lib/nrl-json.mjs";
import { SEED_DIR } from "./lib/project-paths.mjs";
import { NRL_COM_DATASETS } from "./lib/paths.mjs";
import { loadLegacyScoringRows } from "./lib/legacy-supplements.mjs";
import { buildSeasonalAliasLookup, resolveSeasonalAlias } from "./lib/player-splits.mjs";
import { sqlNumber, sqlString } from "./lib/sql.mjs";
import { STAT_DEFINITIONS } from "../src/server/config/stat-definitions.mjs";

const bundlePath = path.join(SEED_DIR, "core_import_bundle.json");
const sqlOutputPath = path.join(SEED_DIR, "0004_player_stat_aggregates_seed.sql");

const supportedDefinitions = STAT_DEFINITIONS.filter((stat) => stat.scope === "player");
const definitionByKey = new Map(supportedDefinitions.map((stat) => [stat.statKey, stat]));

function buildPlayerMaps(bundle) {
  const playerIdByDisplayName = new Map(
    bundle.players.map((player, index) => [player.displayName, index + 1])
  );

  const nrlAliasToPlayer = buildSeasonalAliasLookup(bundle.playerAliases, ["nrl", "nrlw", "soo", "wsoo"]);
  for (const alias of bundle.playerAliases) {
    if (!["nrl", "nrlw", "soo", "wsoo"].includes(alias.source)) continue;
    const playerId = playerIdByDisplayName.get(alias.canonicalName);
    if (!playerId) continue;
    const entries = nrlAliasToPlayer.get(alias.sourceName) ?? [];
    const target = entries.find((entry) =>
      entry.canonicalName === alias.canonicalName
      && Number(entry.firstSeason) === Number(alias.firstSeason)
      && Number(entry.lastSeason) === Number(alias.lastSeason)
    );
    if (target) {
      target.playerId = playerId;
      target.canonicalName = alias.canonicalName;
    }
  }

  return { playerIdByDisplayName, nrlAliasToPlayer };
}

function numericSort(a, b) {
  return Number(a) - Number(b);
}

async function listDatasetYears(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(numericSort);
  } catch {
    return [];
  }
}

function makePlayerToken(playerId, canonicalName, rawName) {
  return playerId ? `id:${playerId}` : `raw:${canonicalName ?? rawName}`;
}

const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
const { nrlAliasToPlayer } = buildPlayerMaps(bundle);
const legacyRows = await loadLegacyScoringRows();
const matchById = new Map(bundle.matches.map((match) => [match.matchId, match]));
const matchIdByAflKey = new Map();
for (const match of bundle.matches) {
  const aflKey = match.sources?.afltables?.matchKey;
  if (aflKey) {
    matchIdByAflKey.set(aflKey, match.matchId);
  }
}

const appearanceCounts = new Map();
const seenAppearances = new Set();
const appearanceSamples = new Map();
const seasonStatTotals = new Map();
const seenRecordedMatches = new Set();

for (const dataset of NRL_COM_DATASETS) {
  const yearDirectories = await listDatasetYears(dataset.root);
  for (const year of yearDirectories) {
    const filePath = path.join(dataset.root, year, `${dataset.sourceKey}_player_statistics_${year}.json`);

    try {
      await fs.access(filePath);
    } catch {
      continue;
    }

    const rows = await flattenPlayerStatsFile(filePath);
    for (const row of rows) {
    const definition = definitionByKey.get(row.stat_key);
    if (!definition) continue;

    const alias = resolveSeasonalAlias(nrlAliasToPlayer, row.player_name, row.season);
    const playerId = alias?.playerId ?? null;
    const canonicalName = alias?.canonicalName ?? row.player_name;
    const season = Number(row.season);
    const playerToken = makePlayerToken(playerId, canonicalName, row.player_name);
    const appearanceKey = `${playerToken}|${season}|${row.source_match_key}`;
    const appearanceSeasonKey = `${playerToken}|${season}`;

    if (!seenAppearances.has(appearanceKey)) {
      seenAppearances.add(appearanceKey);
      appearanceCounts.set(appearanceSeasonKey, (appearanceCounts.get(appearanceSeasonKey) ?? 0) + 1);
    }

    if (!appearanceSamples.has(appearanceSeasonKey)) {
      appearanceSamples.set(appearanceSeasonKey, {
        playerId,
        playerNameRaw: canonicalName || row.player_name,
      });
    }

    const aggregateKey = `${playerToken}|${season}|${row.stat_key}`;
    if (!seasonStatTotals.has(aggregateKey)) {
      seasonStatTotals.set(aggregateKey, {
        playerId,
        playerNameRaw: canonicalName || row.player_name,
        source: dataset.sourceKey.toLowerCase(),
        scope: "season",
        season,
        statKey: row.stat_key,
        totalValue: 0,
        recordedGames: 0,
        totalGames: 0,
        firstSeason: season,
        lastSeason: season,
      });
    }

    const aggregate = seasonStatTotals.get(aggregateKey);
    const recordedKey = `${aggregateKey}|${row.source_match_key}`;

    if (definition.missingValueStrategy === "zero_if_missing") {
      if (!seenRecordedMatches.has(recordedKey)) {
        seenRecordedMatches.add(recordedKey);
        aggregate.recordedGames += 1;
      }
      aggregate.totalValue += Number(row.stat_value_num ?? 0);
      continue;
    }

    if (row.stat_value_num !== null && row.stat_value_num !== undefined) {
      if (!seenRecordedMatches.has(recordedKey)) {
        seenRecordedMatches.add(recordedKey);
        aggregate.recordedGames += 1;
      }
      aggregate.totalValue += Number(row.stat_value_num);
    }
    }
  }
}

for (const [appearanceSeasonKey, totalGames] of appearanceCounts) {
  const [playerToken, seasonText] = appearanceSeasonKey.split("|");
  const season = Number(seasonText);
  const sample = appearanceSamples.get(appearanceSeasonKey);

  if (sample) {
    const gamesAggregateKey = `${playerToken}|${season}|games_played`;
    if (!seasonStatTotals.has(gamesAggregateKey)) {
      seasonStatTotals.set(gamesAggregateKey, {
        playerId: sample.playerId,
        playerNameRaw: sample.playerNameRaw,
        source: "derived",
        scope: "season",
        season,
        statKey: "games_played",
        totalValue: totalGames,
        recordedGames: totalGames,
        totalGames,
        firstSeason: season,
        lastSeason: season,
      });
    }
  }
}

const legacyAppearanceCounts = new Map();
const legacyAppearanceSamples = new Map();
function upsertLegacyAggregate(playerToken, season, statKey, value, sample, source) {
  const aggregateKey = `${playerToken}|${season}|${statKey}|${source}`;
  if (!seasonStatTotals.has(aggregateKey)) {
    seasonStatTotals.set(aggregateKey, {
      playerId: sample.playerId,
      playerNameRaw: sample.playerNameRaw,
      source,
      scope: "season",
      season,
      statKey,
      totalValue: 0,
      recordedGames: 0,
      totalGames: 0,
      firstSeason: season,
      lastSeason: season,
    });
  }
  const aggregate = seasonStatTotals.get(aggregateKey);
  aggregate.totalValue += value;
}

const seenLegacyAppearances = new Set();
for (const row of legacyRows) {
  const matchId = matchIdByAflKey.get(String(row.match_key ?? "").trim()) ?? null;
  const match = matchId ? matchById.get(matchId) : null;
  if (!match || match.competitionCode !== "SOO") continue;

  const alias = resolveSeasonalAlias(nrlAliasToPlayer, row.player, row.year, { teamName: row.team }) ?? null;
  const playerId = alias?.playerId ?? null;
  const canonicalName = alias?.canonicalName ?? row.player;
  const season = Number(row.year);
  const playerToken = makePlayerToken(playerId, canonicalName, row.player);
  const appearanceKey = `${playerToken}|${season}|${row.match_key}|soo`;

  if (!seenLegacyAppearances.has(appearanceKey)) {
    seenLegacyAppearances.add(appearanceKey);
    legacyAppearanceCounts.set(`${playerToken}|${season}|soo`, (legacyAppearanceCounts.get(`${playerToken}|${season}|soo`) ?? 0) + 1);
  }

  const sampleKey = `${playerToken}|${season}|soo`;
  if (!legacyAppearanceSamples.has(sampleKey)) {
    legacyAppearanceSamples.set(sampleKey, {
      playerId,
      playerNameRaw: canonicalName || row.player,
    });
  }

  const sample = legacyAppearanceSamples.get(sampleKey);
  upsertLegacyAggregate(playerToken, season, "tries", Number(row.tries) || 0, sample, "soo");
  upsertLegacyAggregate(playerToken, season, "goals", Number(row.goals) || 0, sample, "soo");
  upsertLegacyAggregate(playerToken, season, "field_goals_1pt", Number(row.fg1) || 0, sample, "soo");
  upsertLegacyAggregate(playerToken, season, "field_goals_2pt", Number(row.fg2) || 0, sample, "soo");
  upsertLegacyAggregate(
    playerToken,
    season,
    "points",
    ((Number(row.tries) || 0) * (season >= 1983 ? 4 : 3)) + ((Number(row.goals) || 0) * 2) + (Number(row.fg1) || 0) + ((Number(row.fg2) || 0) * 2),
    sample,
    "soo"
  );
}

for (const [sampleKey, sample] of legacyAppearanceSamples) {
  const [playerToken, seasonText] = sampleKey.split("|");
  const season = Number(seasonText);
  const totalGames = legacyAppearanceCounts.get(sampleKey) ?? 0;
  const gamesAggregateKey = `${playerToken}|${season}|games_played|soo`;
  if (!seasonStatTotals.has(gamesAggregateKey)) {
    seasonStatTotals.set(gamesAggregateKey, {
      playerId: sample.playerId,
      playerNameRaw: sample.playerNameRaw,
      source: "soo",
      scope: "season",
      season,
      statKey: "games_played",
      totalValue: totalGames,
      recordedGames: totalGames,
      totalGames,
      firstSeason: season,
      lastSeason: season,
    });
  }
}

for (const [aggregateKey, aggregate] of seasonStatTotals) {
  const [playerToken, seasonText, , source = "structured"] = aggregateKey.split("|");
  const appearanceMap = source === "soo" ? legacyAppearanceCounts : appearanceCounts;
  aggregate.totalGames = appearanceMap.get(`${playerToken}|${seasonText}|${source}`) ?? appearanceMap.get(`${playerToken}|${seasonText}`) ?? aggregate.totalGames;
  if (aggregate.statKey !== "games_played") {
    aggregate.recordedGames = Math.max(aggregate.recordedGames, aggregate.totalGames);
  }
}

const aggregates = [...seasonStatTotals.values()].sort((a, b) => {
  if ((a.playerNameRaw ?? "") !== (b.playerNameRaw ?? "")) {
    return String(a.playerNameRaw).localeCompare(String(b.playerNameRaw));
  }
  if (a.season !== b.season) return a.season - b.season;
  return a.statKey.localeCompare(b.statKey);
});

const statements = [];
statements.push("-- Generated by scripts/build-player-stat-aggregate-seed-sql.mjs");
statements.push("BEGIN TRANSACTION;");
statements.push("DELETE FROM player_stat_aggregates;");

let aggregateId = 1;
for (const aggregate of aggregates) {
  statements.push(
    `INSERT INTO player_stat_aggregates (player_stat_aggregate_id, player_id, player_name_raw, source, scope, season, stat_key, total_value, recorded_games, total_games, first_season, last_season) VALUES (${aggregateId}, ${sqlNumber(
      aggregate.playerId
    )}, ${sqlString(aggregate.playerNameRaw)}, ${sqlString(aggregate.source)}, ${sqlString(
      aggregate.scope
    )}, ${sqlNumber(aggregate.season)}, ${sqlString(aggregate.statKey)}, ${sqlNumber(
      aggregate.totalValue
    )}, ${sqlNumber(aggregate.recordedGames)}, ${sqlNumber(aggregate.totalGames)}, ${sqlNumber(
      aggregate.firstSeason
    )}, ${sqlNumber(aggregate.lastSeason)});`
  );
  aggregateId += 1;
}

statements.push("COMMIT;");

await fs.writeFile(sqlOutputPath, `${statements.join("\n")}\n`, "utf8");

console.log("Player stat aggregate seed SQL:", sqlOutputPath);
console.log("Rows:", aggregates.length);
