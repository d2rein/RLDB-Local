import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const databasePath = resolve(
  process.env.RLDB_DATABASE_PATH ||
    "../rldb-direct-node-runtime/data/rldb.sqlite",
);
const outputPath = resolve(
  process.env.RLDB_INDEX_AUDIT_OUTPUT ||
    "reports/indexes/proposed-index-audit.json",
);

const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout = 10000");

function percentile(samples, fraction) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) * fraction)];
}

function benchmark(sql, parameters, iterations = 300) {
  const statement = database.prepare(sql);
  const warmupIterations = iterations < 50 ? 3 : 25;
  for (let index = 0; index < warmupIterations; index += 1) statement.all(...parameters);

  const samples = [];
  let rows = 0;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    rows = statement.all(...parameters).length;
    samples.push(performance.now() - startedAt);
  }

  return {
    iterations,
    rows,
    minimum_ms: Math.min(...samples),
    median_ms: percentile(samples, 0.5),
    p95_ms: percentile(samples, 0.95),
    maximum_ms: Math.max(...samples),
    mean_ms: samples.reduce((total, value) => total + value, 0) / samples.length,
  };
}

function explain(sql, parameters) {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map(({ id, parent, detail }) => ({ id, parent, detail }));
}

function storage() {
  const pageSize = Number(database.prepare("PRAGMA page_size").get().page_size);
  const pageCount = Number(database.prepare("PRAGMA page_count").get().page_count);
  const freePages = Number(database.prepare("PRAGMA freelist_count").get().freelist_count);
  return {
    page_size: pageSize,
    page_count: pageCount,
    free_pages: freePages,
    allocated_pages: pageCount - freePages,
    allocated_bytes: (pageCount - freePages) * pageSize,
  };
}

const player = database
  .prepare(`
    SELECT player_id, team_id, MIN(season) AS first_season,
           MAX(season) AS last_season, COUNT(*) AS rows
    FROM player_match_summary
    WHERE player_id IS NOT NULL AND team_id IS NOT NULL
    GROUP BY player_id, team_id
    ORDER BY rows DESC
    LIMIT 1
  `)
  .get();
const team = database
  .prepare(`
    SELECT team_id, opponent_team_id, MIN(season) AS first_season,
           MAX(season) AS last_season, COUNT(*) AS rows
    FROM team_match_summary
    WHERE team_id IS NOT NULL AND opponent_team_id IS NOT NULL
    GROUP BY team_id, opponent_team_id
    ORDER BY rows DESC
    LIMIT 1
  `)
  .get();
const season = database
  .prepare(`
    SELECT competition_id, season, COUNT(*) AS rows
    FROM matches
    GROUP BY competition_id, season
    ORDER BY rows DESC
    LIMIT 1
  `)
  .get();
const match = database.prepare("SELECT match_id FROM matches LIMIT 1").get();
player.player_name = database
  .prepare("SELECT COALESCE(display_name, ?) AS name FROM players WHERE player_id = ?")
  .get(`Player ${player.player_id}`, player.player_id).name;
player.team_name = database
  .prepare("SELECT canonical_name AS name FROM teams WHERE team_id = ?")
  .get(player.team_id).name;
team.team_name = database
  .prepare("SELECT canonical_name AS name FROM teams WHERE team_id = ?")
  .get(team.team_id).name;
team.opponent_name = database
  .prepare("SELECT canonical_name AS name FROM teams WHERE team_id = ?")
  .get(team.opponent_team_id).name;

