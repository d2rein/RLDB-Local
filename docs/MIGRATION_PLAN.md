# Direct Node migration plan

## Goal

Build an independent RLDB service that:

- runs as the restricted `rldbsvc` Windows account;
- queries a dedicated SQLite database directly;
- binds only to `127.0.0.1` on separate test ports;
- is exposed through a separate Cloudflare Tunnel test hostname;
- updates its own database weekly from source data;
- can be tested against the live operational system before cutover;
- does not depend on the operational repository or database after seeding.

## Source boundary

Initially copy only the application code required to preserve behaviour:

- the current request handler and inline frontend;
- stat definitions used by that handler;
- query telemetry instrumentation;
- the benchmark client and normalisation logic;
- the import and weekly-refresh modules that are proven necessary;
- schema and migration definitions needed to create or validate a database;
- narrowly scoped Windows service and control scripts.

Do not copy:

- `.wrangler` or Miniflare state;
- Wrangler configuration or Cloudflare Worker deployment scripts;
- old D1 upload machinery;
- historical backups or database snapshots;
- generated SQL bundles or scraped runtime payloads;
- benchmark results, runtime logs, review CSVs, or temporary reports;
- unrelated audit and one-off repair scripts;
- credentials, tokens, environment files, or personal paths.

Any updater dependency must be justified before it is copied. The final
weekly updater must build from authoritative source inputs, not copy the
operational database.

## Planned commits

1. Repository foundation and guardrails.
2. Direct SQLite compatibility adapter and Node HTTP server.
3. Unit tests for D1-compatible return values, binding, errors, and shutdown.
4. Independent development database seed and schema verification.
5. Live parity benchmark against the operational backend.
6. Independent weekly updater and update verification.
7. Restricted-account service, health checks, logs, and control scripts.
8. Separate test tunnel and second live parity benchmark.
9. Reviewed production cutover documentation.

Each commit must be independently reversible.

## Database lifecycle

The first database is seeded once from a transactionally consistent copy of
the operational SQLite database. It is then owned by the new service.

After seeding:

- the new updater fetches and imports new NRL, NRLW, and supported
  representative data independently;
- updates are applied to a temporary database or transactionally, validated,
  and only then promoted;
- the previous successful database is retained as the immediate rollback;
- benchmark runs target both live services using the same explicit data
  cutoff;
- frozen benchmark snapshots are temporary test artifacts and are deleted
  after an experiment unless explicitly retained.

## Runtime layout

The intended installed layout is outside the repository:

```text
C:\RLDB\
  app\releases\<git-commit>\
  data\rldb.sqlite
  data\previous\rldb.sqlite
  logs\
  runtime\
  telemetry\query-performance.sqlite
  backups\
  control\
```

The application release is read-only to `rldbsvc`. That account receives
modify access only to `data`, `logs`, `runtime`, and `telemetry`, and read
access to the required backup location.

## Operational guardrails

Before every test or installation:

1. Confirm `http://127.0.0.1:8797/api/health` returns `200`.
2. Confirm the test service uses neither port `8797` nor `8798`.
3. Confirm no script searches for or terminates generic Node, workerd, or
   esbuild processes.
4. Confirm the test database path is not under the operational `.wrangler`
   directory.
5. Confirm the production tunnel route remains unchanged.

After every test or installation, repeat the production health check.

No public cutover is permitted until correctness results match the
operational backend and the performance comparison has been reviewed.
