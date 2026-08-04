# Independent updater validation - 2026-08-04

## Scope

The complete updater lifecycle was tested against disposable files under
`rldb-direct-node-runtime`. Neither the operational service on port 8797 nor
the installed candidate database under `C:\RLDB` was used by this test.

## Prepare

- Started from the independent Round 20 test baseline.
- Fetched completed NRL Rounds 21 and 22.
- Skipped incomplete NRL Rounds 23 and 24.
- Fetched completed NRLW rounds available from the source.
- Created a transactionally consistent 2.3 GB staging backup.
- Imported 164 NRL matches and 6,231 NRL player-match rows through Round 22.
- Passed targeted current-season summary checks.
- Checkpointed and truncated the staging WAL to zero bytes before promotion.
- Total prepare time: approximately 3 minutes 47 seconds.

## Promotion queries

The staged file was promoted using the same updater command and served on
temporary port 8901.

| Check | Status | Duration |
| --- | ---: | ---: |
| Bootstrap | 200 | 295 ms |
| Most player tries in a match | 200 | 3,782 ms |
| Most first-half team points | 200 | 1,496 ms |
| Leading career try scorers | 200 | 234 ms |
| Immediate follow-up margin query | 200 | 14 ms |

The promoted database reported Alex Johnston on 232 tries and returned Round
22 as the leading first-half match result. No malformed-image or lockup error
occurred.

## Rollback

The temporary server was stopped, the preserved baseline was restored with the
updater rollback command, and the server was restarted.

| Check | Status | Duration |
| --- | ---: | ---: |
| Health | 200 | 64 ms |
| Most player tries in a match | 200 | 3,480 ms |
| Most first-half team points | 200 | 1,407 ms |

The original database remained queryable after rollback.
