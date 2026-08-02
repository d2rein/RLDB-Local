# Early candidate benchmark comparison

Date: 2026-07-31

This is a diagnostic comparison, not yet a production cutover approval.
The operational service remained on ports 8797/8798 and was not modified.
The candidate was tested on port 8899 with its independent SQLite database.

## Data and implementation parity

- Operational and candidate data cutoffs match: NRL Round 20, NRLW Round 2,
  State of Origin Game 2, and Women's State of Origin Game 3 for 2026.
- Normalized schemas match.
- Both databases contain 26 tables and 26 indexes.
- Core table row counts match.
- Stat definitions and query-telemetry source files match exactly.
- The candidate uses the production application query engine with
  candidate-only direct-SQLite compatibility and aggregate-path
  optimizations.

## Existing hybrid baseline

The previous complete hybrid benchmark ran 35 cases with one cold and five
warm observations per case:

- correctness result at capture time: 35/35;
- total duration: 1,944.16 seconds (about 32.4 minutes).

The stored expected results are no longer a reliable current correctness
oracle. Later imports and production fixes changed valid answers, while tied
rows can be selected in a different order at a result limit.

## Candidate diagnostic run

A one-observation run completed 34 of 35 cases in 642.82 seconds. The omitted
case, "Games played where tries = 0", monopolized synchronous `node:sqlite`
for more than five minutes. "Longest streak without a try" exceeded the
diagnostic run's 120-second client ceiling.

The first comparison reported 23/34 passes. After restoring production API
fields in optimized aggregate responses, a focused rerun left seven apparent
failures. Direct comparison with the current operational API classified all
seven as baseline or tie-comparison problems:

- four candidate responses exactly matched current production;
- three selected different rows only within equal-value tie groups at the
  result boundary.

No differing statistic or aggregation value has been identified in those
seven cases.

## Complete worker-isolated candidate run

After moving application requests onto a cancellable SQLite worker, the full
35-case suite completed with one first observation and five warm observations
per case:

- 210 observations completed;
- no timeout or service failure;
- total duration: 368.56 seconds (about 6.1 minutes);
- sum of hybrid warm medians: 275.04 seconds;
- sum of candidate warm medians: 51.70 seconds;
- candidate aggregate warm-median speedup: 5.32x;
- candidate faster on 29 of 35 cases and slower on 6 small cases.

The report is `reports/benchmarks/benchmark-2026-08-02T11-41-06-950Z.md`.
Its 28/35 displayed correctness result is the stale/tie comparison described
above, not seven newly discovered candidate defects.

Selected warm medians:

| Query | Hybrid | Candidate | Speedup |
| --- | ---: | ---: | ---: |
| Leading try scorers | 25,133 ms | 135 ms | 186.3x |
| NRLW tries by season | 2,597 ms | 11 ms | 240.2x |
| Top player tries | 25,045 ms | 140 ms | 179.3x |
| Most tries in a game | 32,795 ms | 3,322 ms | 9.9x |
| Combined NRL and Origin tries | 22,544 ms | 149 ms | 151.7x |
| Games where tries = 0 | 11,264 ms | 6,903 ms | 1.6x |
| Longest streak without a try | 19,903 ms | 13,038 ms | 1.5x |

The largest regression was the small team-season condition query: 21 ms on
hybrid versus 116 ms on candidate. This is not user-significant compared with
the multi-second improvements, but it remains an optimization investigation
item.

## Direct timing samples

These are single read-only observations against the current operational and
candidate services, so they are directional rather than a final benchmark.

| Query | Operational | Candidate |
| --- | ---: | ---: |
| Leading try scorers (200 rows) | 21,491 ms | 147 ms |
| Top 10 player points | 414 ms | 137 ms |
| Most points in a season | 446 ms | 203 ms |
| NRLW player tries by season | 4,837 ms | 32 ms |
| State of Origin player points | 38 ms | 45 ms |
| Combined NRL and Origin tries | 21,780 ms | 153 ms |
| Team seasons with more than 14 wins | 111 ms | 104 ms |

The candidate is substantially faster on persisted player aggregate paths.
Small team and Origin queries are broadly comparable.

## Reliability finding

The direct-SQLite adapter currently calls synchronous `node:sqlite` on the
HTTP event loop. A pathological SQL statement therefore blocks health checks
and all unrelated requests even though the process has not crashed.

A candidate-only source change moves whole application requests to one
bounded query worker. Controlled testing confirmed:

- one query worker to bound memory use;
- no arbitrary timeout for a legitimate long query;
- health responded in 89 ms while the known expensive query was running;
- client cancellation replaced the query worker and cleared abandoned work;
- the next normal query completed in 319 ms without a service restart;
- production remains untouched.

The worker change built successfully, passed 2/2 adapter tests and 6/6 smoke
checks, passed the cancellation test, and completed the full benchmark. It
must still be installed and verified under the `rldbsvc` account.

## Why the old cutoff did not preserve expected answers

The case inputs use `seasonTo=2026`. They do not include an intra-season
round or match-date cutoff. The baseline metadata says Round 20, but the
runner's snapshot ID was derived from freshness metadata and schema version;
it was not an immutable database snapshot hash. Once later games or data
corrections are loaded, running those same URLs can legitimately return new
answers.

For a durable historical correctness baseline, future runs must execute
against an immutable database copy (or every case must include an enforceable
match-date/round cutoff). The current operational and candidate databases
were directly checked to have matching cutoffs and core contents before this
comparison.

## Why match tries previously passed validation but broke the site

The old suite contained "Most tries in a game," but the hybrid request took
about 33 seconds. The test only checked that this one request eventually
returned the expected rows. It did not check health concurrently, issue a
second query immediately afterward, simulate browser navigation/cancellation,
or cover first/second-half match scoring. A single-threaded backend could
therefore pass while remaining monopolized and making the UI appear frozen.

The worker-isolation tests now cover health during an expensive query,
cancellation recovery, and a successful query immediately afterward. The
benchmark set should also gain explicit first-half and second-half match
cases in its next baseline revision.

## Next benchmark requirements

1. Correct tie normalization, including ties cut by a row limit.
2. Capture correctness against a real immutable SQLite snapshot.
3. Add first/second-half and post-query responsiveness cases.
4. Record the target candidate commit rather than the runner repository
   commit in benchmark metadata.
5. Compare database time separately from application and network time.