const experiments = [
  {
    name: "idx_player_match_summary_lookup",
    create_sql:
      "CREATE INDEX idx_player_match_summary_lookup ON player_match_summary (player_id, season, team_id)",
    queries: [
      {
        name: "player-season-team-filter",
        sql: `SELECT match_id, team_id, opponent_team_id, season
              FROM player_match_summary
              WHERE player_id = ? AND season BETWEEN ? AND ? AND team_id = ?`,
        parameters: [player.player_id, player.first_season, player.last_season, player.team_id],
      },
      {
        name: "player-season-team-date-order",
        sql: `SELECT match_id, team_id, opponent_team_id, season
              FROM player_match_summary
              WHERE player_id = ? AND season BETWEEN ? AND ? AND team_id = ?
              ORDER BY match_date_utc`,
        parameters: [player.player_id, player.first_season, player.last_season, player.team_id],
      },
      {
        name: "application-player-name-team-filter",
        sql: `SELECT s.match_id, s.team_id, s.opponent_team_id, s.season
              FROM player_match_summary s
              LEFT JOIN players p ON p.player_id = s.player_id
              JOIN teams t ON t.team_id = s.team_id
              JOIN matches m ON m.match_id = s.match_id
              WHERE s.season BETWEEN ? AND ?
                AND COALESCE(p.display_name, s.player_name_raw) = ?
                AND t.canonical_name = ?`,
        parameters: [player.first_season, player.last_season, player.player_name, player.team_name],
        iterations: 5,
      },
    ],
  },
  {
    name: "idx_team_match_summary_lookup",
    create_sql:
      "CREATE INDEX idx_team_match_summary_lookup ON team_match_summary (team_id, season, opponent_team_id)",
    queries: [
      {
        name: "team-season-opponent-filter",
        sql: `SELECT match_id, team_id, opponent_team_id, season
              FROM team_match_summary
              WHERE team_id = ? AND season BETWEEN ? AND ? AND opponent_team_id = ?`,
        parameters: [team.team_id, team.first_season, team.last_season, team.opponent_team_id],
      },
      {
        name: "team-season-opponent-date-order",
        sql: `SELECT match_id, team_id, opponent_team_id, season
              FROM team_match_summary
              WHERE team_id = ? AND season BETWEEN ? AND ? AND opponent_team_id = ?
              ORDER BY match_date_utc`,
        parameters: [team.team_id, team.first_season, team.last_season, team.opponent_team_id],
      },
      {
        name: "application-team-opponent-name-filter",
        sql: `SELECT s.match_id, s.team_id, s.opponent_team_id, s.season
              FROM team_match_summary s
              JOIN teams t ON t.team_id = s.team_id
              JOIN teams ot ON ot.team_id = s.opponent_team_id
              JOIN matches m ON m.match_id = s.match_id
              WHERE s.season BETWEEN ? AND ?
                AND t.canonical_name = ?
                AND ot.canonical_name = ?`,
        parameters: [team.first_season, team.last_season, team.team_name, team.opponent_name],
        iterations: 20,
      },
    ],
  },
  {
    name: "idx_matches_lookup",
    create_sql:
      "CREATE INDEX idx_matches_lookup ON matches (season, competition_id, match_id)",
    queries: [
      {
        name: "competition-season-round-date-order",
        sql: `SELECT match_id, round_index, match_date_utc
              FROM matches
              WHERE competition_id = ? AND season = ?
              ORDER BY round_index, match_date_utc`,
        parameters: [season.competition_id, season.season],
      },
      {
        name: "season-competition-match-order",
        sql: `SELECT match_id, round_index, match_date_utc
              FROM matches
              WHERE season = ? AND competition_id = ?
              ORDER BY match_id`,
        parameters: [season.season, season.competition_id],
      },
      {
        name: "primary-key-match-lookup",
        sql: "SELECT * FROM matches WHERE match_id = ?",
        parameters: [match.match_id],
      },
    ],
  },
];

const originalIndexes = database
  .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
  .all();
const report = {
  generated_at_utc: new Date().toISOString(),
  database_path: databasePath,
  database_storage_before: storage(),
  representative_parameters: { player, team, season, match },
  existing_indexes: originalIndexes,
  experiments: [],
};

try {
  for (const experiment of experiments) {
    database.exec(`DROP INDEX IF EXISTS ${experiment.name}`);
    const beforeStorage = storage();
    const before = experiment.queries.map((query) => ({
      name: query.name,
      plan: explain(query.sql, query.parameters),
      timing: benchmark(query.sql, query.parameters, query.iterations),
    }));

    const buildStartedAt = performance.now();
    database.exec(experiment.create_sql);
    const buildDurationMs = performance.now() - buildStartedAt;
    const afterStorage = storage();
    const after = experiment.queries.map((query) => ({
      name: query.name,
      plan: explain(query.sql, query.parameters),
      timing: benchmark(query.sql, query.parameters, query.iterations),
    }));

    report.experiments.push({
      name: experiment.name,
      create_sql: experiment.create_sql,
      build_duration_ms: buildDurationMs,
      allocated_bytes: afterStorage.allocated_bytes - beforeStorage.allocated_bytes,
      before,
      after,
    });
    database.exec(`DROP INDEX IF EXISTS ${experiment.name}`);
  }
} finally {
  for (const experiment of experiments) {
    database.exec(`DROP INDEX IF EXISTS ${experiment.name}`);
  }
  const testedIndexNames = new Set(experiments.map(({ name }) => name));
  for (const index of originalIndexes) {
    if (testedIndexNames.has(index.name)) database.exec(index.sql);
  }
  report.database_storage_after = storage();
  report.restored_proposed_indexes = database
    .prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (?, ?, ?)
    `)
    .all(...experiments.map(({ name }) => name));
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Index audit written to ${outputPath}`);
console.log(`Pre-existing tested indexes restored: ${report.restored_proposed_indexes.length}`);
