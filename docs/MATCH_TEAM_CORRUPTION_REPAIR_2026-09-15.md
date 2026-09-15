# 2026 match roster corruption repair

Date: 2026-09-15 (Australia/Brisbane)

## Incident

Match 15491, Cronulla-Sutherland Sharks 26-16 North Queensland Cowboys, was stored as 32 Sharks and 6 Cowboys roster rows. Thirty active players appeared on the home side and four on the away side. The match page consequently mixed most starters under Cronulla-Sutherland and displayed only the remaining North Queensland bench/reserve players.

## Checkpoint and rollback

Before diagnosis or mutation, the candidate service was briefly stopped and a frozen SQLite snapshot (database, WAL, and SHM) was copied to:

`runtime-data/backups/pre-team-list-repair-20260915T165100+1000.snapshot/`

The WAL in that snapshot was checkpointed into the copied database while it was offline. The live updater also retains the database it replaces under `C:\RLDB\data\previous\rldb.sqlite`.

Rollback is to stop the candidate service, restore either the frozen pre-repair snapshot database or the updater's `previous` database to `C:\RLDB\data\rldb.sqlite`, remove stale live WAL/SHM sidecars, and start the service. Run `PRAGMA quick_check`, `/api/health`, and the match-detail smoke checks before reopening traffic.

## Root cause

The NRL match-centre payload contained two correct 19-player rosters and correct source team IDs. The fetch transform flattened those arrays and discarded the side identity. The importer reconstructed sides by splitting the flattened list whenever jumper numbers decreased.

North Queensland's valid jumper sequence in match 15491 contains internal decreases (15 to 12 and 21 to 18). The heuristic therefore produced runs of 19, 13, 4, and 2 players and divided the four runs 32/6. Match and team resolution itself was correct; the wrong inferred side was then propagated consistently into `player_match_summary`, which prevented simple internal consistency checks from detecting it.

The jersey-run decoder is retained for old project payload compatibility, but it is now only a validated last-resort legacy fallback. New fetches preserve source-side and source-team identity explicitly.

## Affected data

Comparing the cached authoritative 2026 payloads with the old split algorithm identified 36 affected matches:

- NRL (19): R21 Knights-Roosters; R22 Cowboys-Roosters, Titans-Warriors, Broncos-Knights, Wests Tigers-Eels; R23 Warriors-Panthers, Storm-Sea Eagles, Dolphins-Broncos, Rabbitohs-Eels; R24 Eels-Cowboys; R25 Raiders-Broncos, Dolphins-Eels, Rabbitohs-Warriors, Roosters-Wests Tigers; R26 Broncos-Storm, Panthers-Bulldogs, Warriors-Knights; R27 Dragons-Eels; R28 Sharks-Cowboys.
- NRLW (17): R3 Titans-Eels, Knights-Dragons; R4 Bulldogs-Dragons; R5 Sharks-Wests Tigers, Raiders-Cowboys; R6 Warriors-Knights, Dragons-Wests Tigers; R7 Titans-Dragons; R8 Bulldogs-Raiders; R9 Roosters-Sharks, Warriors-Dragons; R10 Warriors-Sharks, Dragons-Broncos, Wests Tigers-Titans, Raiders-Eels; R11 Broncos-Warriors, Knights-Titans.

The incorrect parent assignment affected `player_match_summary` and its team/opponent-filtered query components. Team scoring reconstructed from those assignments affected `team_match_summary`, normalized team stat values, and team season aggregates. Player and team normalized stat rows were present; the empty `match_player_stats` and `match_team_stats` tables are unused legacy raw tables, not the canonical statistics store. Canonical statistics are in `player_match_stat_values`, `team_match_stat_values`, and `player_match_query_components`.

## Repair and prevention

- Fetch payload schema v2 stores explicit home and away arrays plus each row's upstream player and team IDs.
- Import verifies upstream team identity and rejects/quarantines an invalid match before it can be promoted.
- Validation covers roster and active-player side counts, count balance, duplicate active jumpers, a player appearing for both teams, `team_id`/`is_home`/`opponent_team_id`, both team summaries, normalized player/team stats, query components, and score attribution.
- The current-season importer remains idempotent and can rebuild the affected summaries from cached authoritative payloads without player re-resolution or historical source downloads.
- The match page excludes unused zero-minute reserves from the displayed team lists, while retaining complete source rosters in canonical storage.
- “Open full stats” now links to the match page's full player-stat table, whose API is `/api/match-detail`.

## Verification

The repaired disposable copy was imported twice with identical results, then audited across all 274 NRL/NRLW matches in 2026. The audit found zero invalid side counts, assignment errors, duplicate active jumpers, dual-team players, team-summary errors, missing normalized rows, scoring mismatches, or orphan scored matches.

For match 15491 the repaired API contains 19 source roster rows per side and the UI selects 17 active players per side. Cronulla-Sutherland has 5 tries and 3 goals for 26 points; North Queensland has 3 tries and 2 goals for 16 points. The production bundle test returned a working match page, `/api/match-detail`, in-page full-stat anchor, and no obsolete match-specific query-builder link.

Commands used for repeatable verification:

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run audit:current-season -- --database <database> --season 2026 --competitions NRL,NRLW
```

## Production deployment

On 2026-09-16, commit `854f91f79f6be97faf3f5d8c635419165269f12b` was installed with the standard elevated installer. The installer restored `RLDB-Direct-Node-Supervisor` under the restricted `DESKTOP-ASRAPT8\rldbsvc` account and verified the candidate and operational health endpoints.

The installed supervisor then ran the normal staged weekly-update workflow. It prepared and validated the rebuilt database while the live API remained available, briefly stopped the candidate for promotion, retained the displaced database at `C:\RLDB\data\previous\rldb.sqlite`, and restarted the backend, telemetry service, and tunnel. Promotion completed at `2026-09-15T21:24:46.311Z`; both candidate and operational health checks returned HTTP 200.

The independent current-season audit was rerun directly against `C:\RLDB\data\rldb.sqlite` after promotion. All 274 NRL/NRLW matches passed. Match 15491 has 19 stored source roster rows and 17 displayed active players per side, no duplicate active jumpers, 55 normalized team statistics per side, and correct 26-16 scoring attribution. An unauthenticated public HTTPS probe reached `rldb.drein.net` and received the expected HTTP 401 authentication challenge.
