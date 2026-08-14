# RLDB direct-Node handoff

Updated: 2026-08-14 (Australia/Brisbane)

## Start here

This is an appropriate handoff point. No benchmark is running. Both the
operational backend and candidate are healthy and idle. Do not begin by
reopening old performance investigations: resolve the two current cutover
gates, finish bounded comparison testing, then prepare the reversible routing
change.

The installed query-engine release is commit `17c6272` from `main`. This
repository has no Git remote configured. The installed release is
`17c62726e5c202b6fd119a5fa28561ff5c2d3876-clean`.

## Architecture and source boundaries

### Operational production system

- Public UI/API: Cloudflare Worker at `https://rldb.drein.net`.
- Source: `C:\Users\d2rei\My_Site\rugby-league-stats-db-local`, branch
  `local/local-server-2026-06-08`.
- The Worker serves the UI and proxies eligible API calls using
  `REMOTE_QUERY_ORIGIN=https://rldb-origin.drein.net` from its
  `wrangler.toml`.
- `rldb-origin.drein.net` is a Cloudflare Tunnel ingress to
  `http://127.0.0.1:8797`.
- Port 8797 is the local Wrangler/Miniflare/workerd backend querying its local
  D1-compatible SQLite database. Telemetry is on port 8798.
- The operational repository is currently dirty with expected runtime logs,
  generated benchmark artifacts, one reconciled source-data change, and the
  varied-suite generator. Do not clean, stash, reset, or commit those items as
  part of candidate work.

### Direct-Node candidate

- Source: `C:\Users\d2rei\My_Site\rldb-direct-node` (this repository).
- `src/application/worker.ts` is the application, API, query engine, and inline
  frontend adapted from the operational Worker.
- `src/node/server.ts` is a loopback-only Node HTTP supervisor for one serial
  query worker; `src/node/request-worker.ts` invokes the application; and
  `src/node/sqlite-d1.mjs` provides the D1-compatible SQLite API.
- `scripts/build.mjs` bundles server and request worker with esbuild for
  Node 24.
- Installed runtime: `C:\RLDB`, scheduled task
  `RLDB-Direct-Node-Supervisor`, restricted account
  `DESKTOP-ASRAPT8\rldbsvc`.
- Backend: `127.0.0.1:8899`; telemetry: `127.0.0.1:8890`; test site:
  `https://rldb-test.drein.net` through its separate supervised tunnel.
- Live candidate database: `C:\RLDB\data\rldb.sqlite`; a successful promotion
  normally retains its immediate rollback at
  `C:\RLDB\data\previous\rldb.sqlite`; persistent telemetry:
  `C:\RLDB\telemetry\query-performance.sqlite`.
- Runtime data, credentials, logs, reports, databases, generated `dist`, and
  scraped payloads are deliberately outside Git or ignored.

The API surface retained from the Worker includes `/api/health`,
`/api/meta/bootstrap`, `/api/meta/players`, `/api/meta/regression-suite`,
`/api/query`, `/api/query/full`, `/api/export`, `/api/player-profile`,
`/api/player-rank-cards`, `/api/match-detail`, and `/api/season-index`.
Authentication/audit endpoints remain in the application but must not be
confused with public query routes.

Core SQLite data is split among dimension tables (`competitions`, `matches`,
`players`, `teams`, and venues), EAV stat tables (`player_match_stat_values`
and `team_match_stat_values`), canonical JSON summaries
(`player_match_summary` and `team_match_summary`), and persisted aggregate
tables (`player_stat_aggregates` and `team_season_aggregates`). Application
migrations add measured lookup/index structures without replacing those
authoritative tables.

The candidate owns an independent database seeded once from the operational
database. Its updater fetches and imports NRL and NRLW into a staging SQLite
copy, validates it, checkpoints its WAL, briefly stops the candidate for file
promotion, retains one previous database, and rolls back after a failed health
check. See `docs/SERVICE_RUNBOOK.md` and `scripts/update/weekly-update.mjs`.
The supervisor schedules this each Monday at 1:00 AM local time; representative
SOO/WSOO data is present but is not part of that automatic NRL/NRLW fetch path.

