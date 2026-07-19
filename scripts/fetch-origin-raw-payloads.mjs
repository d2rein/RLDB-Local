import fs from "node:fs/promises";
import path from "node:path";
import { DOCS_DIR } from "./lib/project-paths.mjs";

const REP_DIR = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data", "REP");
const MANIFEST_PATH = path.join(REP_DIR, "rep_match_centres.json");
const OUTPUT_PATH = path.join(REP_DIR, "rep_match_payloads.json");

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

function extractQDataPayload(htmlText) {
  const matchCentre = htmlText.match(/<div[^>]+id="vue-match-centre"[^>]+q-data="([^"]+)"[^>]*>/i);
  if (!matchCentre) return null;
  try {
    return JSON.parse(decodeHtmlEntities(matchCentre[1]));
  } catch {
    return null;
  }
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

const cliArgs = parseCliArgs(process.argv);
const includeCodes = new Set(
  String(cliArgs.get("competitions") ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)
);

const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
const fixtures = (manifest.fixtures ?? []).filter((fixture) =>
  includeCodes.size === 0 || includeCodes.has(String(fixture.competitionCode ?? "").toUpperCase())
);

const payloads = [];
const failures = [];

for (const fixture of fixtures) {
  const response = await fetchText(fixture.url);
  if (!response.ok || !response.text) {
    failures.push({
      competitionCode: fixture.competitionCode,
      season: fixture.season,
      gameNumber: fixture.gameNumber,
      url: fixture.url,
      status: response.status,
      error: response.error ?? null,
    });
    continue;
  }

  const payload = extractQDataPayload(response.text);
  if (!payload?.match) {
    failures.push({
      competitionCode: fixture.competitionCode,
      season: fixture.season,
      gameNumber: fixture.gameNumber,
      url: fixture.url,
      status: response.status,
      error: "missing_q_data",
    });
    continue;
  }

  payloads.push({
    fixture,
    payload,
  });
}

const output = {
  generatedAtUtc: new Date().toISOString(),
  requestedFixtures: fixtures.length,
  payloadCount: payloads.length,
  failureCount: failures.length,
  payloads,
  failures,
};

await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`Wrote ${payloads.length} raw payloads to ${OUTPUT_PATH}`);
if (failures.length > 0) {
  console.log(`Encountered ${failures.length} failures.`);
}
