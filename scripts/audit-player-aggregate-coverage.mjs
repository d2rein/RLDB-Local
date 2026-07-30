import { DatabaseSync } from "node:sqlite";

const databasePath = process.argv[2];
if (!databasePath) {
  throw new Error("Usage: node scripts/audit-player-aggregate-coverage.mjs <database.sqlite>");
}

const database = new DatabaseSync(databasePath, { readOnly: true });

const competitions = database.prepare(`
  SELECT competition_id, name
  FROM competitions
  ORDER BY competition_id
`).all();
const nrlCompetitionIds = competitions
  .filter((row) => row.name === "National Rugby League")
  .map((row) => Number(row.competition_id));
if (!nrlCompetitionIds.length) {
  throw new Error(`No NRL competition was found. Competitions: ${JSON.stringify(competitions)}`);
}
const competitionPlaceholders = nrlCompetitionIds.map(() => "?").join(", ");

const summaryPlayers = database.prepare(`
  SELECT
    COALESCE(p.display_name, s.player_name_raw) AS player,
    ROUND(SUM(COALESCE(v.stat_value_num, 0)), 3) AS tries
  FROM player_match_summary s
  LEFT JOIN players p ON p.player_id = s.player_id
  LEFT JOIN player_match_stat_values v
    ON v.player_match_summary_id = s.player_match_summary_id
   AND v.stat_key = 'tries'
  JOIN matches m ON m.match_id = s.match_id
  JOIN competitions c ON c.competition_id = m.competition_id
  WHERE s.season BETWEEN 1908 AND 2026
    AND c.competition_id IN (${competitionPlaceholders})
  GROUP BY COALESCE(p.display_name, s.player_name_raw)
`).all(...nrlCompetitionIds);

const aggregatePlayers = database.prepare(`
  SELECT
    COALESCE(p.display_name, a.player_name_raw) AS player,
    ROUND(SUM(a.total_value), 3) AS tries
  FROM player_stat_aggregates a
  LEFT JOIN players p ON p.player_id = a.player_id
  WHERE a.source = 'nrl'
    AND a.scope = 'season'
    AND a.season BETWEEN 1908 AND 2026
    AND a.stat_key = 'tries'
  GROUP BY COALESCE(p.display_name, a.player_name_raw)
`).all();

const summaryByPlayer = new Map(summaryPlayers.map((row) => [row.player, Number(row.tries)]));
const aggregateByPlayer = new Map(aggregatePlayers.map((row) => [row.player, Number(row.tries)]));
const names = [...new Set([...summaryByPlayer.keys(), ...aggregateByPlayer.keys()])].sort();
const differences = names
  .map((player) => ({
    player,
    summaryTries: summaryByPlayer.get(player) ?? null,
    aggregateTries: aggregateByPlayer.get(player) ?? null,
  }))
  .filter((row) => row.summaryTries !== row.aggregateTries);

console.log(JSON.stringify({
  databasePath,
  summaryPlayers: summaryPlayers.length,
  aggregatePlayers: aggregatePlayers.length,
  differenceCount: differences.length,
  differences: differences.slice(0, 100),
  differencesTruncated: differences.length > 100,
}, null, 2));

database.close();