At handoff both APIs report the same cutoff: NRL Round 22, NRLW Round 5, SOO
Game 2, and WSOO Game 3 for 2026.

## Candidate query-engine work

The current line is not merely the operational code with Wrangler removed.
It preserves the API while moving expensive generic query classes onto direct
SQLite paths:

- aggregate conditions are pushed into SQL before ranking and limiting;
- broad player totals use canonical `player_match_summary` rows rather than
  repeatedly scanning EAV values;
- migrations `migrations/application/0009_player_match_query_components.sql`
  and
  `migrations/application/0010_normalize_query_component_presence.sql`
  persist frequently used JSON
  components and keep them synchronized with triggers;
- grouped ranking and pagination occur in SQLite while retaining complete
  result groups;
- safe games-played leaderboards retain persisted aggregate routing and their
  compatibility fields;
- derived player points at match level materialize tries, goals, one- and
  two-point field goals and apply every condition before ranking;
- team/opponent filtering uses retained migration
  `migrations/application/0008_team_opponent_lookup.sql`;
- an unused opponent join was removed from generic team match streaks;
- the Node server queues analytical requests serially, cancels abandoned
  requests, and replaces the worker after a 150-second server-side limit so a
  pathological query cannot wedge later searches.

Important recent commits are `2b904c1`, `d8cdc03`, `0961dd4`, `84de0bf`,
`24f25ed`, and `17c6272`. `164e0f1` was an intermediate semantic rollback;
`17c6272` is the reviewed final behavior for derived match points.

## The varied 100-query shakedown

The source list is `C:\Users\d2rei\Downloads\nrl_new_varied_queries_100.txt`.
The reproducible case generator and 99-case JSON are currently in the
operational workspace:

- `scripts/build-varied-holdout-cases.mjs`
- `benchmark/new-varied-cases-2026-08-14.json`
- `reports/benchmarks/new-varied-100-feasibility-2026-08-14.md`

Query 10 is intentionally omitted because it combines historical aliases
`Stadium Australia` and `Accor Stadium`; the builder currently accepts one
venue and does not canonicalize aliases. Pretending one name answers the
combined question would be a semantic error.

### Earlier direct comparison

The first partial runs compared 76 common cases:

- 67 exact normalized matches;
- nine superficial differences involving compatibility columns,
  `included_games`, or equal-value ties at the result boundary;
- zero semantic leaderboard differences;
- candidate first observations: 297.2 seconds versus 452.1 operational
  (1.52x faster);
- candidate repeats: 264.4 seconds versus 443.0 operational (1.68x faster).

Those runs exposed broad slow classes, leading to the SQL pushdown, compact
component projection, summary routing, derived-points correction, and worker
recovery changes above.

### Final candidate-only rerun

The latest run used one first observation and one repeat against port 8899.
It completed case IDs 1-9 and 11-72: **71 cases, 142 requests, zero errors**.
It did not crash on query 73. The outer command had a 1,000-second lifetime and
terminated the benchmark between cases 72 and 73; no request for case 73 was
recorded.

For those 71 cases:

| Observation | Sum | Median | Maximum |
| --- | ---: | ---: | ---: |
| First | 77.81 s | 234 ms | 9.49 s |
| Repeat | 61.82 s | 211 ms | 4.49 s |

The persisted partial run is
`rugby-league-stats-db-local/runtime-data/benchmarks/new-varied-final-candidate-2026-08-14.sqlite`
(runtime artifact, not source). Query 100 was then run directly:

- longest consecutive away winning streak against one opponent;
- HTTP 200 in 209 ms;
- St George Dragons, 16 away wins against Newtown Jets, 1957 Round 8 through
  1972 Round 18;
- candidate remained healthy and idle afterward.

This is encouraging but **not** a complete post-fix 99-case comparison. Do not
describe it as one. Add bounded case selection/batching to the benchmark
harness, or generate small case files, before finishing cases 73-100 and a
same-cutoff operational comparison. A run being captured as its own baseline
only proves successful/stable responses; correctness requires comparison with
an independent reference.

