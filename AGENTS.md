# RLDB agent instructions

Read `docs/CODEX_HANDOFF.md` before changing this repository.

## Safety boundary

- This repository is the clean direct-Node candidate. The installed candidate
  runs on `127.0.0.1:8899`; its telemetry service runs on `127.0.0.1:8890`.
- The operational Wrangler backend is separate, at `127.0.0.1:8797`, with
  source in `C:\Users\d2rei\My_Site\rugby-league-stats-db-local`.
- Do not stop, restart, migrate, overwrite, or repoint the operational service
  unless the user explicitly approves a production operation.
- Keep both servers loopback-only. Public access must go through Cloudflare
  Tunnel; never add router forwarding or a wildcard bind.
- Never commit databases, scraped payloads, credentials, logs, benchmark
  output, generated bundles, or files from `C:\RLDB`.

## Change workflow

1. Inspect `git status`, the installed status with
   `C:\RLDB\control\rldb-status.ps1`, and both health endpoints.
2. Make source changes here, not inside an installed release under `C:\RLDB`.
3. Run `npm.cmd test` and the relevant smoke/parity/benchmark checks.
4. Commit an accepted source state before installation.
5. Installation is performed from an elevated PowerShell with
   `scripts\service\install-rldb-service.ps1`; it must leave port 8797 healthy.
6. Preserve a direct rollback to the operational origin during any eventual
   public cutover.

## Query-engine rules

- Optimize query classes, not individual benchmark questions.
- Do not move filtering after ranking/limiting, or apply match conditions at an
  aggregate level. Derived statistics must materialize every component needed
  by selected statistics and conditions before filtering.
- Preserve missing-versus-zero semantics, stable response fields, complete
  grouping, pagination, and tie-equivalent ordering.
- Treat operational output as an important reference, not infallible truth.
  Investigate semantic differences before making the candidate imitate it.
- Do not accept a speed improvement unless normalized results remain
  semantically equivalent on a fixed data cutoff.

