import fs from "node:fs/promises";
import path from "node:path";
import { DOCS_DIR } from "./lib/project-paths.mjs";

const OUTPUT_DIR = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data", "REP");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "rep_match_centres.json");

const COMPETITIONS = [
  {
    code: "SOO",
    name: "Ampol State of Origin",
    path: "state-of-origin",
    seasonFrom: 1980,
    seasonTo: new Date().getUTCFullYear(),
    maxGames: 4,
    roundKinds: ["round", "game"],
    separators: ["v", "vs"],
    slugPairs: [
      ["maroons", "blues"],
      ["blues", "maroons"],
    ],
  },
  {
    code: "WSOO",
    name: "Ampol Women's State of Origin",
    path: "womens-state-of-origin",
    seasonFrom: 1999,
    seasonTo: new Date().getUTCFullYear(),
    maxGames: 3,
    roundKinds: ["round", "game"],
    separators: ["v", "vs"],
    slugPairs: [
      ["maroons", "sky-blues"],
      ["sky-blues", "maroons"],
      ["maroons", "blues-women"],
      ["blues-women", "maroons"],
      ["maroons", "blues"],
      ["blues", "maroons"],
    ],
  },
];

function parseCliArgs(argv) {
  const options = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      options.set(key, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, "1");
    }
  }
  return options;
}

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractMatchPayload(htmlText) {
  const matchCentre = htmlText.match(/<div[^>]+id="vue-match-centre"[^>]+q-data="([^"]+)"[^>]*>/i);
  if (!matchCentre) return null;
  try {
    const payload = JSON.parse(decodeHtmlEntities(matchCentre[1]));
    return payload?.match ?? null;
  } catch {
    return null;
  }
}

function normalizeTeamName(rawName) {
  return String(rawName ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildUrl(competitionPath, season, roundKind, gameNumber, homeSlug, awaySlug, separator = "v") {
  return `https://www.nrl.com/draw/${competitionPath}/${season}/${roundKind}-${gameNumber}/${homeSlug}-${separator}-${awaySlug}/`;
}

function inferHomeDisplayName(matchPayload, fallbackSlug) {
  return normalizeTeamName(
    matchPayload?.homeTeam?.nickName
      ?? matchPayload?.homeTeam?.name
      ?? fallbackSlug.replace(/-/g, " ")
  );
}

function inferAwayDisplayName(matchPayload, fallbackSlug) {
  return normalizeTeamName(
    matchPayload?.awayTeam?.nickName
      ?? matchPayload?.awayTeam?.name
      ?? fallbackSlug.replace(/-/g, " ")
  );
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, url };
    }
    return { ok: true, status: response.status, url, text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, url, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timeout);
  }
}

function buildFixtureRecord({ competition, season, gameNumber, roundKind, url, matchPayload, discoveredHomeSlug, discoveredAwaySlug }) {
  const matchId = Number(matchPayload?.matchId ?? matchPayload?.id ?? 0) || null;
  const roundTitle = normalizeTeamName(matchPayload?.roundTitle ?? `${roundKind} ${gameNumber}`);
  const homeDisplay = inferHomeDisplayName(matchPayload, discoveredHomeSlug);
  const awayDisplay = inferAwayDisplayName(matchPayload, discoveredAwaySlug);
  const kickoff = normalizeTeamName(matchPayload?.clock?.kickOffTimeLong ?? matchPayload?.clock?.kickOffTime ?? "");
  const venue = normalizeTeamName(matchPayload?.venue ?? "");
  return {
    competitionCode: competition.code,
    competitionName: competition.name,
    season,
    gameNumber,
    roundKind,
    roundLabel: roundTitle,
    matchId,
    homeTeam: homeDisplay,
    awayTeam: awayDisplay,
    kickoff,
    venue,
    url,
  };
}

function fixtureSortKey(fixture) {
  return [
    fixture.competitionCode,
    String(fixture.season).padStart(4, "0"),
    String(fixture.gameNumber).padStart(2, "0"),
    fixture.url,
  ].join("|");
}

async function discoverCompetitionFixtures(competition) {
  const discovered = new Map();

  for (let season = competition.seasonFrom; season <= competition.seasonTo; season += 1) {
    for (let gameNumber = 1; gameNumber <= competition.maxGames; gameNumber += 1) {
      let foundForGame = false;

      for (const roundKind of competition.roundKinds) {
        for (const separator of competition.separators ?? ["v"]) {
          for (const [homeSlug, awaySlug] of competition.slugPairs) {
            const url = buildUrl(competition.path, season, roundKind, gameNumber, homeSlug, awaySlug, separator);
            const response = await fetchText(url);
            if (!response.ok || !response.text) continue;

            const matchPayload = extractMatchPayload(response.text);
            if (!matchPayload) continue;

            const record = buildFixtureRecord({
              competition,
              season,
              gameNumber,
              roundKind,
              url,
              matchPayload,
              discoveredHomeSlug: homeSlug,
              discoveredAwaySlug: awaySlug,
            });

            const dedupeKey = record.matchId ? `${competition.code}|${record.matchId}` : fixtureSortKey(record);
            if (!discovered.has(dedupeKey)) {
              discovered.set(dedupeKey, record);
            }
            foundForGame = true;
            break;
          }
          if (foundForGame) break;
        }
        if (foundForGame) break;
      }
    }
  }

  return [...discovered.values()].sort((left, right) => fixtureSortKey(left).localeCompare(fixtureSortKey(right)));
}

const cliArgs = parseCliArgs(process.argv);
const includeCodes = new Set(
  String(cliArgs.get("competitions") ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)
);

const selectedCompetitions = includeCodes.size > 0
  ? COMPETITIONS.filter((competition) => includeCodes.has(competition.code))
  : COMPETITIONS;

await fs.mkdir(OUTPUT_DIR, { recursive: true });

const results = [];
for (const competition of selectedCompetitions) {
  console.log(`Discovering ${competition.code} fixtures...`);
  const fixtures = await discoverCompetitionFixtures(competition);
  results.push(...fixtures);
  console.log(`Found ${fixtures.length} ${competition.code} fixtures.`);
}

const groupedCounts = Object.fromEntries(
  selectedCompetitions.map((competition) => [
    competition.code,
    results.filter((fixture) => fixture.competitionCode === competition.code).length,
  ])
);

const payload = {
  generatedAtUtc: new Date().toISOString(),
  counts: groupedCounts,
  fixtures: results,
};

await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`Wrote ${results.length} fixtures to ${OUTPUT_PATH}`);
