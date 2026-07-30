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
- no service has been installed under `rldbsvc`
- no automatic startup or crash recovery has been configured
- no production route has been changed

The next safe step is to install this verified source as a separate restricted
account service and expose it only on a separate test route. Production remains
the rollback system throughout testing.
