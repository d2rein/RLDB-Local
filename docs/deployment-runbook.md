# Deployment Runbook

## Operational Model

As of `2026-07-13`, the active production system is the hybrid local-server
model:

- public site: `https://rldb.drein.net`
- public UI host: Cloudflare Worker
- heavy queries and exports: local backend on this PC
- local backend port: `127.0.0.1:8797`
- public bridge to local backend: `cloudflared`
- automated weekly refresh: local Windows scheduled task

This is the path that must remain operational.

## Repo / Branch Model

### Operational workspace

- Path: `C:\Users\d2rei\My_Site\rugby-league-stats-db-local`
- Role: active development and operational maintenance copy
- Active branch: `local/local-server-2026-06-08`

### Source / mirror repo

- Path: `C:\Users\d2rei\Rugby-League-Stats-Database`
- Role: GitHub-connected mirror and mothballed cloud-first line

### Important rule

Do not assume GitHub `main` is the live production branch.

At the moment, it should be treated as:

- a retained cloud-first snapshot
- useful for future recovery / realignment
- not the branch to push blindly from operational changes

## Current Data Inputs

The local build currently reads detailed/team data from:

- `C:\Users\d2rei\Rugby-League-Stats-Database\docs\NRL-Data-main_duplicate\data\NRL`
- `C:\Users\d2rei\Rugby-League-Stats-Database\docs\NRL-Data-main_duplicate\data\NRLW`

If needed temporarily, override with:

- `NRL_DATA_ROOT_OVERRIDE`
- `NRLW_DATA_ROOT_OVERRIDE`

## Operational Update Procedure

When making ordinary feature fixes or maintenance changes, use this flow.

### 1. Work in the operational workspace

Default working repo:

- `C:\Users\d2rei\My_Site\rugby-league-stats-db-local`

Default assumption:

- any change should preserve the behavior of `https://rldb.drein.net`
- any change should preserve the weekly local refresh path

### 2. Classify the change

Decide whether the change affects:

- UI only
- backend / query logic
- refresh scripts
- seed / schema generation
- operational infrastructure
- mothballed GitHub/cloud workflows only

### 3. Validate proportionally

Minimum checks for backend-affecting changes:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8797/api/health
```

And verify the public site still responds:

- `https://rldb.drein.net`

### 4. If the data/backend needs a safe rebuild

Use the hybrid-safe refresh path:

```powershell
npm run local:refresh:hybrid
```

That path:

- stops backend, tunnel, and watchdog
- refreshes local data
- rebuilds local SQLite/D1 state
- starts backend, tunnel, and watchdog again

### 5. If only a restart is needed

Use:

```powershell
npm run local:stop
powershell -ExecutionPolicy Bypass -File .\scripts\start-hybrid-backend-hidden.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-cloudflared-tunnel-hidden.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-hybrid-watchdog-hidden.ps1
```

### 6. If only local data needs refresh without the public site path

Use:

```powershell
npm run local:refresh
```

### 7. Weekly updater path to protect

The weekly operational updater is the local scheduled-task path created by:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-weekly-refresh-task.ps1
```

That task runs:

- `scripts/refresh-hybrid-site.ps1`

That script in turn manages:

- `scripts/refresh-local-data.ps1`
- `scripts/start-hybrid-backend-hidden.ps1`
- `scripts/start-cloudflared-tunnel-hidden.ps1`
- `scripts/start-hybrid-watchdog-hidden.ps1`

Any change touching those files should be treated as operationally sensitive.

## Manual Rebuild Commands

If a full local rebuild is required from the operational workspace, use:

```powershell
npm run matches:sync-nrl-backbone
npm run seed:reference
npm run seed:core
npm run seed:core-sql
npm run seed:legacy-sql
npm run seed:player-stats-sql
npm run seed:match-summaries-sql
node .\scripts\apply-local-d1-sqlite.mjs
npm run seed:current-season-refresh
```

## Mothballed GitHub / Cloud Path

This path is intentionally retained, but it is not the active production path.

### Current state

The GitHub-connected repo/workflows are preserved for future reuse, but the
automation has been reduced to manual-only so it does not:

- spam weekly failure emails
- waste GitHub Actions runs
- accidentally redeploy stale cloud-first code

### Workflows currently kept on manual-only mode

- `.github/workflows/weekly-refresh.yml`
- `.github/workflows/deploy-worker.yml`

### When to touch the mothballed path

Only touch it when the task is explicitly about:

- backup cloud-path maintenance
- workflow cleanup
- future branch realignment
- reviving cloud-first deployment as a serious option again

## Branch Realignment Guidance

If/when the cloud path is revived in future, do not guess. First reconcile:

- which repo is authoritative
- which branch represents the current hybrid operational code
- whether the cloud path should follow that branch
- whether GitHub `main` should be replaced, merged, or retired

Until that realignment happens, prefer:

- operational fixes in the workspace repo
- explicit documentation of any maintenance-only GitHub changes

## Agent Instruction

If a future agent is told:

- "follow the documented update procedure"

it should:

1. read this file and `README.md`
2. treat the operational hybrid local-server system as primary
3. avoid pushing blindly to GitHub `main`
4. preserve:
   - `https://rldb.drein.net`
   - the local backend
   - the cloudflared tunnel
   - the watchdog
   - the weekly local refresh task
