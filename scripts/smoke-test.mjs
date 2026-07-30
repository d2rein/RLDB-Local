const baseUrl = String(process.env.RLDB_TEST_BASE_URL || "http://127.0.0.1:8899").replace(/\/$/, "");
const operationalUrl = "http://127.0.0.1:8797";

if (baseUrl === operationalUrl) {
  throw new Error("Smoke tests refuse to target the operational service.");
}

const checks = [
  { name: "health", path: "/api/health", validate: (body) => body.ok && body.database?.reachable },
  { name: "bootstrap", path: "/api/meta/bootstrap", validate: (body) => body.app && body.statDefinitions?.length > 0 },
  { name: "players", path: "/api/meta/players", validate: (body) => body.ok && body.players?.length > 100 },
  {
    name: "leading tries",
    path: "/api/query?scope=player&competition=NRL&statKey=tries&mode=totals&format=overall&seasonFrom=1908&seasonTo=2026&limit=10&page=1&pageSize=10",
    validate: (body) => body.ok && body.rows?.length > 0,
  },
  {
    name: "player detail",
    path: "/api/player-profile?player=Alex%20Johnston&competition=NRL",
    validate: (body) => body.ok && body.matchRows?.length > 0,
  },
  {
    name: "season index",
    path: "/api/season-index?competition=NRL&season=2026",
    validate: (body) => body.ok && body.rows?.length > 0,
  },
];

let failures = 0;
for (const check of checks) {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${check.path}`, {
      headers: { "x-rldb-query-source": "development-smoke" },
      signal: AbortSignal.timeout(135000),
    });
    const text = await response.text();
    const body = JSON.parse(text);
    const passed = response.ok && check.validate(body);
    if (!passed) failures += 1;
    console.log(`${passed ? "PASS" : "FAIL"} ${check.name} ${response.status} ${Math.round(performance.now() - started)}ms`);
    if (!passed) console.log(text.slice(0, 1000));
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${check.name} ${Math.round(performance.now() - started)}ms ${error.message}`);
  }
}

if (failures > 0) {
  throw new Error(`${failures} smoke test(s) failed.`);
}
