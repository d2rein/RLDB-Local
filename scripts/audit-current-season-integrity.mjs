import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const separator = value.indexOf("=");
    if (separator >= 0) args.set(value.slice(2, separator), value.slice(separator + 1));
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) args.set(value.slice(2), argv[++index]);
    else args.set(value.slice(2), "1");
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const databasePath = path.resolve(args.get("database") ?? "");
const season = Number(args.get("season") ?? new Date().getFullYear());
const competitions = String(args.get("competitions") ?? "NRL,NRLW")
  .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
if (!databasePath || !fs.existsSync(databasePath)) throw new Error("Pass an existing --database path.");
if (!Number.isInteger(season) || !competitions.length) throw new Error("Pass a valid --season and --competitions list.");

const db = new DatabaseSync(databasePath, { readOnly: true });
const placeholders = competitions.map(() => "?").join(",");
const all = (sql, ...binds) => db.prepare(sql).all(...binds);
const one = (sql, ...binds) => db.prepare(sql).get(...binds);
try {
  const commonBinds = [season, ...competitions];
  const sideCounts = all(`SELECT m.match_id,c.code,m.round_label,m.match_date_utc,
      SUM(CASE WHEN p.team_id=m.home_team_id AND p.is_home=1 THEN 1 ELSE 0 END) home_rows,
      SUM(CASE WHEN p.team_id=m.away_team_id AND p.is_home=0 THEN 1 ELSE 0 END) away_rows,
      SUM(CASE WHEN p.team_id=m.home_team_id AND p.is_home=1 AND
        (lower(COALESCE(p.position_label,'')) NOT LIKE '%reserve%' OR COALESCE(json_extract(p.stats_json,'$.minutes_played'),0)>0) THEN 1 ELSE 0 END) home_active,
      SUM(CASE WHEN p.team_id=m.away_team_id AND p.is_home=0 AND
        (lower(COALESCE(p.position_label,'')) NOT LIKE '%reserve%' OR COALESCE(json_extract(p.stats_json,'$.minutes_played'),0)>0) THEN 1 ELSE 0 END) away_active
    FROM matches m JOIN competitions c ON c.competition_id=m.competition_id
    JOIN player_match_summary p ON p.match_id=m.match_id
    WHERE m.season=? AND c.code IN (${placeholders}) GROUP BY m.match_id`, ...commonBinds);
  const invalidSideCounts = sideCounts.filter((row) => row.home_rows < 17 || row.home_rows > 21
    || row.away_rows < 17 || row.away_rows > 21 || Math.abs(row.home_rows - row.away_rows) > 2
    || row.home_active < 15 || row.home_active > 18 || row.away_active < 15 || row.away_active > 18);
  const assignmentIssues = all(`SELECT m.match_id,c.code,p.player_name_raw,p.team_id,p.opponent_team_id,p.is_home
    FROM player_match_summary p JOIN matches m ON m.match_id=p.match_id
    JOIN competitions c ON c.competition_id=m.competition_id
    WHERE m.season=? AND c.code IN (${placeholders}) AND (
      (p.is_home=1 AND (p.team_id<>m.home_team_id OR p.opponent_team_id<>m.away_team_id)) OR
      (p.is_home=0 AND (p.team_id<>m.away_team_id OR p.opponent_team_id<>m.home_team_id)) OR p.is_home NOT IN (0,1))
    ORDER BY m.match_id,p.player_match_summary_id`, ...commonBinds);
  const duplicateJumpers = all(`SELECT p.match_id,p.team_id,p.jumper_number,COUNT(*) rows
    FROM player_match_summary p JOIN matches m ON m.match_id=p.match_id
    JOIN competitions c ON c.competition_id=m.competition_id
    WHERE m.season=? AND c.code IN (${placeholders}) AND p.jumper_number IS NOT NULL
      AND (lower(COALESCE(p.position_label,'')) NOT LIKE '%reserve%' OR COALESCE(json_extract(p.stats_json,'$.minutes_played'),0)>0)
    GROUP BY p.match_id,p.team_id,p.jumper_number HAVING COUNT(*)>1
    ORDER BY p.match_id,p.team_id,p.jumper_number`, ...commonBinds);
  const dualTeamPlayers = all(`SELECT p.match_id,p.player_id,COUNT(DISTINCT p.team_id) teams
    FROM player_match_summary p JOIN matches m ON m.match_id=p.match_id
    JOIN competitions c ON c.competition_id=m.competition_id
    WHERE m.season=? AND c.code IN (${placeholders}) AND p.player_id IS NOT NULL
    GROUP BY p.match_id,p.player_id HAVING COUNT(DISTINCT p.team_id)>1 ORDER BY p.match_id,p.player_id`, ...commonBinds);
  const teamIssues = all(`SELECT m.match_id,COUNT(t.team_match_summary_id) rows,
      SUM(CASE WHEN (t.is_home=1 AND (t.team_id<>m.home_team_id OR t.opponent_team_id<>m.away_team_id))
        OR (t.is_home=0 AND (t.team_id<>m.away_team_id OR t.opponent_team_id<>m.home_team_id))
        OR t.is_home NOT IN (0,1) THEN 1 ELSE 0 END) bad_assignments,
      SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM team_match_stat_values v
        WHERE v.team_match_summary_id=t.team_match_summary_id) THEN 1 ELSE 0 END) missing_stats
    FROM matches m JOIN competitions c ON c.competition_id=m.competition_id
    LEFT JOIN team_match_summary t ON t.match_id=m.match_id
    WHERE m.season=? AND c.code IN (${placeholders})
      AND EXISTS(SELECT 1 FROM player_match_summary p WHERE p.match_id=m.match_id)
    GROUP BY m.match_id HAVING rows<>2 OR bad_assignments<>0 OR missing_stats<>0 ORDER BY m.match_id`, ...commonBinds);
  const missingNormalized = one(`SELECT
      SUM(NOT EXISTS(SELECT 1 FROM player_match_stat_values v WHERE v.player_match_summary_id=p.player_match_summary_id)) player_stats,
      SUM(NOT EXISTS(SELECT 1 FROM player_match_query_components q WHERE q.player_match_summary_id=p.player_match_summary_id)) query_components
    FROM player_match_summary p JOIN matches m ON m.match_id=p.match_id
    JOIN competitions c ON c.competition_id=m.competition_id
    WHERE m.season=? AND c.code IN (${placeholders})`, ...commonBinds);
  const scoringMismatches = all(`SELECT m.match_id,c.code,t.canonical_name team,s.team_score,
      COALESCE(json_extract(s.stats_json,'$.tries'),0)*4+COALESCE(json_extract(s.stats_json,'$.goals'),0)*2+
      COALESCE(json_extract(s.stats_json,'$.field_goals_1pt'),0)+COALESCE(json_extract(s.stats_json,'$.field_goals_2pt'),0)*2 attributed_points
    FROM team_match_summary s JOIN matches m ON m.match_id=s.match_id
    JOIN competitions c ON c.competition_id=m.competition_id JOIN teams t ON t.team_id=s.team_id
    WHERE m.season=? AND c.code IN (${placeholders}) AND s.team_score<>(
      COALESCE(json_extract(s.stats_json,'$.tries'),0)*4+COALESCE(json_extract(s.stats_json,'$.goals'),0)*2+
      COALESCE(json_extract(s.stats_json,'$.field_goals_1pt'),0)+COALESCE(json_extract(s.stats_json,'$.field_goals_2pt'),0)*2)
    ORDER BY m.match_id,s.is_home DESC`, ...commonBinds);
  const orphanMatches = all(`SELECT m.match_id,c.code,m.round_label,m.match_date_utc
    FROM matches m JOIN competitions c ON c.competition_id=m.competition_id
    WHERE m.season=? AND c.code IN (${placeholders}) AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM player_match_summary p WHERE p.match_id=m.match_id)
    ORDER BY m.match_date_utc,m.match_id`, ...commonBinds);
  const legacyTables = {
    matchPlayerStats: Number(one("SELECT COUNT(*) count FROM match_player_stats").count),
    matchTeamStats: Number(one("SELECT COUNT(*) count FROM match_team_stats").count),
  };
  const failures = invalidSideCounts.length + assignmentIssues.length + duplicateJumpers.length
    + dualTeamPlayers.length + teamIssues.length + scoringMismatches.length + orphanMatches.length
    + Number(missingNormalized.player_stats ?? 0) + Number(missingNormalized.query_components ?? 0);
  const report = {
    ok: failures === 0,
    databasePath,
    season,
    competitions,
    matchesAudited: sideCounts.length,
    legacyTables,
    issues: { invalidSideCounts, assignmentIssues, duplicateJumpers, dualTeamPlayers,
      teamIssues, missingNormalized, scoringMismatches, orphanMatches },
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures) process.exitCode = 1;
} finally {
  db.close();
}
