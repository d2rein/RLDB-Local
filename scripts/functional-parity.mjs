import crypto from "node:crypto";

const operational = String(process.env.RLDB_OPERATIONAL_BASE_URL || "http://127.0.0.1:8797").replace(/\/$/, "");
const candidate = String(process.env.RLDB_CANDIDATE_BASE_URL || "http://127.0.0.1:8899").replace(/\/$/, "");
const sitePassword = String(process.env.RLDB_SITE_PASSWORD || "");
const requestTimeoutMs = 135000;
const sessionCookies = new Map();

const cases = [
  { name: "bootstrap", path: "/api/meta/bootstrap" },
  { name: "players", path: "/api/meta/players" },
  {
    name: "leading tries",
    path: "/api/query?scope=player&competition=NRL&statKey=tries&mode=totals&format=overall&seasonFrom=1908&seasonTo=2026&limit=10&page=1&pageSize=10",
  },
  {
    name: "player profile",
    path: "/api/player-profile?player=Alex%20Johnston&competition=NRL",
  },
  {
    name: "player rankings",
    path: "/api/player-rank-cards?player=Billy%20Slater&competition=NRL",
  },
  {
    name: "season index",
    path: "/api/season-index?competition=NRL&season=2026",
  },
];

let failures = 0;
let candidateSeason = null;
for (const parityCase of cases) {
  try {
    // Run sequentially because the operational Wrangler service handles
    // analytical requests serially and can reset under parallel cold queries.
    const expected = await fetchJson(`${operational}${parityCase.path}`);
    const actual = await fetchJson(`${candidate}${parityCase.path}`);
    if (parityCase.name === "season index") candidateSeason = actual;
    compare(parityCase.name, expected, actual);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${parityCase.name}: ${error.message}`);
  }
}

const matchId = Number(candidateSeason?.rows?.[0]?.match_id);
if (!Number.isFinite(matchId) || matchId <= 0) {
  failures += 1;
  console.log("FAIL match detail: no match ID was available from the candidate season index.");
} else {
  const path = `/api/match-detail?matchId=${matchId}`;
  try {
    const expected = await fetchJson(`${operational}${path}`);
    const actual = await fetchJson(`${candidate}${path}`);
    compare(`match detail ${matchId}`, expected, actual);
  } catch (error) {
    failures += 1;
    console.log(`FAIL match detail ${matchId}: ${error.message}`);
  }
}

if (failures > 0) {
  throw new Error(`${failures} functional parity check(s) failed.`);
}

function compare(name, expected, actual) {
  const expectedJson = JSON.stringify(canonical(normalizeForComparison(name, expected)));
  const actualJson = JSON.stringify(canonical(normalizeForComparison(name, actual)));
  const passed = expectedJson === actualJson;
  if (!passed) failures += 1;
  console.log(
    `${passed ? "PASS" : "FAIL"} ${name} operational=${hash(expectedJson)} candidate=${hash(actualJson)}`
  );
  if (!passed) {
    console.log(`  operational bytes=${expectedJson.length}, candidate bytes=${actualJson.length}`);
    const difference = firstDifference(
      canonical(normalizeForComparison(name, expected)),
      canonical(normalizeForComparison(name, actual))
    );
    if (difference) {
      console.log(`  first difference at ${difference.path}`);
      console.log(`  operational=${JSON.stringify(difference.expected).slice(0, 500)}`);
      console.log(`  candidate=${JSON.stringify(difference.actual).slice(0, 500)}`);
    }
  }
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const started = performance.now();
      let response = await fetchWithSession(url);
      if (response.status === 401 && sitePassword) {
        await authenticate(new URL(url).origin);
        response = await fetchWithSession(url);
      }
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      console.log(`  ${new URL(url).origin} ${Math.round(performance.now() - started)}ms`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`${url} failed after 3 attempts: ${lastError?.message || lastError}`);
}

async function fetchWithSession(url) {
  const origin = new URL(url).origin;
  const cookie = sessionCookies.get(origin);
  return fetch(url, {
    headers: {
      "x-rldb-query-source": "development-parity",
      ...(cookie ? { cookie } : {}),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

async function authenticate(origin) {
  if (!sitePassword) throw new Error(`${origin} requires authentication but RLDB_SITE_PASSWORD is not set.`);
  const response = await fetch(`${origin}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: sitePassword, next: "/" }),
    signal: AbortSignal.timeout(30000),
  });
  const cookie = (response.headers.get("set-cookie") || "").split(";", 1)[0];
  if (response.status !== 302 || !cookie) {
    throw new Error(`${origin} login failed with HTTP ${response.status}.`);
  }
  sessionCookies.set(origin, cookie);
}

function normalizeForComparison(name, value) {
  if (name !== "bootstrap" || !value?.filterOptions) return value;
  return {
    ...value,
    app: value.app
      ? {
          ...value.app,
          // This describes the host implementation, not the underlying data.
          status: "normalized-runtime-status",
        }
      : value.app,
    filterOptions: {
      ...value.filterOptions,
      // Both complete player lists are compared through /api/meta/players.
      players: [],
    },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function firstDifference(expected, actual, path = "$") {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return { path: `${path}.length`, expected: expected.length, actual: actual.length };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (
    expected && actual
    && typeof expected === "object"
    && typeof actual === "object"
    && !Array.isArray(expected)
    && !Array.isArray(actual)
  ) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (!(key in expected) || !(key in actual)) {
        return { path: `${path}.${key}`, expected: expected[key], actual: actual[key] };
      }
      const difference = firstDifference(expected[key], actual[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return { path, expected, actual };
}
