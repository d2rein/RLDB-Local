# Rugby League Stats Database

Cloudflare-based stats site for querying historical and modern rugby league data in a Statsguru-style interface.

## Shareable Mirror

This folder is a cleaned mirror of the live hybrid local-server workspace as of
`2026-07-19`.

It is intended for:

- GitHub backup of the active hybrid architecture
- sharing the current codebase with collaborators
- documenting how `rldb.drein.net` works now

It intentionally excludes machine-specific operational artefacts such as:

- runtime logs
- temporary debug output files
- local Wrangler state
- cloudflared credential files
- bulky HTML scrape snapshots that are not needed to understand the app

For the running production system, the operational workspace remains:

- `C:\Users\d2rei\My_Site\rugby-league-stats-db-local`

## Operational Status

As of `2026-07-13`, the live, working system is the hybrid local-server setup:

- public URL: `https://rldb.drein.net`
- public UI: Cloudflare Worker
- heavy query/data work: this PC, via the hidden local backend on port `8797`
- public reachability to the backend: `cloudflared` tunnel
- weekly updates: local Windows scheduled task calling `scripts/refresh-hybrid-site.ps1`

This is the operational production system and must be treated as the default
source of truth for maintenance work.

There is also an older cloud-first GitHub/Workers path kept on the books as a
mothballed fallback. It is not the active production path right now.

## Historical Repo Layout

There are effectively two related repos/copies involved:

1. Operational workspace repo
   Path: `C:\Users\d2rei\My_Site\rugby-league-stats-db-local`
   Purpose: the live hybrid local-server system you are actively using.

2. Source/mirror repo
   Path: `C:\Users\d2rei\Rugby-League-Stats-Database`
   Purpose: GitHub-connected mirror / older cloud-first line.

This shareable mirror exists to avoid pushing the active local-hosted system
back into that older cloud-first line by accident.

Parallel Stage 3 work is isolated on
`parallel/stage3-local-2026-07-28`; see
[`docs/parallel-stage3.md`](docs/parallel-stage3.md). That branch does not
replace or reconfigure the operational site.

## Branch Meaning

At the time of writing:

- `local/local-server-2026-06-08`
  The active branch for the operational hybrid local-server system.
- GitHub/source repo `main`
  A mothballed cloud-first snapshot kept for future recovery/reference, not the
  active live system.

GitHub automation on that mothballed `main` branch has been reduced to
manual-only so it does not:

- send noisy weekly failure emails
- accidentally redeploy stale cloud-first code

## Documented Update Procedure

When asked to "follow the documented update procedure", use this exact workflow
unless explicitly told otherwise.

1. Treat `C:\Users\d2rei\My_Site\rugby-league-stats-db-local` as the default
   repo to edit.
2. Assume the current operational target is the hybrid local-server system at
   `https://rldb.drein.net`.
3. Do not push blindly to GitHub/source repo `main`.
   Reason: that branch is currently a mothballed cloud-first line and is not
   guaranteed to match the live operational system.
4. Before risky changes, inspect:
   - local git status
   - current branch
   - whether the change affects:
     - UI only
     - backend query logic
     - local refresh/update scripts
     - schema / seed generation
     - GitHub-only mothballed workflows
5. Make and validate the change in this operational workspace first.
6. If the change touches backend/data/query behavior, verify at minimum:
   - local backend health:
     `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8797/api/health`
   - public site still loads:
     `https://rldb.drein.net`
   - weekly updater path remains intact:
     `scripts/refresh-hybrid-site.ps1`
7. If a rebuild is required for the operational system, prefer the hybrid-safe
   refresh path:

```powershell
npm run local:refresh:hybrid
```

8. If only a restart is required, use:

```powershell
npm run local:stop
powershell -ExecutionPolicy Bypass -File .\scripts\start-hybrid-backend-hidden.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-cloudflared-tunnel-hidden.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-hybrid-watchdog-hidden.ps1
```

9. Only update the source/mirror repo or GitHub workflows when the task is
   explicitly about:
   - backup/mothballed cloud path maintenance
   - repo hygiene / documentation
   - workflow noise reduction
   - future realignment work
10. If a change must be propagated beyond this workspace, document clearly which
    repo and branch were updated and why.

## Goals

- Keep source data files immutable
- Import reconciled match, detailed match, and player-stat data into D1
- Support stat queries and streak queries from day one
- Prefer NRL.com orientation and values when sources conflict
- Preserve source provenance for auditability

## Initial Stack

- Cloudflare Pages
- Cloudflare Workers
- Cloudflare D1
- TypeScript

