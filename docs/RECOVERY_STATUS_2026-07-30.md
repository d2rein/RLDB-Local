# Direct Node Recovery Status - 2026-07-30

This file records the implementation state recovered after the conversation
history unexpectedly regressed. The filesystem work was not lost.

## Operational system

The current public system was not modified or restarted:

- source: `C:\Users\d2rei\My_Site\rugby-league-stats-db-local`
- backend: `127.0.0.1:8797`
- telemetry: `127.0.0.1:8798`
- public site: `https://rldb.drein.net`
- weekly updater: unchanged

Both operational health endpoints returned HTTP 200 after candidate testing.

## Isolated candidate

- source: `C:\Users\d2rei\My_Site\rldb-direct-node`
- runtime: `C:\Users\d2rei\My_Site\rldb-direct-node-runtime`
- backend: `127.0.0.1:8899`
- telemetry: `127.0.0.1:8890`
- database: `rldb-direct-node-runtime\data\rldb.sqlite`

The database is an independent SQLite copy seeded from the operational data.
It passed `PRAGMA integrity_check` and contains the expected core tables.

The candidate uses Node's SQLite API through a small D1-compatible adapter.
Wrangler, Miniflare, workerd, and file watchers are not part of candidate query
execution.

## Verification

Completed successfully:

- D1 adapter unit tests
- health endpoint
- metadata bootstrap
- complete player-list endpoint
- leading-try-scorers query
- player-profile endpoint
- season-index endpoint
- match-detail parity
- full SQLite integrity check

Exact parity was confirmed for player-list, season-index, and match-detail
responses. Bootstrap comparison ignores the runtime status label and the
truncated player list because the complete list has its own exact comparison.

The existing Wrangler service reset local HTTP connections during repeated
expensive parity requests. It recovered without a restart and remained healthy.
This prevents claiming that the entire parity suite has completed, but it did
not indicate a candidate failure.

## Not yet complete

- no benchmark has been started against the candidate
- no Cloudflare Tunnel test hostname has been assigned
- no independent weekly updater has been configured
- no production route has been changed

## Restricted service installed - 2026-07-31

The direct-Node candidate is installed independently at `C:\RLDB`:

- task: `RLDB-Direct-Node-Supervisor`
- task state: running
- task account: `DESKTOP-ASRAPT8\rldbsvc`
- logon type: Windows Task Scheduler protected password credential
- run level: limited
- installed release: `2ac17c09a010321ab174734b1963300f0d6026b5-clean`
- database: `C:\RLDB\data\rldb.sqlite`

An elevated ownership audit confirmed the supervisor, backend, and telemetry
processes are all owned by `rldbsvc`. The primary account can use the narrowly
scoped control scripts in `C:\RLDB\control` and has read-only data access.
The service account cannot access unrelated personal or development files.

A candidate-only restart stopped and recreated both child processes, restored
health in under ten seconds, and left operational port `8797` healthy.
Representative installed-service checks passed for bootstrap, player profile,
season index, player match tries, and first-half team points.

The complete smoke runner exceeded its outer three-minute limit on the
all-time leading-tries path. The candidate remained alive but its synchronous
SQLite request blocked queued HTTP health checks until the candidate-only
restart. This is a benchmark/performance finding, not a production incident,
and must be measured before any cutover.

The next safe steps are to benchmark the installed candidate, implement its
independent weekly updater, and expose it only through a separate test route.
Production remains the rollback system throughout testing.
