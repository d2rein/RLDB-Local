import fs from "node:fs/promises";
import path from "node:path";
import { DOCS_DIR } from "./lib/project-paths.mjs";
import { SOO_AFLTABLES_MATCHES_CSV, SOO_AFLTABLES_PLAYER_STATS_CSV } from "./lib/paths.mjs";

const REP_PAYLOADS_PATH = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data", "REP", "rep_match_payloads.json");
const SOO_INDEX_URL = "https://afltables.com/rl/soo/soo_idx.html";

const MATCH_HEADER = [
  "competition",
  "season",
  "round_label",
  "round_index",
  "match_key",
  "date",
  "home",
  "away",
  "home_score",
  "away_score",
  "venue",
  "attendance",
  "referee",
  "url_afltables",
  "url_nrl",
];

const PLAYER_HEADER = [
  "match_key",
  "year",
  "round",
  "home",
  "away",
  "team",
  "player",
  "tries",
  "goals",
  "fg1",
  "fg2",
  "date",
  "url",
];

const TEAM_NAME_TO_CANONICAL = new Map([
  ["new south wales", "Blues"],
  ["queensland", "Maroons"],
]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function toCsv(header, rows) {
  return `${[header.join(","), ...rows.map((row) => header.map((key) => csvEscape(row[key] ?? "")).join(","))].join("\n")}\n`;
}

function canonicalOriginTeamName(value) {
  const normalized = normalizeText(value).toLowerCase();
  return TEAM_NAME_TO_CANONICAL.get(normalized) ?? normalizeText(value);
}

function decodeHtml(html) {
  return html
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "-")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "");
}

function cleanPlayerName(value) {
  return normalizeText(value)
    .replace(/\(([A-Z]{1,4})\)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMatchKey(season, roundLabel, homeTeam, awayTeam) {
  return `${season}-${roundLabel}-${homeTeam}-v-${awayTeam}`;
}

function fixtureLookupKey(season, roundIndex) {
  return `${season}|${roundIndex}`;
}

function parseOfficialFixtures(repPayloads) {
  return (repPayloads.payloads ?? [])
    .filter((row) => row.fixture?.competitionCode === "SOO")
    .map((row) => ({
      season: Number(row.fixture.season),
      roundLabel: normalizeText(row.fixture.roundLabel),
      roundIndex: Number(row.fixture.gameNumber ?? 0),
      homeTeam: normalizeText(row.fixture.homeTeam),
      awayTeam: normalizeText(row.fixture.awayTeam),
      homeScore: Number(row.payload?.match?.homeTeam?.score ?? 0),
      awayScore: Number(row.payload?.match?.awayTeam?.score ?? 0),
      date: normalizeText(row.payload?.match?.startTime || row.fixture.kickoff),
      urlNrl: normalizeText(row.fixture.url),
    }))
    .sort((a, b) => a.season - b.season || a.roundIndex - b.roundIndex);
}

function parseSooIndex(html) {
  const indexRows = [];
  const seasonCounters = new Map();
  const rowRegex = /<tr><td width=15%>\s*(\d{4}):Game\s+(\d+)([+*]?)<\/td><td width=15%>([^<]+)<\/td>\s*<td width=40%>(New South Wales|Queensland)\s+(def\.|drew)\s+(Queensland|New South Wales)\s+(\d+)-(\d+)<\/td><td width=20%>([^<]+)<\/td><td><a href="([^"]+)">Details<\/a><\/td><\/tr>/gi;
  for (const match of html.matchAll(rowRegex)) {
    const [, seasonText, gameNumberText, marker, dateText, teamA, outcome, teamB, scoreA, scoreB, venueText, href] = match;
    if (marker === "+") continue;
    const season = Number(seasonText);
    const inferredRoundIndex = (seasonCounters.get(season) ?? 0) + 1;
    seasonCounters.set(season, inferredRoundIndex);
    indexRows.push({
      season,
      gameNumber: Number(gameNumberText),
      roundIndex: inferredRoundIndex,
      marker,
      firstTeam: canonicalOriginTeamName(teamA),
      secondTeam: canonicalOriginTeamName(teamB),
      outcome: normalizeText(outcome).toLowerCase(),
      firstScore: Number(scoreA),
      secondScore: Number(scoreB),
      venue: normalizeText(venueText),
      dateText: normalizeText(dateText),
      detailUrl: new URL(href, SOO_INDEX_URL).toString(),
    });
  }

  return indexRows;
}

function verifyIndexRowAgainstFixture(indexRow, fixture) {
  const teamSet = new Set([fixture.homeTeam, fixture.awayTeam]);
  if (!teamSet.has(indexRow.firstTeam) || !teamSet.has(indexRow.secondTeam)) {
    return false;
  }
  return true;
}