## Current Source Inputs

- `master_matches_reconciled.csv`
- `NRL_detailed_match_data_*.json`
- `NRL_player_statistics_*.json`
- AFLTables `player_stats.csv`

## Status

This repo currently contains the initial architecture notes, schema design, and first-pass D1 migration scaffold.

## Local Refresh

The local build now defaults to the corrected detailed-match scrape in:

- `docs/NRL-Data-main_duplicate/data/NRL`

Refresh local D1 with:

```powershell
npm run matches:sync-nrl-backbone
npm run seed:reference
npm run seed:core
npm run seed:core-sql
npm run seed:legacy-sql
npm run seed:player-stats-sql
npm run seed:match-summaries-sql
node .\scripts\apply-local-d1-sqlite.mjs
npm run dev
```

## Private Local Server

This workspace copy is intended to run privately on your own machine instead of
serving the search workload through Cloudflare.

Use:

```powershell
npm run local:serve
```

That starts the full site locally at:

- `http://127.0.0.1:8787`

If you want to refresh the data first and then start the local site:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-local-site.ps1 -RefreshData
```

To refresh the local data without starting the server:

```powershell
npm run local:refresh
```

By default that refresh now targets the current calendar year and scrapes both:

- `NRL`
- `NRLW`

If the hybrid public site is currently running from your PC, use this instead so it
stops the backend first, refreshes safely, then starts everything again:

```powershell
npm run local:refresh:hybrid
```

To create a Windows scheduled task for weekly refreshes:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-weekly-refresh-task.ps1
```

## Public Website + Local Backend

The project can now run in the hybrid mode you originally wanted:

- the public website stays on Cloudflare
- the public Worker serves the UI
- query/data routes are proxied to your PC
- your PC does the heavy DB/search work locally

### Local backend

Run the backend on your PC on a separate local port:

```powershell
npm run local:backend
```

That starts the backend Worker on:

- `http://127.0.0.1:8797`

To stop the hidden backend, tunnel, and watchdog cleanly:

```powershell
npm run local:stop
```

For a production-style local backend, set a backend token before starting it:

```powershell
$env:LOCAL_API_TOKEN = "replace-with-a-long-random-secret"
npm run local:backend
```

When `LOCAL_API_TOKEN` is set, direct non-local requests to:

- `/api/health`
- `/api/meta/bootstrap`
- `/api/meta/players`
- `/api/meta/regression-suite`
- `/api/export`
- `/api/query`
- `/api/query/full`
- `/match/:id`

must include the matching `x-rldb-token` header.

### Tunnel

Expose only the local backend port through a tunnel, for example:

```powershell
cloudflared tunnel --url http://127.0.0.1:8797
```

That gives you an HTTPS origin such as:

- `https://your-backend-name.trycloudflare.com`

### Public Cloudflare site

Set these Worker environment variables on the public site:

- `REMOTE_QUERY_ORIGIN`
  Example: `https://your-backend-name.trycloudflare.com`
- `REMOTE_QUERY_TOKEN`
  The same long random secret used for `LOCAL_API_TOKEN`

In that mode, the public Worker will proxy the heavy data routes to your PC while keeping the secret server-side.

### Security notes

- Keep the backend bound to `127.0.0.1`; let the tunnel expose it rather than opening router ports.
- Use a long random token for `LOCAL_API_TOKEN` / `REMOTE_QUERY_TOKEN`.
- Do not put the token in browser JavaScript or public HTML.
- If you later want stricter access control, the next step would be Cloudflare Access or an invite-only login on the public site.

## Shared Site Password

The public stats site can also be protected with a shared password at the Worker layer.

- Secret: `STATS_SITE_PASSWORD_HASH`
- Secret: `STATS_SITE_SESSION_SECRET`

Recent site-password attempts can be reviewed from your own PC through the local backend:

```powershell
npm run local:auth-attempts
```

That shows recent failed attempts by default. To include successful logins too:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\show-auth-attempts.ps1 -All
```

To see currently active authenticated users from the last 30 minutes:

```powershell
npm run local:active-users
```
- Sessions last for 30 days
- Three failed attempts from the same IP lock access for one hour

Generate a password hash with:

```powershell
npm run auth:hash-password -- your-password-here
```

Then update the Worker secrets:

```powershell
npx wrangler secret put STATS_SITE_PASSWORD_HASH
npx wrangler secret put STATS_SITE_SESSION_SECRET
```

To remove the shared-password gate later, delete or replace those two Worker secrets and redeploy.

## Deployment

See:

- `docs/deployment-runbook.md`
