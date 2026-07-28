import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const databaseArg = process.argv[2];
if (!databaseArg) {
  throw new Error("Usage: node scripts/verify-player-stat-aggregates.mjs <database.sqlite>");
}

const databasePath = path.resolve(databaseArg);
if (!fs.existsSync(databasePath)) {
  throw new Error(`Database does not exist: ${databasePath}`);
}

const db = new DatabaseSync(databasePath, { readOnly: true });
const knownChecks = [
  { player: "Alex Johnston", source: "nrl", statKey: "tries", expected: 230 },
  { player: "Billy Slater", source: "nrl", statKey: "tries", expected: 190 },
];

for (const check of knownChecks) {
  const aggregate = db.prepare(`
    SELECT SUM(total_value) AS total
    FROM player_stat_aggregates
    WHERE player_name_raw = ?
      AND source = ?
      AND stat_key = ?
  `).get(check.player, check.source, check.statKey);

  const summary = db.prepare(`
    SELECT SUM(values_table.stat_value_num) AS total
    FROM player_match_stat_values values_table
    JOIN player_match_summary summary
      ON summary.player_match_summary_id = values_table.player_match_summary_id
    JOIN matches match_row ON match_row.match_id = summary.match_id
    JOIN competitions competition ON competition.competition_id = match_row.competition_id
    LEFT JOIN players player ON player.player_id = summary.player_id
    WHERE COALESCE(player.display_name, summary.player_name_raw) = ?
      AND lower(competition.code) = ?
      AND values_table.stat_key = ?
  `).get(check.player, check.source, check.statKey);

  const aggregateTotal = Number(aggregate?.total ?? 0);
  const summaryTotal = Number(summary?.total ?? 0);
  console.log(
    `${check.player} ${check.source.toUpperCase()} ${check.statKey}: `
    + `aggregate=${aggregateTotal}, summary=${summaryTotal}, expected=${check.expected}`
  );
  if (aggregateTotal !== summaryTotal || aggregateTotal !== check.expected) {
    throw new Error(`Known aggregate check failed for ${check.player} ${check.statKey}.`);
  }
}

const mismatches = db.prepare(`
  WITH aggregate_totals AS (
    SELECT
      player_id,
      player_name_raw,
      source,
      stat_key,
      SUM(total_value) AS total_value
    FROM player_stat_aggregates
    GROUP BY player_id, player_name_raw, source, stat_key
  ),
  summary_totals AS (
    SELECT
      summary.player_id,
      COALESCE(player.display_name, summary.player_name_raw) AS player_name_raw,
      lower(competition.code) AS source,
      values_table.stat_key,
      SUM(values_table.stat_value_num) AS total_value
    FROM player_match_stat_values values_table
    JOIN player_match_summary summary
      ON summary.player_match_summary_id = values_table.player_match_summary_id
    LEFT JOIN players player ON player.player_id = summary.player_id
    JOIN matches match_row ON match_row.match_id = summary.match_id
    JOIN competitions competition ON competition.competition_id = match_row.competition_id
    WHERE values_table.stat_value_num IS NOT NULL
    GROUP BY
      summary.player_id,
      COALESCE(player.display_name, summary.player_name_raw),
      lower(competition.code),
      values_table.stat_key
  )
  SELECT COUNT(*) AS mismatch_count
  FROM aggregate_totals aggregate
  LEFT JOIN summary_totals summary
    ON summary.player_id IS aggregate.player_id
    AND summary.player_name_raw = aggregate.player_name_raw
    AND summary.source = aggregate.source
    AND summary.stat_key = aggregate.stat_key
  WHERE aggregate.stat_key <> 'games_played'
    AND (
      summary.total_value IS NULL
      OR ABS(aggregate.total_value - summary.total_value) > 0.000001
    )
`).get();

const mismatchCount = Number(mismatches?.mismatch_count ?? 0);
console.log(`Aggregate-to-summary total mismatches: ${mismatchCount}`);
if (mismatchCount !== 0) {
  throw new Error("Persisted player aggregates do not match canonical match summaries.");
}

db.close();
