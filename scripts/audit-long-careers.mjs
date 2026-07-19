import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseCsv } from "./lib/csv.mjs";
import { normalizeWhitespace } from "./lib/normalize.mjs";
import { DOCS_DIR, WRANGLER_STATE_DIR } from "./lib/project-paths.mjs";

const LONG_CAREERS_CSV = path.join(DOCS_DIR, "player_long_careers_ordered.csv");
const LONG_CAREERS_AUDIT_CSV = path.join(DOCS_DIR, "player_long_careers_audit.csv");
const AFL_DUPLICATE_NAMES_CSV = path.join(DOCS_DIR, "afltables_point_name_duplicates.csv");
const AFL_AUDIT_DIR = path.join(DOCS_DIR, "afltables_audit");
const OVERRIDES_CSV = path.join(DOCS_DIR, "player_reconciliation_overrides.csv");

function normalizePlayerName(value) {
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['.`’]/g, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function decodeHtml(text) {
  return String(text ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&nbsp;?/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(text) {
  return decodeHtml(String(text ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function toInt(value) {
  const cleaned = String(value ?? "").replace(/,/g, "").trim();
  if (!cleaned || cleaned === "-" || cleaned === "\u00a0") {
    return 0;
  }
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function parseSeasonRange(text) {
  const match = String(text ?? "").match(/(\d{4})\s*-\s*(\d{4})/);
  if (match) {
    return { firstSeason: Number(match[1]), lastSeason: Number(match[2]) };
  }
  const single = String(text ?? "").match(/(\d{4})/);
  if (single) {
    const season = Number(single[1]);
    return { firstSeason: season, lastSeason: season };
  }
  return { firstSeason: null, lastSeason: null };
}

function extractTableRows(html, startPattern) {
  const startIndex = html.search(startPattern);
  if (startIndex === -1) {
    throw new Error(`Could not find table start pattern ${startPattern}`);
  }
  const tableStart = html.indexOf("<table", startIndex);
  const tableEnd = html.indexOf("</table>", startIndex);
  if (tableStart === -1 || tableEnd === -1) {
    throw new Error("Could not isolate source table.");
  }
  const tableHtml = html.slice(tableStart, tableEnd + "</table>".length);
  return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
}

function parseCells(rowHtml) {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => match[1]);
}

function parsePlayerCell(cellHtml) {
  const hrefMatch = cellHtml.match(/href="([^"]+)"/i);
  return {
    playerName: stripTags(cellHtml),
    playerUrl: hrefMatch?.[1] ?? "",
  };
}

function parseGamesHtml(html) {
  const tableMatch = html.match(/<table[^>]*>[\s\S]*?<th colspan=14>Most Games<\/th>[\s\S]*?<\/table>/i);
  if (!tableMatch) {
    throw new Error("Could not locate Most Games table.");
  }
  const rows = [...tableMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const records = [];
  for (const rowHtml of rows) {
    const cells = parseCells(rowHtml);
    if (cells.length < 4) continue;
    if (/Player/i.test(stripTags(cells[0])) && /Teams/i.test(stripTags(cells[1]))) continue;
    const { playerName, playerUrl } = parsePlayerCell(cells[0]);
    if (!playerName) continue;
    const seasonsLabel = stripTags(cells[2]);
    const { firstSeason, lastSeason } = parseSeasonRange(seasonsLabel);
    records.push({
      playerName,
      normalizedName: normalizePlayerName(playerName),
      playerUrl,
      seasonsLabel,
      firstSeason,
      lastSeason,
      games: toInt(stripTags(cells[3])),
    });
  }
  return records;
}

function parseFgCell(text) {
  const cleaned = stripTags(text);
  if (!cleaned || cleaned === "\u00a0") {
    return { fg1: 0, fg2: 0 };
  }
  const parts = cleaned.split("/");
  if (parts.length === 2) {
    return { fg1: toInt(parts[0]), fg2: toInt(parts[1]) };
  }
  return { fg1: toInt(cleaned), fg2: 0 };
}

function parsePointsHtml(html) {
  const rows = extractTableRows(html, /Point Scorers/i);
  const records = [];
  for (const rowHtml of rows) {
    const cells = parseCells(rowHtml);
    if (cells.length < 7) continue;
    if (/Player/i.test(stripTags(cells[0])) && /Teams/i.test(stripTags(cells[1]))) continue;
    const { playerName, playerUrl } = parsePlayerCell(cells[0]);
    if (!playerName) continue;
    const seasonsLabel = stripTags(cells[2]);
    const { firstSeason, lastSeason } = parseSeasonRange(seasonsLabel);
    const { fg1, fg2 } = parseFgCell(cells[5]);
    records.push({
      playerName,
      normalizedName: normalizePlayerName(playerName),
      playerUrl,
      seasonsLabel,
      firstSeason,
      lastSeason,
      tries: toInt(stripTags(cells[3])),
      goals: toInt(stripTags(cells[4])),
      fg1,
      fg2,
      points: toInt(stripTags(cells[6])),
    });
  }
  return records;
}

function groupBy(records, keySelector) {
  const grouped = new Map();
  for (const record of records) {
    const key = keySelector(record);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(record);
  }
  return grouped;
}

async function findDatabaseFile() {
  const entries = await fs.readdir(WRANGLER_STATE_DIR);
  const sqliteFiles = entries
    .filter((entry) => entry.endsWith(".sqlite"))
    .sort((left, right) => {
      if (left === "local.sqlite") return 1;
      if (right === "local.sqlite") return -1;
      return left.localeCompare(right);
    });

  if (sqliteFiles.length === 0) {
    throw new Error(`No local D1 sqlite file found in ${WRANGLER_STATE_DIR}`);
  }

  return path.join(WRANGLER_STATE_DIR, sqliteFiles[0]);
}

function summarizeAflRecords(records, mode) {
  if (!records.length) {
    return {
      count: 0,
      urls: "",
      labels: "",
      games: 0,
      tries: 0,
      goals: 0,
      fg1: 0,
      fg2: 0,
      points: 0,
    };
  }

  const urls = [...new Set(records.map((record) => record.playerUrl).filter(Boolean))];
  const labels = records.map((record) => {
    const bits = [record.playerName];
    if (record.seasonsLabel) bits.push(record.seasonsLabel);
    if (mode === "games") bits.push(`G:${record.games}`);
    if (mode === "points") bits.push(`T:${record.tries}`, `P:${record.points}`);
    return bits.join(" ");
  });

  return {
    count: records.length,
    urls: urls.join(" | "),
    labels: labels.join(" | "),
    games: records.reduce((sum, record) => sum + (record.games ?? 0), 0),
    tries: records.reduce((sum, record) => sum + (record.tries ?? 0), 0),
    goals: records.reduce((sum, record) => sum + (record.goals ?? 0), 0),
    fg1: records.reduce((sum, record) => sum + (record.fg1 ?? 0), 0),
    fg2: records.reduce((sum, record) => sum + (record.fg2 ?? 0), 0),
    points: records.reduce((sum, record) => sum + (record.points ?? 0), 0),
  };
}

function buildFlags({ longCareer, gamesSummary, pointsSummary, dbGames, dbTries, dbPoints }) {
  const flags = [];

  if (Number(longCareer.is_unresolved) === 1) flags.push("unresolved_db_player");
  if (Number(longCareer.max_gap) >= 5) flags.push("large_career_gap");
  if (pointsSummary.count > 1) flags.push("multiple_afltables_point_records");
  if (gamesSummary.count > 1) flags.push("multiple_afltables_games_records");
  if (gamesSummary.count === 0 && Number(longCareer.last_season) >= 1980) flags.push("missing_afltables_games_record");
  if (pointsSummary.count === 0) flags.push("missing_afltables_points_record");
  if (gamesSummary.count > 0 && gamesSummary.games !== dbGames) flags.push("games_mismatch");
  if (pointsSummary.count > 0 && pointsSummary.tries !== dbTries) flags.push("tries_mismatch");
  if (pointsSummary.count > 0 && pointsSummary.points !== dbPoints) flags.push("points_mismatch");

  return flags.join(" | ");
}

async function loadApprovedOverrides() {
  const rows = parseCsv(await fs.readFile(OVERRIDES_CSV, "utf8"));
  const byNrlName = new Map();
  for (const row of rows) {
    if (normalizeWhitespace(row.status).toLowerCase() !== "approved") continue;
    const nrlPlayerName = normalizeWhitespace(row.nrl_player_name);
    const aflPlayerName = normalizeWhitespace(row.afl_player_name);
    if (!nrlPlayerName || !aflPlayerName) continue;
    byNrlName.set(nrlPlayerName, aflPlayerName);
  }
  return byNrlName;
}

function loadLongCareerRows(db) {
  const seasonRows = db.prepare(`
    SELECT
      p.player_id,
      p.display_name,
      p.is_unresolved,
      p.first_season,
      p.last_season,
      m.season
    FROM players p
    LEFT JOIN player_match_summary pms
      ON pms.player_id = p.player_id
    LEFT JOIN matches m
      ON m.match_id = pms.match_id
     AND m.competition_id = 1
    WHERE p.first_season IS NOT NULL
      AND p.last_season IS NOT NULL
      AND (p.last_season - p.first_season) > 10
    ORDER BY p.display_name, m.season
  `).all();

  const grouped = new Map();
  for (const row of seasonRows) {
    const displayName = row.display_name;
    if (!grouped.has(displayName)) {
      grouped.set(displayName, {
        display_name: displayName,
        first_season: Number(row.first_season),
        last_season: Number(row.last_season),
        span: Number(row.last_season) - Number(row.first_season),
        is_unresolved: Number(row.is_unresolved ?? 0),
        seasons: new Set(),
      });
    }
    if (Number.isFinite(Number(row.season))) {
      grouped.get(displayName).seasons.add(Number(row.season));
    }
  }

  return [...grouped.values()]
    .map((row) => {
      const seasons = [...row.seasons].sort((left, right) => left - right);
      let maxGap = 0;
      for (let index = 1; index < seasons.length; index += 1) {
        maxGap = Math.max(maxGap, seasons[index] - seasons[index - 1]);
      }
      return {
        display_name: row.display_name,
        first_season: row.first_season,
        last_season: row.last_season,
        span: row.span,
        is_unresolved: row.is_unresolved,
        max_gap: maxGap,
        seasons_count: seasons.length,
      };
    })
    .sort((left, right) => {
      if (left.first_season !== right.first_season) return left.first_season - right.first_season;
      if (left.last_season !== right.last_season) return left.last_season - right.last_season;
      return left.display_name.localeCompare(right.display_name);
    });
}

const dbPath = await findDatabaseFile();
const db = new DatabaseSync(dbPath, { readonly: true });
const longCareers = loadLongCareerRows(db);
const approvedOverrides = await loadApprovedOverrides();

const dbStats = new Map(
  db.prepare(`
    WITH long_careers AS (
      SELECT player_id, display_name, first_season, last_season
      FROM players
      WHERE first_season IS NOT NULL
        AND last_season IS NOT NULL
        AND (last_season - first_season) > 10
    )
    SELECT
      lc.display_name,
      COUNT(DISTINCT CASE WHEN m.competition_id = 1 THEN pms.match_id END) AS games,
      COALESCE(SUM(CASE
        WHEN m.competition_id = 1 THEN COALESCE(CAST(json_extract(pms.stats_json, '$.tries') AS REAL), 0)
        ELSE 0
      END), 0) AS tries,
      COALESCE(SUM(CASE
        WHEN m.competition_id = 1 THEN COALESCE(CAST(json_extract(pms.stats_json, '$.points') AS REAL), 0)
        ELSE 0
      END), 0) AS points
    FROM long_careers lc
    LEFT JOIN players p ON p.display_name = lc.display_name
    LEFT JOIN player_match_summary pms ON pms.player_id = p.player_id
    LEFT JOIN matches m ON m.match_id = pms.match_id
    GROUP BY lc.display_name
  `).all().map((row) => [row.display_name, row])
);

const gamesHtml = await fs.readFile(path.join(AFL_AUDIT_DIR, "games.html"), "utf8");
const gamesRecords = parseGamesHtml(gamesHtml);
const gamesByName = groupBy(gamesRecords, (record) => record.normalizedName);

const pointRecords = [];
for (let index = 1; index <= 7; index += 1) {
  const html = await fs.readFile(path.join(AFL_AUDIT_DIR, `overall_sc${index}.html`), "utf8");
  pointRecords.push(...parsePointsHtml(html));
}
const pointsByName = groupBy(pointRecords, (record) => record.normalizedName);

const duplicatePointNameRows = [...pointsByName.entries()]
  .filter(([, records]) => records.length > 1)
  .map(([normalizedName, records]) => ({
    normalized_name: normalizedName,
    display_name: records[0]?.playerName ?? "",
    player_count: records.length,
    urls: records.map((record) => record.playerUrl).join(" | "),
    seasons: records.map((record) => record.seasonsLabel).join(" | "),
    tries_total: records.reduce((sum, record) => sum + record.tries, 0),
    points_total: records.reduce((sum, record) => sum + record.points, 0),
  }))
  .sort((left, right) => left.display_name.localeCompare(right.display_name));

const auditRows = longCareers.map((row) => {
  const dbRow = dbStats.get(row.display_name) ?? { games: 0, tries: 0, points: 0 };
  const approvedAflName = approvedOverrides.get(row.display_name) ?? "";
  const nameKeys = new Set([normalizePlayerName(row.display_name)]);
  if (approvedAflName) {
    nameKeys.add(normalizePlayerName(approvedAflName));
  }

  const matchingGames = [...nameKeys].flatMap((key) => gamesByName.get(key) ?? []);
  const matchingPoints = [...nameKeys].flatMap((key) => pointsByName.get(key) ?? []);
  const gamesSummary = summarizeAflRecords(matchingGames, "games");
  const pointsSummary = summarizeAflRecords(matchingPoints, "points");
  const dbGames = Number(dbRow.games) || 0;
  const dbTries = Number(dbRow.tries) || 0;
  const dbPoints = Number(dbRow.points) || 0;

  return {
    ...row,
    db_games: dbGames,
    db_tries: dbTries,
    db_points: dbPoints,
    approved_afltables_name: approvedAflName,
    afl_games_record_count: gamesSummary.count,
    afl_games_total: gamesSummary.games,
    afl_games_urls: gamesSummary.urls,
    afl_games_rows: gamesSummary.labels,
    afl_points_record_count: pointsSummary.count,
    afl_points_tries_total: pointsSummary.tries,
    afl_points_goals_total: pointsSummary.goals,
    afl_points_fg1_total: pointsSummary.fg1,
    afl_points_fg2_total: pointsSummary.fg2,
    afl_points_total: pointsSummary.points,
    afl_points_urls: pointsSummary.urls,
    afl_points_rows: pointsSummary.labels,
    games_diff: gamesSummary.count > 0 ? dbGames - gamesSummary.games : "",
    tries_diff: pointsSummary.count > 0 ? dbTries - pointsSummary.tries : "",
    points_diff: pointsSummary.count > 0 ? dbPoints - pointsSummary.points : "",
    discrepancy_flags: buildFlags({
      longCareer: row,
      gamesSummary,
      pointsSummary,
      dbGames,
      dbTries,
      dbPoints,
    }),
  };
});

const auditHeaders = [
  "display_name",
  "first_season",
  "last_season",
  "span",
  "is_unresolved",
  "max_gap",
  "seasons_count",
  "db_games",
  "db_tries",
  "db_points",
  "approved_afltables_name",
  "afl_games_record_count",
  "afl_games_total",
  "games_diff",
  "afl_games_urls",
  "afl_games_rows",
  "afl_points_record_count",
  "afl_points_tries_total",
  "afl_points_goals_total",
  "afl_points_fg1_total",
  "afl_points_fg2_total",
  "afl_points_total",
  "tries_diff",
  "points_diff",
  "afl_points_urls",
  "afl_points_rows",
  "discrepancy_flags",
];

const duplicateHeaders = [
  "display_name",
  "normalized_name",
  "player_count",
  "tries_total",
  "points_total",
  "seasons",
  "urls",
];

const auditCsvText = `${[
  auditHeaders.join(","),
  ...auditRows.map((row) => auditHeaders.map((header) => csvEscape(row[header])).join(",")),
].join("\n")}\n`;

await fs.writeFile(LONG_CAREERS_CSV, auditCsvText, "utf8");
await fs.writeFile(LONG_CAREERS_AUDIT_CSV, auditCsvText, "utf8");

await fs.writeFile(
  AFL_DUPLICATE_NAMES_CSV,
  `${[
    duplicateHeaders.join(","),
    ...duplicatePointNameRows.map((row) => duplicateHeaders.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n")}\n`,
  "utf8"
);

console.log(`Long-career audit written to ${LONG_CAREERS_AUDIT_CSV}`);
console.log(`Long-career ordered CSV updated at ${LONG_CAREERS_CSV}`);
console.log(`AFL duplicate-name audit written to ${AFL_DUPLICATE_NAMES_CSV}`);
console.log(`Long-career rows: ${auditRows.length}`);
console.log(`Duplicate AFL point names: ${duplicatePointNameRows.length}`);
