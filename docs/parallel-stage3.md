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
