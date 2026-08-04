# Restricted service runbook

## Purpose

The direct-Node candidate is installed under the standard local `rldbsvc`
account. It remains independent of the operational Wrangler service and uses:

- backend `127.0.0.1:8899`
- telemetry `127.0.0.1:8890`
- install root `C:\RLDB`
- scheduled task `RLDB-Direct-Node-Supervisor`

The installer refuses to use operational ports `8797` and `8798` and checks
operational health before and after installation.

## One-time installation

Build and test the repository first. Then open PowerShell as Administrator:

```powershell
cd C:\Users\d2rei\My_Site\rldb-direct-node
powershell -ExecutionPolicy Bypass -File .\scripts\service\install-rldb-service.ps1
```

The installer does not store or change the `rldbsvc` account password. On the
first installation, Windows prompts once for the existing password and stores
the task credential in Task Scheduler's protected credential store. The
password is not written to source, configuration, logs, or command arguments.
Reinstallation retains the existing task credential, and routine service
operation does not require entering the password.
The installer grants `rldbsvc` only the Windows `Log on as a batch job`
privilege required by that S4U task. It does not make the account an
administrator or grant access to unrelated files.

The initial database is copied once. Reinstallation retains `C:\RLDB\data` and
the existing site session secret.

## Routine controls

These commands do not require an administrator terminal:

```powershell
C:\RLDB\control\rldb-status.ps1
C:\RLDB\control\rldb-start.ps1
C:\RLDB\control\rldb-stop.ps1
C:\RLDB\control\rldb-restart.ps1
C:\RLDB\control\rldb-logs.ps1
C:\RLDB\control\rldb-update.ps1
```

The supervisor reads command files from `C:\RLDB\control`. It restarts crashed
backend or telemetry children automatically. The scheduled task restarts the
supervisor if the supervisor itself exits.

## Weekly data update

The candidate independently fetches and imports NRL and NRLW data each Monday
at 1:00 AM local time. Source payloads are stored under
`C:\RLDB\update-data`; the updater does not copy the operational database after
the initial installation seed.

Preparation uses `C:\RLDB\data\staging\rldb-update.sqlite` while the current
database remains available. The candidate is stopped only for the final file
promotion. `C:\RLDB\data\previous\rldb.sqlite` is the single retained rollback
database. Current-season summary invariants, freshness, match-count,
row-count, and post-promotion health checks must pass. Full SQLite page and
index integrity audits remain a separate maintenance operation: both
`integrity_check` and `quick_check` generate tens of gigabytes of random reads
on this heavily indexed database and are unsuitable for the weekly path. A
failed health check automatically restores the previous database.

Before promotion, the importer checkpoints and truncates SQLite's WAL and the
promoter refuses any non-empty WAL sidecar. Post-promotion health includes
real team first-half and player match-level queries, not only the lightweight
health endpoint.

Request an update manually and inspect progress with:

```powershell
C:\RLDB\control\rldb-update.ps1
C:\RLDB\control\rldb-status.ps1
C:\RLDB\control\rldb-logs.ps1
```

Updater details are written to `C:\RLDB\logs\update.out.log` and failures to
`C:\RLDB\logs\update.err.log`. The latest machine-readable state is
`C:\RLDB\runtime\update-status.json`.

## Permissions

- `rldbsvc` has read/execute access to the release.
- `rldbsvc` has modify access only to data, logs, runtime, telemetry, backups,
  and control.
- `d2rei` has read access to runtime data and logs, and modify access to the
  control directory.
- configuration containing the site session secret is limited to SYSTEM,
  Administrators, and `rldbsvc`.

## Removal

The uninstaller retains the database unless explicitly instructed otherwise:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\service\uninstall-rldb-service.ps1
```

No production task, process, port, tunnel, repository, or database is changed
by installation or removal of this candidate.