function parseDetailHeader(html) {
  const compact = decodeHtml(html).replace(/\s+/g, " ");
  const headerMatch = compact.match(/Date:\s*(.+?)\s+Venue:\s*(.+?)\s+Attendance:\s*([0-9]+)\s+Referees?:\s*(.+?)\s+Half-Time:/i);
  if (!headerMatch) {
    throw new Error("Unexpected detail header format.");
  }
  return {
    date: normalizeText(headerMatch[1]),
    venue: normalizeText(headerMatch[2]),
    attendance: Number(headerMatch[3]) || 0,
    referee: normalizeText(headerMatch[4]),
  };
}

function enumerateColumnAssignments(values, index = 0, previousColumn = -1, current = [], output = []) {
  if (index >= values.length) {
    output.push([...current]);
    return output;
  }
  for (let column = previousColumn + 1; column <= 3; column += 1) {
    current.push(column);
    enumerateColumnAssignments(values, index + 1, column, current, output);
    current.pop();
  }
  return output;
}

function inferScoringFromTokens(statTokens, season) {
  if (!statTokens.length) {
    return { tries: 0, goals: 0, fg1: 0, fg2: 0 };
  }

  const pointValue = Number(statTokens.at(-1));
  const inputs = statTokens.slice(0, -1).map(Number);
  const tryValue = season >= 1983 ? 4 : 3;
  const fg1Value = 1;

  let best = null;
  for (const assignment of enumerateColumnAssignments(inputs)) {
    let tries = 0;
    let goals = 0;
    let attempts = 0;
    let fg1 = 0;
    for (let i = 0; i < inputs.length; i += 1) {
      const column = assignment[i];
      const value = inputs[i];
      if (column === 0) tries = value;
      else if (column === 1) goals = value;
      else if (column === 2) attempts = value;
      else if (column === 3) fg1 = value;
    }
    if (attempts && !goals) continue;
    if (attempts && goals > attempts) continue;
    const derivedPoints = (tries * tryValue) + (goals * 2) + (fg1 * fg1Value);
    if (derivedPoints !== pointValue) continue;

    const scoreWeight = (tries > 0 ? 4 : 0) + (goals > 0 ? 2 : 0) + (fg1 > 0 ? 1 : 0) - (attempts > 0 ? 0.25 : 0);
    const candidate = { tries, goals, fg1, fg2: 0, scoreWeight };
    if (!best || candidate.scoreWeight > best.scoreWeight) {
      best = candidate;
    }
  }

  if (best) {
    return { tries: best.tries, goals: best.goals, fg1: best.fg1, fg2: 0 };
  }

  throw new Error(`Could not infer scoring columns from tokens: ${statTokens.join(" ")}`);
}

function parsePlayerColumn(text, season) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const rowMatch = trimmed.match(/^([A-Z]{2})\s+(.+?)(?:\s+(\d+(?:\s+\d+)*))?$/);
  if (!rowMatch) return null;
  const [, positionCode, rawName, statsBlob] = rowMatch;
  const playerName = cleanPlayerName(rawName);
  const statTokens = statsBlob ? statsBlob.trim().split(/\s+/).filter(Boolean) : [];
  const scoring = inferScoringFromTokens(statTokens, season);
  return {
    positionCode,
    playerName,
    ...scoring,
  };
}

function cellNumber(value) {
  const text = normalizeText(value);
  if (!text) return 0;
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function parseDetailPage(html, season) {
  const header = parseDetailHeader(html);
  const leftPlayers = [];
  const rightPlayers = [];
  const tableMatch = html.match(/<tr><th width=50% colspan=7>[\s\S]+?<\/table>/i);
  if (!tableMatch) {
    throw new Error("Could not find player stats table.");
  }

  const teamHeaderMatch = tableMatch[0].match(/<tr><th width=50% colspan=7>([^<]+)<\/th><th colspan=7>([^<]+)<\/th><\/tr>/i);
  if (!teamHeaderMatch) {
    throw new Error("Could not determine left/right team headers.");
  }
  const leftTeam = canonicalOriginTeamName(decodeHtml(teamHeaderMatch[1]));
  const rightTeam = canonicalOriginTeamName(decodeHtml(teamHeaderMatch[2]));

  const rowMatches = [...tableMatch[0].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
  for (const rowMatch of rowMatches) {
    const rowHtml = rowMatch[1];
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cellMatch) =>
      normalizeText(decodeHtml(cellMatch[1]))
    );
    if (cells.length !== 14) continue;
    if (cells[0] === "PS" || cells[1] === "Player") continue;
    if (cells[0] === "" && cells[1] === "") continue;
    if (/^Penalties$/i.test(cells[1]) || /^Scrums$/i.test(cells[1])) continue;

    if (!cells[1] && !cells[8]) {
      continue;
    }

    if (cells[1]) {
      leftPlayers.push({
        positionCode: cells[0],
        playerName: cleanPlayerName(cells[1]),
        tries: cellNumber(cells[2]),
        goals: cellNumber(cells[3]),
        fg1: cellNumber(cells[5]),
        fg2: 0,
      });
    }
    if (cells[8]) {
      rightPlayers.push({
        positionCode: cells[7],
        playerName: cleanPlayerName(cells[8]),
        tries: cellNumber(cells[9]),
        goals: cellNumber(cells[10]),
        fg1: cellNumber(cells[12]),
        fg2: 0,
      });
    }
  }

  return {
    header,
    leftTeam,
    rightTeam,
    leftPlayers,
    rightPlayers,
  };
}

