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

By default, the installer replaces the known service-account password with an
unknown random password and marks it non-expiring. The task uses Windows S4U,
so no password is stored in the task. Use
`-PreserveServiceAccountPassword` only when there is a deliberate reason to
retain the account's current password.

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
```

The supervisor reads command files from `C:\RLDB\control`. It restarts crashed
backend or telemetry children automatically. The scheduled task restarts the
supervisor if the supervisor itself exits.

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