## Current cutover blockers

### 1. Independent updater needs a successful promotion check

`C:\RLDB\control\rldb-status.ps1` currently reports the last update state as
`rolled_back` at `2026-08-10T14:00:46Z`. The served database is healthy and at
the same Round 22 cutoff as operational, but do not rely on the weekly task for
production until a manual update reaches a successful terminal state and its
health/rollback behavior is reviewed. The rollback consumed the retained
`previous\rldb.sqlite`, so there is no current immediate candidate database
rollback until the next successful promotion creates one.

### 2. Current-season import has parity differences

The 2026-08-14 functional parity run passed bootstrap, leading tries, player
rank cards, and season index. It found:

- candidate player options: 8,647 versus 8,632 operational; the 15 candidate-
  only names are Alex Conti, Hayden Watson, Jai Bowden, Jared Haywood,
  Javon Andrews, Joshua Coric, Kalani Leuluai-Going, Lachlan Crouch, Luke Gale,
  Onitoni Large, Sam Elliott, Siale Faeamani, Toby Winter, Zaidas Muagututia,
  and Zakauri Clarke;
- candidate current-season player and match-detail `stats_json` rows omit
  `career_first_match_id`/`career_last_match_id` compatibility fields that are
  present operationally.

The extra names may be valid additions from the independent importer; audit
their rows and source before deciding. The missing career IDs are a real
semantic issue because `src/application/worker.ts` uses them for the
`career_debut` and `last_career_match` filters. Fix the importer to recompute or
preserve them, update a disposable database first, reinstall, and rerun parity.

## Correctness invariants

- Conditions apply at the requested row/group level before ranking and limit.
  Do not fetch a top-N set and then filter it in application code.
- Match conditions must be evaluated per match. Season/career conditions must
  be evaluated after aggregation at that grouping level.
- Derived statistics must expand every recipe component required by the
  selected stat and condition stats. For example, "most points in a match with
  exactly one try and at least five goals" correctly produces a 28-point
  leader. The old operational fallback produced Dave Brown on 50 because it
  applied conditions to rows that did not contain tries/goals, effectively
  ignoring them. Matching that faster-looking output would reintroduce a bug.
- Missing and zero are not interchangeable for every stat. In particular,
  `minutes_played_present` distinguishes absent historical minutes from a real
  zero; migration 0010 and its triggers preserve that distinction.
- Preserve `games`, `included_games`, raw selected-stat fields, group columns,
  complete pagination, and stable compatibility response shapes.
- Equal-valued tied rows may appear in a different order unless a meaningful
  secondary sort exists. Normalize ties before reporting a correctness failure.
- The operational backend is a valuable reference, not unquestionable truth.
  Investigate disagreements using database rows and query semantics.

## Performance lessons

- The worst old paths combined broad EAV scans, repeated JSON extraction,
  application-side aggregation/filtering, and limits applied at the wrong
  stage. Push generic aggregation and conditions into SQL and read persisted
  summaries/components.
- Keep optimizations capability-based. Do not add bespoke branches for named
  benchmark questions.
- Avoid joins that do not contribute filters or output. A redundant opponent
  self-join made broad streak queries pathological.
- Direct Node removes Wrangler/workerd overhead, but most large wins came from
  query shape and persisted summaries, not hosting alone.
- Cold caches matter. Compare first and repeated observations separately.
- The index audit retained only `(team_id, season, opponent_team_id)` because
  it produced a measured large lookup improvement for little storage. The
  proposed player-summary and matches indexes were rejected as redundant or
  ineffective. See `docs/INDEX_AUDIT_2026-08-03.md`.
- A cancelled client must not leave SQLite work monopolizing the server. Keep
  request cancellation, the serial queue, independent health endpoint, and
  replaceable query worker.

## Validation and commands

Run from `C:\Users\d2rei\My_Site\rldb-direct-node` unless noted.