function buildFixtureKey(row) {
  return [
    row.season,
    row.homeTeam,
    row.awayTeam,
    row.homeScore,
    row.awayScore,
  ].join("|");
}

async function main() {
  const repPayloads = JSON.parse(await fs.readFile(REP_PAYLOADS_PATH, "utf8"));
  const officialFixtures = parseOfficialFixtures(repPayloads);
  const fixtureBySeasonRound = new Map(officialFixtures.map((row) => [fixtureLookupKey(row.season, row.roundIndex), row]));

  const indexHtml = await fetch(SOO_INDEX_URL).then((response) => {
    if (!response.ok) throw new Error(`Failed to fetch SOO index: ${response.status}`);
    return response.text();
  });
  const indexRows = parseSooIndex(indexHtml);

  const matchedRows = [];
  for (const indexRow of indexRows) {
    const fixture = fixtureBySeasonRound.get(fixtureLookupKey(indexRow.season, indexRow.roundIndex));
    if (!fixture) continue;
    if (!verifyIndexRowAgainstFixture(indexRow, fixture)) continue;
    matchedRows.push({ indexRow, fixture });
  }

  const matchRows = [];
  const playerRows = [];

  for (const { indexRow, fixture } of matchedRows) {
    const detailHtml = await fetch(indexRow.detailUrl).then((response) => {
      if (!response.ok) throw new Error(`Failed to fetch ${indexRow.detailUrl}: ${response.status}`);
      return response.text();
    });
    let detail;
    try {
      detail = parseDetailPage(detailHtml, fixture.season);
    } catch (error) {
      throw new Error(`Failed to parse ${indexRow.detailUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const matchKey = buildMatchKey(fixture.season, fixture.roundLabel, fixture.homeTeam, fixture.awayTeam);

    matchRows.push({
      competition: "SOO",
      season: fixture.season,
      round_label: fixture.roundLabel,
      round_index: fixture.roundIndex,
      match_key: matchKey,
      date: detail.header.date,
      home: fixture.homeTeam,
      away: fixture.awayTeam,
      home_score: fixture.homeScore,
      away_score: fixture.awayScore,
      venue: detail.header.venue,
      attendance: detail.header.attendance,
      referee: detail.header.referee,
      url_afltables: indexRow.detailUrl,
      url_nrl: fixture.urlNrl,
    });

    if (!new Set([fixture.homeTeam, fixture.awayTeam]).has(detail.leftTeam) || !new Set([fixture.homeTeam, fixture.awayTeam]).has(detail.rightTeam)) {
      throw new Error(
        `Detail page team headers did not match fixture teams for ${matchKey}: ${detail.leftTeam} / ${detail.rightTeam} vs ${fixture.homeTeam} / ${fixture.awayTeam}`
      );
    }

    for (const player of detail.leftPlayers) {
      playerRows.push({
        match_key: matchKey,
        year: fixture.season,
        round: fixture.roundLabel,
        home: fixture.homeTeam,
        away: fixture.awayTeam,
        team: detail.leftTeam,
        player: player.playerName,
        tries: player.tries,
        goals: player.goals,
        fg1: player.fg1,
        fg2: 0,
        date: detail.header.date,
        url: indexRow.detailUrl,
      });
    }

    for (const player of detail.rightPlayers) {
      playerRows.push({
        match_key: matchKey,
        year: fixture.season,
        round: fixture.roundLabel,
        home: fixture.homeTeam,
        away: fixture.awayTeam,
        team: detail.rightTeam,
        player: player.playerName,
        tries: player.tries,
        goals: player.goals,
        fg1: player.fg1,
        fg2: 0,
        date: detail.header.date,
        url: indexRow.detailUrl,
      });
    }
  }

  await fs.mkdir(path.dirname(SOO_AFLTABLES_MATCHES_CSV), { recursive: true });
  await fs.writeFile(SOO_AFLTABLES_MATCHES_CSV, toCsv(MATCH_HEADER, matchRows), "utf8");
  await fs.writeFile(SOO_AFLTABLES_PLAYER_STATS_CSV, toCsv(PLAYER_HEADER, playerRows), "utf8");

  console.log("SOO AFL Tables matches:", SOO_AFLTABLES_MATCHES_CSV);
  console.log("SOO AFL Tables player rows:", SOO_AFLTABLES_PLAYER_STATS_CSV);
  console.log("Matched fixtures:", matchRows.length);
  console.log("Player rows:", playerRows.length);
}

await main();
