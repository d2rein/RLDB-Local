# Candidate index audit - 2026-08-03

## Scope and safety

This audit used only the independent candidate database at
`rldb-direct-node-runtime/data/rldb.sqlite`. It did not modify the operational
service on ports 8797/8798 or the operational database under `C:\RLDB`.

The audit created each proposed index individually, recorded query plans and
timings, then dropped it. The raw machine-readable report is generated at
`reports/indexes/proposed-index-audit.json` (ignored runtime output).

## Existing coverage

The candidate inherited 26 application indexes. Important existing coverage
includes:

- player match lookup by `(player_id, season, match_date_utc)` and by
  `(match_id, team_id)`;
- team match lookup by `(team_id, season, match_date_utc)`;
- matches by `(competition_id, season, round_index, match_date_utc)`, home team,
  and away team;
- player/team EAV statistic lookup and value indexes;
- player aggregate leaderboard/entity/source indexes;
- team season aggregate leaderboard/entity indexes.

Historical production telemetry showed that the worst old paths read millions
of rows. The direct-Node candidate's large benchmark improvement comes mainly
from using persisted aggregate routes rather than from adding the three indexes
below.

## Proposed indexes tested

### `idx_player_match_summary_lookup`

Definition: `(player_id, season, team_id)`

- Build: about 0.93 seconds; about 5.67 MB allocated.
- Resolved-ID lookup median: 4.86 ms before, 4.51 ms after.
- Application-shaped player/team-name lookup: 558 ms before, 535 ms after.
- Plan for the application-shaped lookup remained `SCAN s` because
  `COALESCE(p.display_name, s.player_name_raw)` cannot use this index.

Decision: **reject as written**. The small gain does not justify a largely
overlapping 5.67 MB index. A future improvement should resolve a selected player
name to player IDs before querying summaries, rather than adding this index.

### `idx_team_match_summary_lookup`

Definition: `(team_id, season, opponent_team_id)`

- Build: about 0.06 seconds; about 0.44 MB allocated.
- Resolved-ID team/opponent median: 10.61 ms before, 0.40 ms after.
- Actual name-join query median: 11.80 ms before, 0.63 ms after.
- The query planner selected the new index for the real application shape.

Decision: **keep**. It materially improves team-versus-opponent filtering for
negligible storage and build cost. It is migration
`0008_team_opponent_lookup.sql` and is applied during candidate development
startup and installation.

### `idx_matches_lookup`

Definition: `(season, competition_id, match_id)`

- Build: about 0.01 seconds; about 0.22 MB allocated.
- Normal competition/season ordering continued to use the existing covering
  `(competition_id, season, round_index, match_date_utc)` index.
- Match-ID lookups continued to use the integer primary key.
- Only a synthetic `ORDER BY match_id` improved slightly (0.20 to 0.18 ms).

Decision: **reject**. The index is redundant for real lookup paths and has the
less useful leading-column order.

## Regression result

With the retained team/opponent index present, the complete 35-case suite ran
all 210 requests (one cold and five warm observations). Correctness remained the
known 28 passing / 7 stale-or-tied-baseline pattern; no new mismatch appeared.

The first post-index report cannot be used for timing because the benchmark
runner accepted telemetry's initial HTTP 102 start marker as a completed event,
recording some durations as zero. The affected ignored report is under
`reports/indexes/post-index-benchmark/`.

A second complete-coverage wall-clock run used one cold and one warm observation
with telemetry lookup disabled:

- 35/35 cases executed without service recovery;
- total run duration: 121.90 seconds;
- sum of warm query durations: 51,697.92 ms before vs 51,351.40 ms after
  (0.7% faster, effectively neutral at this sample size);
- correctness remained 28/7 with exactly the existing baseline issues.

The valid report is under `reports/indexes/post-index-wall-clock/` (ignored
runtime output). The Stage 2 benchmark runner should later wait for a telemetry
event whose `response_status` is not 102 before using its timing fields.

## Conclusion

No current benchmark path shows an obvious missing-index emergency. The slowest
remaining benchmark cases are broad player condition/streak aggregations; the
tested summary/match indexes do not change their plans. Keep the small
team/opponent index, reject the other two proposals, and treat player-name
resolution as a separate measured query-routing improvement rather than an
index addition.
