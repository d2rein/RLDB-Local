# Query performance telemetry

The operational hybrid backend records query performance in a separate local
SQLite database:

`runtime-data/telemetry/query-performance.sqlite`

The statistics database is not modified. Records are retained indefinitely.

## Runtime

- Backend: `127.0.0.1:8797`
- Telemetry sidecar: `127.0.0.1:8798`
- Sidecar health: `http://127.0.0.1:8798/health`
- Sidecar logs: `runtime-logs/telemetry.out.log` and
  `runtime-logs/telemetry.err.log`

The normal hybrid backend starter starts the sidecar first. Telemetry failures
are asynchronous, bounded to one second, and never replace or alter a query
response or error.

## Reports

```powershell
npm run telemetry:report
node .\scripts\report-query-telemetry.mjs --days 0
node .\scripts\report-query-telemetry.mjs --format csv --days 0
```

`--days 0` includes all retained records.

## Limits and privacy

- Complete event: 512 KiB hard cap.
- Request input: 64 KiB.
- SQL text: 128 KiB per statement.
- Bound parameters: 64 KiB per statement.
- Error details: 16 KiB.
- Statements: 100 per request.
- Sidecar queue: 5,000 events.

Truncated fields receive explicit markers. Cookies, authentication data,
secrets, environment variables, request headers and client IP addresses are
not stored. Query-string keys resembling secrets or IP addresses are omitted.

## Versioning

Clean builds use the first 12 Git commit characters. Dirty builds use:

`<commit>-dirty.<content-fingerprint>`

The schema version is a hash of the ordered migration files. The sidecar adds
these values when the Worker does not provide them.

## Instrumented D1 methods

Current repository usage requires `prepare`, `bind`, `all`, `first` and `run`.
The wrapper intercepts only those methods and delegates every other property or
method. It returns original result objects unchanged and rethrows the same
error object.

## Rollback

The pre-telemetry operational checkpoint is:

`rollback/pre-stage1-query-telemetry-2026-07-24`

To disable telemetry without reverting source, remove `TELEMETRY_ENDPOINT` from
the local Wrangler variables and restart the backend. The query wrapper then
uses the original direct handler path.
