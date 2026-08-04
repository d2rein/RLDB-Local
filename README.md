# RLDB Direct Node

Clean replacement implementation for the Rugby League Stats Database.

This repository will run the existing RLDB application directly on Node.js and
SQLite. It will not use Wrangler, Miniflare, workerd, esbuild watchers, D1, or a
Cloudflare Worker for query execution. Cloudflare Tunnel will remain the only
public transport and will proxy to a server bound to `127.0.0.1`.

## Current status

The isolated candidate is functional and installed as a restricted Windows
scheduled task. It runs the existing RLDB application directly on Node.js and
an independent SQLite database:

- candidate backend: `127.0.0.1:8899`
- candidate telemetry: `127.0.0.1:8890`
- install root: `C:\RLDB`
- scheduled task: `RLDB-Direct-Node-Supervisor`
- Windows account: `DESKTOP-ASRAPT8\rldbsvc`

The task starts automatically, and its supervisor restarts the backend and
telemetry children after a crash. The candidate passes its D1-compatibility
unit tests and representative endpoint checks. It does not serve production
traffic or modify the operational database.

The candidate has an independent weekly updater for NRL and NRLW. It fetches
current-season data directly, prepares and validates a consistent staging
database while the candidate remains online, and briefly stops the candidate
only to promote the database. One previous database is retained for rollback,
and a failed post-promotion health check triggers an automatic rollback.

The candidate is available through the separate supervised test hostname
`https://rldb-test.drein.net`. External-path and live comparison results are
recorded in
[docs/PUBLIC_TEST_VALIDATION_2026-08-04.md](docs/PUBLIC_TEST_VALIDATION_2026-08-04.md).
User acceptance review is still required before production cutover.

The operational system remains:

- source: `C:\Users\d2rei\My_Site\rugby-league-stats-db-local`
- backend: `127.0.0.1:8797`
- telemetry: `127.0.0.1:8798`
- public site: `https://rldb.drein.net`

Do not change those routes or processes while developing this replacement.

See [docs/RECOVERY_STATUS_2026-07-30.md](docs/RECOVERY_STATUS_2026-07-30.md)
for the recovered implementation state and subsequent service-install
verification results.

See [docs/SERVICE_RUNBOOK.md](docs/SERVICE_RUNBOOK.md) for restricted-account
installation, routine controls, permissions, and removal.

See
[docs/PERFORMANCE_BASELINE_2026-07-31.md](docs/PERFORMANCE_BASELINE_2026-07-31.md)
for the first installed-candidate query diagnosis and focused benchmark.

## Repository rules

Only source code, tests, schema definitions, updater logic, service controls,
and documentation belong here. Databases, snapshots, backups, telemetry,
benchmark output, generated SQL, scraped payloads, runtime logs, Wrangler
state, and credentials must remain outside Git.

See [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md) for the staged build and
cutover guardrails.
