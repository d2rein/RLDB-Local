# RLDB Direct Node

Clean replacement implementation for the Rugby League Stats Database.

This repository will run the existing RLDB application directly on Node.js and
SQLite. It will not use Wrangler, Miniflare, workerd, esbuild watchers, D1, or a
Cloudflare Worker for query execution. Cloudflare Tunnel will remain the only
public transport and will proxy to a server bound to `127.0.0.1`.

## Current status

Foundation only. Nothing in this repository currently serves production
traffic, starts automatically, or modifies the operational database.

The operational system remains:

- source: `C:\Users\d2rei\My_Site\rugby-league-stats-db-local`
- backend: `127.0.0.1:8797`
- telemetry: `127.0.0.1:8798`
- public site: `https://rldb.drein.net`

Do not change those routes or processes while developing this replacement.

## Repository rules

Only source code, tests, schema definitions, updater logic, service controls,
and documentation belong here. Databases, snapshots, backups, telemetry,
benchmark output, generated SQL, scraped payloads, runtime logs, Wrangler
state, and credentials must remain outside Git.

See [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md) for the staged build and
cutover guardrails.

