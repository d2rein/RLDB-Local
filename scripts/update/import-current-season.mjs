import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PLAYER_ALIASES = new Map([
  ["mins_played", "minutes_played"],
  ["1_point_field_goals", "field_goals_1pt"],
  ["2_point_field_goals", "field_goals_2pt"],
]);
const TEAM_ALIASES = new Map([
  ["bombs", "bomb_kicks"],
  ["penalties_conceded", "penalties"],
  ["average_play_ball_speed", "average_play_the_ball_speed"],
  ["total_passes", "passes"],
]);
const DERIVED_TEAM_KEYS = new Set([
  "conversion_attempts", "conversions_with_attempts", "tackle_attempts", "sets",
  "completed_sets", "kick_defusal_weighted_numerator", "opposition_kicks",
  "average_play_the_ball_speed_weighted_numerator", "opposition_tackles_made",
  "points_for_first_half", "points_against_first_half", "margin_first_half",
  "points_for_second_half", "points_against_second_half", "margin_second_half",
]);

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

function slugify(value) {
  return String(value ?? "").trim().toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function nameKey(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function parseValue(raw) {
  if (raw === null || raw === undefined || raw === "" || raw === "-" || raw === "None" || raw === "na" || raw === -1) return null;
  const text = String(raw).trim();
  if (/^\d+:\d{2}$/.test(text)) { const [m, s] = text.split(":").map(Number); return m + s / 60; }
  if (/^-?\d+(\.\d+)?[s%]$/.test(text)) return Number(text.slice(0, -1));
  if (/^-?\d+\/\d+$/.test(text)) return Number(text.split("/")[0]);
  const compact = text.replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(compact) ? Number(compact) : null;
}
function loadJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
function roundEntries(payload, competition, season, kind) {
  if (kind === "basic") return payload[competition]?.[0]?.[String(season)] ?? [];
  if (kind === "detail") return payload[competition] ?? [];
  return payload.PlayerStats?.[0]?.[String(season)] ?? [];
}
function indexRounds(entries) {
  return new Map(entries.flatMap((entry) => Object.entries(entry).map(([round, rows]) => [Number(round), rows])));
}
function splitRuns(players) {
  const runs = []; let current = []; let previous = null;
  for (const player of players) {
    const number = Number(player.Number ?? 999);
    if (current.length && number < previous) { runs.push(current); current = []; }
    current.push(player); previous = number;
  }
  if (current.length) runs.push(current);
  if (runs.length <= 1) return [runs.flat(), []];
  if (runs.length === 2) return [runs[0], runs[1]];
  const split = runs.length === 4 ? 2 : Math.ceil(runs.length / 2);
  return [runs.slice(0, split).flat(), runs.slice(split).flat()];
}
function dedupePlayers(players) {
  const found = new Map();
  for (const player of players) {
    const key = `${player.Name}|${player.Number}`;
    if (!found.has(key)) found.set(key, { ...player });
    else for (const [field, value] of Object.entries(player)) {
      if ([null, undefined, "", "-", "na"].includes(found.get(key)[field]) && ![null, undefined, "", "-", "na"].includes(value)) found.get(key)[field] = value;
    }
  }
  return [...found.values()];
}

const args = parseArgs(process.argv.slice(2));
const databasePath = path.resolve(args.get("database") ?? "");
const dataRoot = path.resolve(args.get("data-root") ?? "");
const season = Number(args.get("season") ?? new Date().getFullYear());
const competitions = String(args.get("competitions") ?? "NRL,NRLW").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
if (!databasePath || !fs.existsSync(databasePath)) throw new Error("Pass an existing --database path.");
if (!dataRoot || !fs.existsSync(dataRoot)) throw new Error("Pass an existing --data-root path.");

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;");
const definitions = db.prepare("SELECT scope, stat_key, missing_value_strategy FROM stat_definitions WHERE is_enabled=1").all();
const playerDefinitions = new Map(definitions.filter((row) => row.scope === "player").map((row) => [row.stat_key, row]));
const teamDefinitions = new Map(definitions.filter((row) => row.scope === "team").map((row) => [row.stat_key, row]));
const zeroPlayerKeys = new Set([...playerDefinitions.values()].filter((row) => row.missing_value_strategy === "zero_if_missing").map((row) => row.stat_key));
const zeroTeamKeys = new Set([...teamDefinitions.values()].filter((row) => row.missing_value_strategy === "zero_if_missing").map((row) => row.stat_key));

const competitionRows = new Map(db.prepare("SELECT * FROM competitions").all().map((row) => [row.code, row]));
const teamRows = db.prepare("SELECT * FROM teams").all();
const teamById = new Map(teamRows.map((row) => [row.team_id, row]));
const teamLookup = new Map();
for (const row of teamRows) for (const value of [row.canonical_name, row.short_name]) {
  if (value) teamLookup.set(`${row.competition_id}|${nameKey(value)}`, row.team_id);
}
for (const row of db.prepare("SELECT ta.*,t.competition_id FROM team_aliases ta JOIN teams t ON t.team_id=ta.team_id").all()) {
  teamLookup.set(`${row.competition_id}|${nameKey(row.source_name)}`, row.team_id);
}
for (const row of db.prepare(`SELECT m.competition_id,m.home_team_id,m.away_team_id,ms.source_home_team,ms.source_away_team
  FROM match_sources ms JOIN matches m ON m.match_id=ms.match_id
  WHERE ms.source_home_team IS NOT NULL AND ms.source_away_team IS NOT NULL`).all()) {
  teamLookup.set(`${row.competition_id}|${nameKey(row.source_home_team)}`, row.home_team_id);
  teamLookup.set(`${row.competition_id}|${nameKey(row.source_away_team)}`, row.away_team_id);
}

const playerLookup = new Map();
for (const row of db.prepare("SELECT player_id,display_name FROM players").all()) playerLookup.set(nameKey(row.display_name), row.player_id);
for (const row of db.prepare("SELECT player_id,source_name FROM player_aliases WHERE first_season<=? AND last_season>=?").all(season, season)) playerLookup.set(nameKey(row.source_name), row.player_id);
let nextPlayerId = Number(db.prepare("SELECT COALESCE(MAX(player_id),0)+1 n FROM players").get().n);

const matchLookup = new Map();
for (const row of db.prepare(`SELECT m.*,c.code FROM matches m JOIN competitions c ON c.competition_id=m.competition_id WHERE m.season=?`).all(season)) {
  matchLookup.set(`${row.code}|${row.round_index}|${row.home_team_id}|${row.away_team_id}`, row);
}
let nextMatchId = Number(db.prepare("SELECT COALESCE(MAX(match_id),0)+1 n FROM matches").get().n);
let nextMatchSourceId = Number(db.prepare("SELECT COALESCE(MAX(match_source_id),0)+1 n FROM match_sources").get().n);
let nextPlayerSummaryId = Number(db.prepare("SELECT COALESCE(MAX(player_match_summary_id),0)+1 n FROM player_match_summary").get().n);
let nextTeamSummaryId = Number(db.prepare("SELECT COALESCE(MAX(team_match_summary_id),0)+1 n FROM team_match_summary").get().n);

const insertPlayer = db.prepare("INSERT INTO players(player_id,display_name,sort_name,first_season,last_season,is_unresolved) VALUES(?,?,?,?,?,1)");
const insertPlayerAlias = db.prepare("INSERT INTO player_aliases(player_id,source,source_name,first_season,last_season,confidence) VALUES(?,?,?,?,?,?)");
const insertMatch = db.prepare("INSERT INTO matches(match_id,competition_id,season,round_label,round_index,match_date_utc,is_finals,home_team_id,away_team_id,home_score,away_score,winner_team_id,margin,venue_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
const updateMatch = db.prepare("UPDATE matches SET round_label=?,match_date_utc=?,home_score=?,away_score=?,winner_team_id=?,margin=?,venue_id=? WHERE match_id=?");
const insertMatchSource = db.prepare("INSERT INTO match_sources(match_source_id,match_id,source,source_match_key,source_round_label,source_round_index,source_date,source_home_team,source_away_team,source_home_score,source_away_score,source_venue,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
const updateMatchSource = db.prepare("UPDATE match_sources SET source_match_key=?,source_round_label=?,source_round_index=?,source_date=?,source_home_team=?,source_away_team=?,source_home_score=?,source_away_score=?,source_venue=?,source_url=? WHERE match_id=? AND source=?");
const insertPlayerSummary = db.prepare("INSERT INTO player_match_summary(player_match_summary_id,match_id,player_id,player_name_raw,team_id,opponent_team_id,season,round_index,is_finals,match_date_utc,is_home,jumper_number,position_label,stats_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
const insertTeamSummary = db.prepare("INSERT INTO team_match_summary(team_match_summary_id,match_id,team_id,opponent_team_id,season,round_index,is_finals,match_date_utc,is_home,team_score,opponent_score,result_code,stats_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");

function resolveTeam(rawName, competitionId) {
  const direct = teamLookup.get(`${competitionId}|${nameKey(rawName)}`);
  if (direct) return direct;
  const rawKey = nameKey(rawName);
  const candidates = teamRows.filter((row) => nameKey(row.canonical_name).endsWith(rawKey));
  const active = candidates.filter((row) => Number(row.is_active) === 1);
  const pool = active.length ? active : candidates;
  const selected = pool.sort((left, right) => Number(right.last_season ?? 0) - Number(left.last_season ?? 0))[0] ?? null;
  if (!selected) throw new Error(`Unresolved team: ${rawName}`);
  teamLookup.set(`${competitionId}|${rawKey}`, selected.team_id);
  return selected.team_id;
}
function resolveVenue(rawName) {
  if (!rawName) return null;
  const existing = db.prepare("SELECT venue_id FROM venues WHERE lower(canonical_name)=lower(?) OR lower(nrl_name)=lower(?) LIMIT 1").get(rawName, rawName);
  if (existing) return existing.venue_id;
  const id = Number(db.prepare("SELECT COALESCE(MAX(venue_id),0)+1 n FROM venues").get().n);
  db.prepare("INSERT INTO venues(venue_id,canonical_name,nrl_name) VALUES(?,?,?)").run(id, rawName, rawName);
  return id;
}
function resolvePlayer(rawName, source) {
  const key = nameKey(rawName); let id = playerLookup.get(key);
  if (id) return id;
  id = nextPlayerId++;
  insertPlayer.run(id, rawName, rawName, season, season);
  insertPlayerAlias.run(id, source, rawName, season, season, 0.75);
  playerLookup.set(key, id);
  report.createdPlayers += 1;
  return id;
}
function buildPlayerStats(row) {
  const stats = { games_played: 1 };
  for (const key of playerDefinitions.keys()) if (key !== "games_played") stats[key] = zeroPlayerKeys.has(key) ? 0 : null;
  for (const [rawKey, rawValue] of Object.entries(row)) {
    if (["Name", "Number", "Position"].includes(rawKey)) continue;
    const slug = slugify(rawKey); const key = PLAYER_ALIASES.get(slug) ?? slug;
    if (!playerDefinitions.has(key)) continue;
    const value = parseValue(rawValue); if (value !== null) stats[key] = value;
  }
  stats.goals = Number(stats.conversions ?? 0) + Number(stats.penalty_goals ?? 0);
  if (stats.points === null) stats.points = Number(stats.tries ?? 0) * 4 + stats.goals * 2 + Number(stats.field_goals_1pt ?? 0) + Number(stats.field_goals_2pt ?? 0) * 2;
  if (stats.total_points === null) stats.total_points = stats.points;
  if (stats.average_play_the_ball_speed !== null) {
    let denominator = stats.play_the_ball;
    if (denominator === null) { denominator = Math.max(1, Number(stats.receipts ?? 0) - Number(stats.passes ?? 0) - Number(stats.kicks ?? 0)); stats.play_the_ball = denominator; }
    if (Number(denominator) > 0) stats.play_the_ball_total_seconds = Number(denominator) * Number(stats.average_play_the_ball_speed);
  }
  if (Number(stats.conversion_attempts) > 0) { stats.conversions_with_attempts = Number(stats.conversions ?? 0); stats.goal_conversion_rate = Number(stats.conversions ?? 0) * 100 / Number(stats.conversion_attempts); }
  if ([stats.tackles_made, stats.missed_tackles, stats.ineffective_tackles].some((v) => v !== null)) stats.tackle_attempts = Number(stats.tackles_made ?? 0) + Number(stats.missed_tackles ?? 0) + Number(stats.ineffective_tackles ?? 0);
  if (Number(stats.all_runs) > 0 && stats.passes !== null) stats.passes_to_run_ratio = Number(stats.passes) / Number(stats.all_runs);
  if (Number(stats.tackle_attempts) > 0) stats.tackle_efficiency = Number(stats.tackles_made ?? 0) * 100 / Number(stats.tackle_attempts);
  return stats;
}
function buildTeamStats(payload) {
  const stats = {};
  for (const [rawKey, rawValue] of Object.entries(payload ?? {})) {
    const slug = slugify(rawKey); const key = TEAM_ALIASES.get(slug) ?? slug;
    const value = parseValue(rawValue);
    if (teamDefinitions.has(key) || DERIVED_TEAM_KEYS.has(key) || key === "half_time") stats[key] = value;
  }
  if (typeof payload?.conversions === "string" && /^\d+\/\d+$/.test(payload.conversions)) stats.conversion_attempts = Number(payload.conversions.split("/")[1]);
  if ([stats.tackles_made, stats.missed_tackles, stats.ineffective_tackles].some((v) => v !== null)) stats.tackle_attempts = Number(stats.tackles_made ?? 0) + Number(stats.missed_tackles ?? 0) + Number(stats.ineffective_tackles ?? 0);
  if (Number(stats.conversion_attempts) > 0) { stats.conversions_with_attempts = Number(stats.conversions ?? 0); stats.goal_conversion_rate = Number(stats.conversions ?? 0) * 100 / Number(stats.conversion_attempts); }
  if (Number(stats.average_set_distance) > 0 && stats.all_run_metres !== null) stats.sets = Number(stats.all_run_metres) / Number(stats.average_set_distance);
  if (stats.sets !== null && stats.sets !== undefined && stats.completion_rate !== null) stats.completed_sets = Number(stats.sets) * Number(stats.completion_rate) / 100;
  if (Number(stats.tackle_attempts) > 0) stats.effective_tackle = Number(stats.tackles_made ?? 0) * 100 / Number(stats.tackle_attempts);
  return stats;
}
function addHalfStats(stats, opponent, score, opponentScore) {
  const half = stats.half_time; const opponentHalf = opponent.half_time;
  stats.points_for_first_half = half; stats.points_against_first_half = opponentHalf;
  stats.margin_first_half = half !== null && opponentHalf !== null ? half - opponentHalf : null;
  stats.points_for_second_half = half !== null ? Number(score) - half : null;
  stats.points_against_second_half = opponentHalf !== null ? Number(opponentScore) - opponentHalf : null;
  stats.margin_second_half = stats.points_for_second_half !== null && stats.points_against_second_half !== null ? stats.points_for_second_half - stats.points_against_second_half : null;
}

const report = { season, competitions: {}, createdPlayers: 0 };
db.exec("BEGIN IMMEDIATE TRANSACTION;");
try {
  for (const code of competitions) {
    const competition = competitionRows.get(code); if (!competition) throw new Error(`Unknown competition: ${code}`);
    const directory = path.join(dataRoot, code, String(season));
    const basic = indexRounds(roundEntries(loadJson(path.join(directory, `${code}_data_${season}.json`)), code, season, "basic"));
    const details = indexRounds(roundEntries(loadJson(path.join(directory, `${code}_detailed_match_data_${season}.json`)), code, season, "detail"));
    const players = indexRounds(roundEntries(loadJson(path.join(directory, `${code}_player_statistics_${season}.json`)), code, season, "player"));
    const completeRounds = [...basic.keys()].filter((round) => details.has(round) && players.has(round)).sort((a, b) => a - b);
    if (!completeRounds.length) throw new Error(`No complete ${code} ${season} rounds found.`);
    const source = code.toLowerCase();
    const roundPlaceholders = completeRounds.map(() => "?").join(",");
    const existingMatchIds = db.prepare(`SELECT m.match_id FROM matches m WHERE m.competition_id=? AND m.season=? AND m.round_index IN (${roundPlaceholders})`)
      .all(competition.competition_id, season, ...completeRounds).map((row) => row.match_id);
    if (existingMatchIds.length) {
      const placeholders = existingMatchIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM player_match_summary WHERE match_id IN (${placeholders})`).run(...existingMatchIds);
      db.prepare(`DELETE FROM team_match_summary WHERE match_id IN (${placeholders})`).run(...existingMatchIds);
    }
    let importedMatches = 0; let importedPlayers = 0;
    for (const round of completeRounds) {
      const detailByLabel = new Map((details.get(round) ?? []).flatMap((wrapper) => Object.entries(wrapper)));
      const playerByKey = new Map((players.get(round) ?? []).flatMap((wrapper) => Object.entries(wrapper)));
      for (const rawMatch of basic.get(round) ?? []) {
        const homeId = resolveTeam(rawMatch.Home, competition.competition_id); const awayId = resolveTeam(rawMatch.Away, competition.competition_id);
        const key = `${code}|${round}|${homeId}|${awayId}`;
        let match = matchLookup.get(key);
        const venueId = resolveVenue(rawMatch.Venue);
        const homeScore = Number(rawMatch.Home_Score); const awayScore = Number(rawMatch.Away_Score);
        const winnerId = homeScore > awayScore ? homeId : awayScore > homeScore ? awayId : null;
        if (!match) {
          const isFinals = /final/i.test(String(rawMatch.Round ?? "")) ? 1 : 0;
          match = { match_id: nextMatchId++, round_index: round, is_finals: isFinals, home_team_id: homeId, away_team_id: awayId };
          insertMatch.run(match.match_id, competition.competition_id, season, rawMatch.Round ?? `Round ${round}`, round, rawMatch.Date, isFinals, homeId, awayId, homeScore, awayScore, winnerId, Math.abs(homeScore-awayScore), venueId);
          matchLookup.set(key, match);
        } else updateMatch.run(rawMatch.Round ?? `Round ${round}`, rawMatch.Date, homeScore, awayScore, winnerId, Math.abs(homeScore-awayScore), venueId, match.match_id);
        const sourceKey = `${season}-${round}-${String(rawMatch.Home).replace(/ /g,"-")}-v-${String(rawMatch.Away).replace(/ /g,"-")}`;
        const changed = updateMatchSource.run(sourceKey, rawMatch.Round, round, rawMatch.Date, rawMatch.Home, rawMatch.Away, String(homeScore), String(awayScore), rawMatch.Venue, rawMatch.Match_Centre_URL, match.match_id, "nrl.com");
        if (!changed.changes) insertMatchSource.run(nextMatchSourceId++, match.match_id, "nrl.com", sourceKey, rawMatch.Round, round, rawMatch.Date, rawMatch.Home, rawMatch.Away, String(homeScore), String(awayScore), rawMatch.Venue, rawMatch.Match_Centre_URL);
        const label = `${rawMatch.Home} v ${rawMatch.Away}`;
        const detail = detailByLabel.get(label) ?? detailByLabel.get(`${rawMatch.Away} v ${rawMatch.Home}`);
        if (!detail) throw new Error(`Missing detail payload: ${code} ${season} R${round} ${label}`);
        const meta = { ground_condition: detail.match?.ground_condition ?? null, weather_condition: detail.match?.weather_condition ?? null, referee: detail.match?.main_ref ?? null };
        const homeStats = buildTeamStats(detail.home); const awayStats = buildTeamStats(detail.away);
        homeStats.opposition_kicks = Number(awayStats.kicks ?? 0); awayStats.opposition_kicks = Number(homeStats.kicks ?? 0);
        homeStats.opposition_tackles_made = Number(awayStats.tackles_made ?? 0); awayStats.opposition_tackles_made = Number(homeStats.tackles_made ?? 0);
        addHalfStats(homeStats, awayStats, homeScore, awayScore); addHalfStats(awayStats, homeStats, awayScore, homeScore);
        for (const stats of [homeStats, awayStats]) Object.assign(stats, meta);
        if (homeStats.kick_defusal !== null && homeStats.opposition_kicks > 0) homeStats.kick_defusal_weighted_numerator = homeStats.kick_defusal * homeStats.opposition_kicks / 100;
        if (awayStats.kick_defusal !== null && awayStats.opposition_kicks > 0) awayStats.kick_defusal_weighted_numerator = awayStats.kick_defusal * awayStats.opposition_kicks / 100;
        if (homeStats.average_play_the_ball_speed !== null && homeStats.opposition_tackles_made > 0) homeStats.average_play_the_ball_speed_weighted_numerator = homeStats.average_play_the_ball_speed * homeStats.opposition_tackles_made;
        if (awayStats.average_play_the_ball_speed !== null && awayStats.opposition_tackles_made > 0) awayStats.average_play_the_ball_speed_weighted_numerator = awayStats.average_play_the_ball_speed * awayStats.opposition_tackles_made;
        const rawPlayers = playerByKey.get(sourceKey) ?? playerByKey.get(sourceKey.replace(/-v-/, "-v-"));
        if (!rawPlayers?.length) throw new Error(`Missing player payload: ${sourceKey}`);
        const [homeRoster, awayRoster] = splitRuns(rawPlayers).map(dedupePlayers);
        const scoring = new Map([[homeId,{tries:0,goals:0,field_goals_1pt:0,field_goals_2pt:0}],[awayId,{tries:0,goals:0,field_goals_1pt:0,field_goals_2pt:0}]]);
        for (const [roster, teamId, opponentId, isHome] of [[homeRoster,homeId,awayId,1],[awayRoster,awayId,homeId,0]]) for (const player of roster) {
          const playerId = resolvePlayer(player.Name, source); const stats = buildPlayerStats(player); Object.assign(stats, meta);
          const rollup = scoring.get(teamId); for (const stat of ["tries","goals","field_goals_1pt","field_goals_2pt"]) rollup[stat] += Number(stats[stat] ?? 0);
          insertPlayerSummary.run(nextPlayerSummaryId++, match.match_id, playerId, player.Name, teamId, opponentId, season, round, Number(match.is_finals ?? 0), rawMatch.Date, isHome, parseValue(player.Number), player.Position ?? null, JSON.stringify(stats));
          importedPlayers += 1;
        }
        for (const [teamId, stats] of [[homeId,homeStats],[awayId,awayStats]]) Object.assign(stats, scoring.get(teamId));
        insertTeamSummary.run(nextTeamSummaryId++, match.match_id, homeId, awayId, season, round, Number(match.is_finals ?? 0), rawMatch.Date, 1, homeScore, awayScore, homeScore>awayScore?"W":homeScore<awayScore?"L":"T", JSON.stringify(homeStats));
        insertTeamSummary.run(nextTeamSummaryId++, match.match_id, awayId, homeId, season, round, Number(match.is_finals ?? 0), rawMatch.Date, 0, awayScore, homeScore, awayScore>homeScore?"W":awayScore<homeScore?"L":"T", JSON.stringify(awayStats));
        importedMatches += 1;
      }
    }
    db.prepare("DELETE FROM player_stat_aggregates WHERE source=? AND season=?").run(source, season);
    db.exec(`INSERT INTO player_stat_aggregates(player_id,player_name_raw,source,scope,season,stat_key,total_value,recorded_games,total_games,first_season,last_season)
      SELECT s.player_id,COALESCE(p.display_name,s.player_name_raw),'${source}','season',s.season,'games_played',COUNT(*),COUNT(*),COUNT(*),s.season,s.season
      FROM player_match_summary s JOIN matches m ON m.match_id=s.match_id LEFT JOIN players p ON p.player_id=s.player_id
      WHERE m.competition_id=${competition.competition_id} AND s.season=${season} GROUP BY s.player_id,COALESCE(p.display_name,s.player_name_raw),s.season`);
    db.prepare(`INSERT INTO player_stat_aggregates(player_id,player_name_raw,source,scope,season,stat_key,total_value,recorded_games,total_games,first_season,last_season)
      SELECT s.player_id,COALESCE(p.display_name,s.player_name_raw),?,'season',s.season,v.stat_key,SUM(v.stat_value_num),
        CASE WHEN d.missing_value_strategy='zero_if_missing' THEN games.total_games ELSE COUNT(v.stat_value_num) END,
        games.total_games,s.season,s.season
      FROM player_match_summary s
      JOIN matches m ON m.match_id=s.match_id
      LEFT JOIN players p ON p.player_id=s.player_id
      JOIN player_match_stat_values v ON v.player_match_summary_id=s.player_match_summary_id
      JOIN stat_definitions d ON d.scope='player' AND d.stat_key=v.stat_key AND d.is_enabled=1 AND d.stat_key<>'games_played'
      JOIN (
        SELECT s2.player_id,COALESCE(p2.display_name,s2.player_name_raw) player_name_raw,COUNT(*) total_games
        FROM player_match_summary s2 JOIN matches m2 ON m2.match_id=s2.match_id LEFT JOIN players p2 ON p2.player_id=s2.player_id
        WHERE m2.competition_id=? AND s2.season=?
        GROUP BY s2.player_id,COALESCE(p2.display_name,s2.player_name_raw)
      ) games ON games.player_id IS s.player_id AND games.player_name_raw=COALESCE(p.display_name,s.player_name_raw)
      WHERE m.competition_id=? AND s.season=? AND v.stat_value_num IS NOT NULL
      GROUP BY s.player_id,COALESCE(p.display_name,s.player_name_raw),s.season,v.stat_key,games.total_games,d.missing_value_strategy`)
      .run(source, competition.competition_id, season, competition.competition_id, season);
    db.prepare("DELETE FROM team_season_aggregates WHERE source=? AND season=?").run(source, season);
    const teamSummaryRows = db.prepare(`SELECT s.*,t.canonical_name,m.round_label FROM team_match_summary s JOIN matches m ON m.match_id=s.match_id JOIN teams t ON t.team_id=s.team_id WHERE m.competition_id=? AND s.season=?`).all(competition.competition_id,season);
    const buckets = new Map();
    for (const row of teamSummaryRows) {
      const phase = row.is_finals ? (row.round_label === "Grand Final" ? "grand_final" : "finals") : "regular";
      const key = `${row.team_id}|${phase}`; if (!buckets.has(key)) buckets.set(key,{row,phase,games:0,stats:new Map()}); const bucket=buckets.get(key); bucket.games++;
      const values={games:1,wins:row.result_code==="W"?1:0,losses:row.result_code==="L"?1:0,draws:row.result_code==="T"?1:0,points_for:Number(row.team_score),points_against:Number(row.opponent_score),total_points:Number(row.team_score)+Number(row.opponent_score),margin:Number(row.team_score)-Number(row.opponent_score),...JSON.parse(row.stats_json)};
      for(const [stat,value] of Object.entries(values)){ const numeric=Number(value); if(!Number.isFinite(numeric) && !zeroTeamKeys.has(stat)) continue; const current=bucket.stats.get(stat)??{total:0,recorded:0}; current.total+=Number.isFinite(numeric)?numeric:0; current.recorded++; bucket.stats.set(stat,current); }
    }
    const insertTeamAggregate=db.prepare("INSERT INTO team_season_aggregates(team_id,team_name_raw,source,season,season_phase,stat_key,total_value,recorded_games,total_games,first_season,last_season) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    for(const bucket of buckets.values()) for(const [stat,value] of bucket.stats) insertTeamAggregate.run(bucket.row.team_id,bucket.row.canonical_name,source,season,bucket.phase,stat,value.total,value.recorded,bucket.games,season,season);
    report.competitions[code] = { latestRound: completeRounds.at(-1), importedMatches, importedPlayers };
  }
  db.exec("COMMIT;");
} catch (error) { db.exec("ROLLBACK;"); throw error; }

const invalidCurrentMatches = db.prepare(`WITH current_matches AS (
    SELECT m.match_id FROM matches m JOIN competitions c ON c.competition_id=m.competition_id
    WHERE m.season=? AND c.code IN (${competitions.map(() => "?").join(",")})
  ), team_counts AS (
    SELECT t.match_id,COUNT(*) team_rows FROM team_match_summary t
    JOIN current_matches m ON m.match_id=t.match_id GROUP BY t.match_id
  ), player_counts AS (
    SELECT p.match_id,COUNT(*) player_rows FROM player_match_summary p
    JOIN current_matches m ON m.match_id=p.match_id GROUP BY p.match_id
  )
  SELECT COUNT(*) AS count FROM player_counts p LEFT JOIN team_counts t ON t.match_id=p.match_id
  WHERE COALESCE(t.team_rows,0)<>2 OR p.player_rows<20`).get(season, ...competitions).count;
if (Number(invalidCurrentMatches) !== 0) {
  throw new Error(`Current-season summary validation failed for ${invalidCurrentMatches} matches.`);
}
const integrity = "targeted_current_season_checks_passed";
db.exec("PRAGMA optimize;");
const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
if (Number(checkpoint.busy) !== 0 || Number(checkpoint.log) !== 0) {
  throw new Error(`Unable to checkpoint staging WAL (busy=${checkpoint.busy}, log=${checkpoint.log}).`);
}
console.log(JSON.stringify({ ok: true, databasePath, integrity, ...report }, null, 2));
db.close();

const walPath = `${databasePath}-wal`;
if (fs.existsSync(walPath) && fs.statSync(walPath).size !== 0) {
  throw new Error(`Staging WAL was not fully checkpointed: ${walPath}`);
}
