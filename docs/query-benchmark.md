# Reproducible query benchmark

Stage 2 benchmarks the current query API without using the old Wikipedia values
as truth. The first successful capture stores complete normalized API responses
in `benchmark/baselines/current-hybrid.json`. Later runs compare against that
file.

The suite contains the 29 cases exposed by `/api/meta/regression-suite` plus
six cases in `benchmark/extra-cases.json` covering NRLW, State of Origin,
combined NRL and Origin, multiple selected statistics, conditional season
aggregation and season-level streaks.

## Fixed snapshot

Create a consistent online SQLite copy without stopping production:

```powershell
npm run benchmark:snapshot
```

The snapshot and its SHA-256 metadata are stored below
`runtime-data/benchmarks/snapshots/`. They are intentionally excluded from Git
because the SQLite file is approximately 2.3 GB. Keep both files with local
backups.

## Isolated service

The benchmark service uses:

- `127.0.0.1:8897`
- `runtime-data/benchmarks/wrangler-state`
- the pinned database snapshot
- separate logs in `runtime-data/benchmarks/logs`
- no tunnel or public hostname

Start it with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-benchmark-backend-hidden.ps1
```

The benchmark runner may restart only this isolated service if it becomes
unhealthy. It never restarts the operational port `8797`.

## Capture and compare

The committed baseline was captured with one first observation and five warm
iterations:

```powershell
node .\scripts\run-query-benchmark.mjs `
  --capture-baseline `
  --base-url http://127.0.0.1:8897 `
  --restart-script scripts/start-benchmark-backend-hidden.ps1 `
  --snapshot-metadata runtime-data/benchmarks/snapshots/rldb-2026-07-26.sqlite.metadata.json
```

Run a later comparison by omitting `--capture-baseline`:

```powershell
node .\scripts\run-query-benchmark.mjs `
  --base-url http://127.0.0.1:8897 `
  --restart-script scripts/start-benchmark-backend-hidden.ps1 `
  --snapshot-metadata runtime-data/benchmarks/snapshots/rldb-2026-07-26.sqlite.metadata.json
```

Durable run records are written to
`runtime-data/benchmarks/benchmark-runs.sqlite`. Markdown and CSV reports are
written to `reports/benchmarks/`.

Result normalization removes volatile summaries and timestamps and makes tied
rows order-insensitive while preserving the order of different score groups.
Each iteration records the complete normalized result, request input, stable
hash, generated SQL, bound parameters, database time, post-processing time,
total time, row counts, errors and recovery attempts.

The `--explain` option reserves EXPLAIN records alongside captured SQL. Query
plans are not executed against the live database; Stage 4 will execute them
against the pinned snapshot during index experiments.