```powershell
git status --short --branch
npm.cmd test
npm.cmd run build
C:\RLDB\control\rldb-status.ps1
C:\RLDB\control\rldb-logs.ps1
```

Candidate/operational endpoint parity (do not put the real password in docs or
Git):

```powershell
$env:RLDB_SITE_PASSWORD = '<shared-site-password>'
npm.cmd run parity
Remove-Item Env:RLDB_SITE_PASSWORD
```

The parity script is sequential because parallel cold analytical requests can
reset or wedge the operational Wrangler backend. Candidate-only smoke testing
uses `npm.cmd run smoke` against a development instance without the installed
site-password gate; installed/public checks need authenticated requests.

Install an accepted committed candidate release from an **elevated**
PowerShell. The installer builds first, applies migrations while the candidate
is stopped, retains task credentials/data/configuration, and verifies both
health endpoints:

```powershell
cd C:\Users\d2rei\My_Site\rldb-direct-node
powershell -ExecutionPolicy Bypass -File .\scripts\service\install-rldb-service.ps1
```

Routine controls do not need elevation:

```powershell
C:\RLDB\control\rldb-start.ps1
C:\RLDB\control\rldb-stop.ps1
C:\RLDB\control\rldb-restart.ps1
C:\RLDB\control\rldb-update.ps1
C:\RLDB\control\rldb-status.ps1
C:\RLDB\control\rldb-logs.ps1
```

Telemetry report example (the installed telemetry database is intentionally
ACL-restricted; run with an account that has read access or report from an
approved copy):

```powershell
npm.cmd run telemetry:report -- --database C:\RLDB\telemetry\query-performance.sqlite --days 30
```

The benchmark harness currently lives in the operational workspace at
`scripts/run-query-benchmark.mjs`; its durable suite intent and normalization
rules are described in that repository's benchmark files. Keep runtime output
under ignored `runtime-data/` and `reports/` paths.

## Reversible switchover path

1. Fix and validate current-season career metadata; explain the 15 player-name
   additions.
2. Request a candidate update, observe a successful promotion, verify NRL and
   NRLW freshness, run representative match/half/team/player queries, and
   confirm rollback remains available.
3. Complete the varied suite in bounded batches and produce a current
   candidate-versus-operational correctness/performance report at the same
   cutoff. Require zero unexplained semantic differences and no service wedge.
4. Perform user acceptance on `https://rldb-test.drein.net`, including player,
   match, season, full-results, export, authentication, and mobile flows.
5. Prepare a dedicated candidate **origin** tunnel hostname and backend token.
   The public Worker should remain the authentication/UI layer and change only
   its remote API origin/token. Do not naively point it at the current test
   hostname: the candidate test site has its own session secret, so a public
   Worker session cookie is not automatically valid there. Either add a
   narrowly scoped valid-backend-token bypass for proxy-eligible API paths
   before site-session enforcement, or deliberately share the same session
   secret; the token bypass is the cleaner separation and must be tested.
6. Commit the operational Worker configuration change, deploy through its
   documented procedure, then verify public UI, authentication, APIs, exports,
   telemetry, and update status.
7. Keep `rldb-origin.drein.net`, port 8797, its database, and its scheduled
   updater intact during an observation period. Rollback is a Worker
   `REMOTE_QUERY_ORIGIN`/`REMOTE_QUERY_TOKEN` redeploy to the old origin; it
   must not require a database restore or candidate uninstall.

Do not delete or repurpose the operational tunnel/database during cutover.
Do not change `rldb.drein.net` routing until the user approves after reviewing
the final comparison.

## Recommended next actions

1. Fix the independent importer so career first/last match IDs survive a
   current-season rebuild; audit the 15 candidate-only players.
2. Prove one successful manual candidate update and rerun endpoint parity.
3. Add bounded batch/case selection to the benchmark harness and finish the
   same-cutoff 99-case comparison without an outer-command timeout.
4. Complete test-host acceptance and implement the authenticated origin-proxy
   arrangement required for a one-variable, easily reversible Worker switch.
5. Present the final evidence and rollback command to the user before changing
   production routing.
