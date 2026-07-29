# Parallel Stage 3 Environment

## Purpose

This branch prepares a second RLDB backend without changing the operational
system at `rldb.drein.net`.

The current operational architecture already performs heavy queries against a
local SQLite database. Stage 3 therefore focuses on isolation and
reproducibility rather than claiming a new hosting-performance gain:

- a clean, independent Git repository;
- a dedicated standard Windows account;
- a separate SQLite database copy;
- separate runtime, log, Wrangler-state, and telemetry directories;
- a separate local port and Cloudflare Tunnel test hostname;
- direct benchmark comparison with the operational backend;
- no production hostname, task, tunnel, database, or process replacement.

## Current State

- Clean repository: `d2rein/RLDB-Local`
- Development branch: `parallel/stage3-local-2026-07-28`
- Operational backend: unchanged on `127.0.0.1:8797`
- Parallel development port: `127.0.0.1:8899`
- Parallel telemetry port: `127.0.0.1:8890`
- Parallel test hostname: not configured
- Production cutover: not approved or attempted

The branch includes persistent telemetry, the reproducible benchmark framework,
the current hybrid baseline, and the correctness fixes through 2026-07-28.

## Isolation Layout

The eventual dedicated account should use directories similar to:

```text
C:\RLDB\
  app\
  data\
  logs\
  backups\
  runtime\
```

Only the dedicated account, the primary maintenance account, and
Administrators should have access. The dedicated account must not have access
to personal profile folders, browser data, SSH keys, GitHub credentials, or
unrelated projects.

The backend must bind only to `127.0.0.1`. Public access must be through a
separate Cloudflare Tunnel hostname, with no router port forwarding.

## Required User Action

Before installing the persistent parallel service, create a standard local
Windows account such as `rldbsvc`. Do not make it an administrator. The account
password should be generated and retained by the owner; it must not be committed
or placed in an application configuration file.

Creating the account and registering a task under it require an administrator
session and its task credentials. Source preparation and benchmarks do not.

## Dedicated Account Installation

The isolated service scripts are under `scripts/stage3`. They install a
versioned, rollback-friendly release under `C:\RLDB` and never edit or stop the
operational workspace, port `8797`, production tunnel, or production task.

From an Administrator PowerShell window:

```powershell
cd C:\Users\d2rei\My_Site\rugby-league-stats-db-live-mirror
powershell -ExecutionPolicy Bypass -File .\scripts\stage3\install-rldb-service.ps1
```

The installer:

- exports the current committed Stage 3 revision rather than copying a dirty
  working tree;
- installs locked dependencies in a versioned release directory;
- copies and SHA-256 verifies the frozen Stage 3 database;
- generates a separate backend token and stores it outside Git;
- grants `rldbsvc` read-only application/configuration access and write access
  only to Stage 3 data, logs, and runtime directories;
- registers `RLDB-Stage3-Parallel` as a limited scheduled task;
- prompts for the account password only while Windows registers the task.

The password is not written to a project file or log.

The low-resource controller remains alive while Windows is running. It monitors
only the Stage 3 children, automatically replaces a crashed child, and restarts
an unhealthy backend after eight consecutive bounded health failures. A slow
or failed Stage 3 request cannot wedge or restart the operational backend.

The maintenance account controls the service through request files, so normal
start, stop, restart, status, and log access do not require elevation:

```powershell
C:\RLDB\control\rldb-status.ps1
C:\RLDB\control\rldb-start.ps1
C:\RLDB\control\rldb-stop.ps1
C:\RLDB\control\rldb-restart.ps1
C:\RLDB\control\rldb-logs.ps1
```

`stop` stops the backend and telemetry children but intentionally leaves the
small controller task alive to receive a future `start` request. The service
binds only to `127.0.0.1:8899`; no public hostname or router forwarding is
created by the installer.

## Benchmark Sequence

1. Copy the same fixed SQLite snapshot into the parallel data directory.
2. Start the parallel backend on port `8899`.
3. Capture a corrected baseline before adding indexes or query rewrites.
4. Confirm normalized results match the operational backend.
5. Test each proposed index independently.
6. Record query plans, median/minimum/maximum times, database-size growth, and
   refresh/write cost.
7. Keep only indexes with measured benefit.
8. Configure the second-account task and test tunnel only after local results
   are correct.

Proposed indexes are experiments, not defaults:

```sql
CREATE INDEX idx_player_match_summary_lookup
ON player_match_summary (player_id, season, team_id);

CREATE INDEX idx_team_match_summary_lookup
ON team_match_summary (team_id, season, opponent_team_id);

CREATE INDEX idx_matches_lookup
ON matches (season, competition_id, match_id);
```

No index should be retained without a before/after benchmark and query-plan
comparison.

## Rollback Boundary

The operational system remains the rollback target throughout Stage 3. The
parallel branch, port, database copy, logs, scheduled task, tunnel, and hostname
must remain independently removable. Nothing in this branch authorizes a
change to `rldb.drein.net`.
