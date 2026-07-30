# Candidate performance baseline - 2026-07-31

## Scope

This focused benchmark investigated the installed direct-Node candidate's
all-time NRL player tries query. No production route, schema, index, or data was
changed.

The candidate returned the correct result: Alex Johnston with 230 tries.

## Observed API performance

Two completed candidate API requests were recorded by persistent telemetry:

| Total | Database | Post-processing | Status |
| ---: | ---: | ---: | ---: |
| 213.21 s | 213.16 s | 49.59 ms | 200 |
| 186.52 s | 186.48 s | 39.04 ms | 200 |

The generated SQL performs the same full aggregation twice: once for the
leaderboard rows and once for the result count. Each pass uses correlated
scalar lookups into `player_match_stat_values`, takes approximately 93-107
seconds, and builds temporary grouping and sorting B-trees.

The delay is database execution, not Node response processing.

## Equivalent SQL experiments

### Set-based, single-pass match-summary query

The equivalent query was rewritten read-only to:

- join stat values once;
- aggregate once;
- obtain the total row count with a window function.

It returned Alex Johnston with 230 tries and 8,079 grouped players.

| Observation | Duration |
| --- | ---: |
| First | 48.91 s |
| Warm minimum | 3.14 s |
| Warm median | 3.29 s |
| Warm maximum | 3.81 s |

### Existing persisted season aggregates

The equivalent unfiltered career query was run against the existing
`player_stat_aggregates` season rows. The focused timing experiment returned
Alex Johnston with 230 tries.

| Observation | Duration |
| --- | ---: |
| First | 2.69 s |
| Warm minimum | 87.07 ms |
| Warm median | 89.82 ms |
| Warm maximum | 93.79 ms |

The existing aggregate index was used:

`idx_player_stat_aggregates_source_scope_stat_season_player`

## Reliability finding

The first service supervisor crashed independently of the query because
overlapping asynchronous status writes raced on the same temporary filename.
Commit `f324df0` serializes reconciliation, uses unique atomic-write temporary
files, and treats reconciliation failures as logged retryable events. The
fixed release is installed and healthy on `127.0.0.1:8899`.

## Recommendation

Do not add a one-off leading-tries shortcut.

Refactor generic leaderboard SQL generation so equivalent query shapes use
set-based joins and calculate rows plus total count in one pass. Use persisted
aggregates through a general eligibility rule only when all requested filters,
grouping, conditions, and selected statistics are represented by those
aggregates. Fall back to the corrected set-based match-summary route otherwise.

Run the complete correctness/performance benchmark after this general
refactor. Running all 35 cases before correcting this known 186-second path
would be unnecessarily slow and would not provide a useful candidate baseline.

## Implemented candidate optimization

The isolated candidate now applies that recommendation:

- unfiltered player totals and averages in `overall` or `season` format use
  the existing persisted season aggregates;
- other player aggregate paths use indexed joins to
  `player_match_stat_values` instead of correlated scalar subqueries;
- SQL-paged player paths obtain their total row count in the result query
  instead of repeating the complete aggregation.

Before enabling the aggregate route, a direct audit confirmed that the
canonical match-summary and persisted-aggregate routes both contain 8,079 NRL
players and produce identical all-time try totals for every player.

The operational and candidate databases were also compared directly. They
have identical normalized schema definitions, 26 tables, 26 indexes, matching
row counts in all core summary/value/aggregate tables, and the same data
cutoff.

Focused isolated results after the change:

- leading player tries: Alex Johnston, 230; 3.4 seconds on the first measured
  request and 0.23 seconds in the smoke run;
- full-results leading tries: Alex Johnston, 230; 8,079 total rows; 0.61
  seconds;
- player tries by match: Frank Burge, 8; approximately 3.5 seconds when warm;
- first-half team points by match: HTTP 200 in 5.1 seconds.

The first historical match-level request can still be much slower when the
2.3 GB SQLite file is not cached. This is database I/O rather than application
post-processing and remains a benchmark/index investigation item.

## Local reports

Detailed ignored runtime reports are retained at:

- `reports/query-performance/installed/query-performance-2026-07-30T22-48-19-442Z.md`
- `reports/query-performance/installed/leading-tries-diagnostic.json`
- `reports/query-performance/installed/leading-tries-sql-benchmark.md`
- `reports/query-performance/installed/leading-tries-aggregate-benchmark.md`
