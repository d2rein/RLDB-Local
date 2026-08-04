# Public candidate validation - 2026-08-04

## Routing and isolation

- Production: `https://rldb.drein.net` through tunnel `rldb-backend` to
  `127.0.0.1:8797`.
- Candidate: `https://rldb-test.drein.net` through separate tunnel
  `rldb-candidate` to `127.0.0.1:8899`.
- The candidate tunnel is supervised by `RLDB-Direct-Node-Supervisor` under
  the restricted `rldbsvc` Windows account.
- Production routing, processes, database, and tunnel were not changed.

## External-path checks

The candidate passed the complete public path through Cloudflare:

| Check | Result | Observed time |
| --- | --- | ---: |
| Unauthenticated password gate | HTTP 401 | - |
| Password login and session cookie | HTTP 302, cookie issued | - |
| Home page | HTTP 200 | 263 ms |
| Bootstrap | HTTP 200 | 1,961 ms |
| First-half team points by match | HTTP 200 | 3,970 ms |
| Player tries by match | HTTP 200 | 72,923 ms |
| Leading try scorers | HTTP 200 | 3,867 ms |
| Immediate follow-up margin query | HTTP 200 | 159 ms |

The expensive player-match query completed and did not wedge the server.
Telemetry attributed about 71 seconds to SQLite execution and about 5 ms to
application processing. Repeating it over loopback produced the same timing,
so the delay is not caused by Cloudflare Tunnel or authentication.

## Public comparison

The public parity runner compared normalized endpoint responses and recorded
these representative timings:

| Endpoint | Production | Candidate |
| --- | ---: | ---: |
| Bootstrap | 2,989 ms | 2,487 ms |
| Players | 224 ms | 254 ms |
| Leading try scorers | 90,014 ms | 3,357 ms |
| Alex Johnston profile | 3,538 ms | 1,571 ms |
| Billy Slater rank cards | 5,222 ms | 890 ms |
| 2026 season index | 2,805 ms | 1,427 ms |
| Match detail | 554 ms | 150 ms |

The returned data is intentionally not identical because the databases have
different live cutoffs:

- production: NRL Round 20 and NRLW Round 2;
- candidate: NRL Round 22 and NRLW Round 5.

Observed differences (new matches, players, scores, and totals) follow that
freshness gap. They must not be treated as candidate regressions or normalized
away. A strict same-data parity run requires an explicit common database
snapshot or cutoff-capable query set.

## Current decision

The candidate is ready for user acceptance testing at the test hostname. Do
not change `rldb.drein.net` until that review is complete. Keep the operational
service and tunnel intact as the immediate rollback path for any later routing
cutover.
