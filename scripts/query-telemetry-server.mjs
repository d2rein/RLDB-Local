import fsPromises from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const host = process.env.RLDB_TELEMETRY_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.RLDB_TELEMETRY_PORT || "8798", 10);
const databasePath = path.resolve(
  process.env.RLDB_TELEMETRY_DB_PATH
    || path.join(projectRoot, "runtime-data", "telemetry", "query-performance.sqlite")
);
const migrationsDirectory = path.join(projectRoot, "migrations", "telemetry");
const expectedToken = process.env.RLDB_TELEMETRY_TOKEN || "";
const defaultApplicationVersion = process.env.RLDB_APPLICATION_VERSION || "unknown";
const defaultSchemaVersion = process.env.RLDB_SCHEMA_VERSION || "unknown";
const maxPayloadBytes = 512 * 1024;
const maxQueueLength = 5000;
const flushIntervalMs = 250;
const flushBatchSize = 50;

await fsPromises.mkdir(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
await applyTelemetryMigrations();

const insertEvent = database.prepare(`
  INSERT INTO query_events (
    recorded_at_utc, request_id, endpoint, request_input_json, query_shape_hash,
    query_category, database_execution_ms, application_post_processing_ms,
    total_request_ms, rows_fetched, database_rows_read, rows_returned,
    response_status, error_name, error_message, application_version,
    database_schema_version, request_source, statement_count, truncation_markers_json,
    request_started_at_utc, last_progress_at_utc, completed_at_utc, lifecycle_state,
    execution_route
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(request_id) DO UPDATE SET
    recorded_at_utc = excluded.recorded_at_utc,
    endpoint = excluded.endpoint,
    request_input_json = excluded.request_input_json,
    query_shape_hash = excluded.query_shape_hash,
    query_category = excluded.query_category,
    database_execution_ms = excluded.database_execution_ms,
    application_post_processing_ms = excluded.application_post_processing_ms,
    total_request_ms = excluded.total_request_ms,
    rows_fetched = excluded.rows_fetched,
    database_rows_read = excluded.database_rows_read,
    rows_returned = excluded.rows_returned,
    response_status = excluded.response_status,
    error_name = excluded.error_name,
    error_message = excluded.error_message,
    application_version = excluded.application_version,
    database_schema_version = excluded.database_schema_version,
    request_source = excluded.request_source,
    statement_count = excluded.statement_count,
    truncation_markers_json = excluded.truncation_markers_json,
    request_started_at_utc = COALESCE(query_events.request_started_at_utc, excluded.request_started_at_utc),
    last_progress_at_utc = excluded.last_progress_at_utc,
    completed_at_utc = excluded.completed_at_utc,
    lifecycle_state = excluded.lifecycle_state,
    execution_route = excluded.execution_route
`);
const selectEventId = database.prepare("SELECT event_id FROM query_events WHERE request_id = ?");
const deleteEventStatements = database.prepare("DELETE FROM query_statements WHERE event_id = ?");
const insertStatement = database.prepare(`
  INSERT INTO query_statements (
    event_id, ordinal, method, sql_text, normalized_sql, parameters_json,
    duration_ms, rows_fetched, database_rows_read, error_name, error_message,
    started_at_utc, completed_at_utc, lifecycle_state,
    runtime_diagnostics_json, query_plan_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const queue = [];
let flushInProgress = false;
let stopping = false;

function normalizeSql(sql) {
  return String(sql ?? "").replace(/\s+/g, " ").trim();
}

function effectiveVersion(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized && normalized !== "unknown" ? normalized : fallback;
}

function insertTelemetryEvent(event) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const requestId = String(event.requestId ?? "");
    insertEvent.run(
      String(event.recordedAtUtc ?? new Date().toISOString()),
      requestId,
      String(event.endpoint ?? ""),
      JSON.stringify(event.requestInput ?? {}),
      String(event.queryShapeHash ?? ""),
      String(event.queryCategory ?? "unknown"),
      Number(event.databaseExecutionMs ?? 0),
      Number(event.applicationPostProcessingMs ?? 0),
      Number(event.totalRequestMs ?? 0),
      Number(event.rowsFetched ?? 0),
      Number(event.databaseRowsRead ?? 0),
      event.rowsReturned === null || event.rowsReturned === undefined ? null : Number(event.rowsReturned),
      Number(event.responseStatus ?? 0),
      event.errorName ? String(event.errorName) : null,
      event.errorMessage ? String(event.errorMessage) : null,
      effectiveVersion(event.applicationVersion, defaultApplicationVersion),
      effectiveVersion(event.databaseSchemaVersion, defaultSchemaVersion),
      String(event.requestSource ?? "development"),
      Array.isArray(event.statements) ? event.statements.length : 0,
      JSON.stringify(event.truncationMarkers ?? []),
      event.requestStartedAtUtc ? String(event.requestStartedAtUtc) : String(event.recordedAtUtc ?? new Date().toISOString()),
      event.lastProgressAtUtc ? String(event.lastProgressAtUtc) : String(event.recordedAtUtc ?? new Date().toISOString()),
      event.completedAtUtc ? String(event.completedAtUtc) : null,
      String(event.lifecycleState ?? (Number(event.responseStatus) === 102 ? "request_started" : "completed")),
      event.executionRoute ? String(event.executionRoute) : null
    );
    const eventRow = selectEventId.get(requestId);
    if (!eventRow) throw new Error(`Unable to resolve telemetry event ${requestId} after upsert.`);
    const eventId = Number(eventRow.event_id);
    deleteEventStatements.run(eventId);
    for (const statement of event.statements ?? []) {
      insertStatement.run(
        eventId,
        Number(statement.ordinal ?? 0),
        String(statement.method ?? ""),
        String(statement.sql ?? ""),
        normalizeSql(statement.sql),
        JSON.stringify(statement.parameters ?? []),
        Number(statement.durationMs ?? 0),
        Number(statement.rowsFetched ?? 0),
        statement.databaseRowsRead === null || statement.databaseRowsRead === undefined
          ? null
          : Number(statement.databaseRowsRead),
        statement.errorName ? String(statement.errorName) : null,
        statement.errorMessage ? String(statement.errorMessage) : null,
        statement.startedAtUtc ? String(statement.startedAtUtc) : null,
        statement.completedAtUtc ? String(statement.completedAtUtc) : null,
        String(statement.lifecycleState ?? "completed"),
        statement.runtimeDiagnostics ? JSON.stringify(statement.runtimeDiagnostics) : null,
        statement.queryPlan ? JSON.stringify(statement.queryPlan) : null
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function applyTelemetryMigrations() {
  const migrationNames = (await fsPromises.readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/i.test(name))
    .sort();
  const initialMigration = migrationNames.find((name) => name.startsWith("0001"));
  if (!initialMigration) throw new Error("Missing initial telemetry migration.");
  database.exec(await fsPromises.readFile(path.join(migrationsDirectory, initialMigration), "utf8"));
  const wasApplied = database.prepare(
    "SELECT 1 AS applied FROM telemetry_migrations WHERE migration_name = ?"
  );
  const recordMigration = database.prepare(
    "INSERT OR IGNORE INTO telemetry_migrations (migration_name, applied_at_utc) VALUES (?, ?)"
  );
  for (const migrationName of migrationNames) {
    if (migrationName === initialMigration || wasApplied.get(migrationName)) continue;
    const sql = await fsPromises.readFile(path.join(migrationsDirectory, migrationName), "utf8");
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
        try {
          database.exec(`${statement};`);
        } catch (error) {
          // SQLite does not support ADD COLUMN IF NOT EXISTS. Older installed
          // sidecars applied lifecycle columns before migrations were tracked.
          if (!String(error?.message ?? error).includes("duplicate column name")) throw error;
        }
      }
      recordMigration.run(migrationName, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function flushQueue() {
  if (flushInProgress || queue.length === 0) return;
  flushInProgress = true;
  const batch = queue.slice(0, flushBatchSize);
  try {
    for (const event of batch) insertTelemetryEvent(event);
    queue.splice(0, batch.length);
  } catch (error) {
    console.error("Telemetry SQLite flush failed; queued events retained for retry.", error);
  } finally {
    flushInProgress = false;
  }
}

const flushTimer = setInterval(flushQueue, flushIntervalMs);
flushTimer.unref();

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, queued: queue.length, databasePath }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/events") {
    response.writeHead(404).end();
    return;
  }
  if (expectedToken && request.headers["x-rldb-telemetry-token"] !== expectedToken) {
    response.writeHead(401).end();
    return;
  }
  if (queue.length >= maxQueueLength) {
    response.writeHead(503, { "retry-after": "1" }).end();
    return;
  }

  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength > maxPayloadBytes) {
    response.writeHead(413).end();
    request.resume();
    return;
  }

  const chunks = [];
  let receivedBytes = 0;
  request.on("data", (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes <= maxPayloadBytes) chunks.push(chunk);
  });
  request.on("end", () => {
    if (receivedBytes > maxPayloadBytes) {
      response.writeHead(413).end();
      return;
    }
    try {
      const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!event || typeof event.requestId !== "string" || typeof event.endpoint !== "string") {
        response.writeHead(400).end();
        return;
      }
      queue.push(event);
      response.writeHead(202).end();
      if (queue.length >= flushBatchSize) setImmediate(flushQueue);
    } catch {
      response.writeHead(400).end();
    }
  });
});

server.requestTimeout = 2000;
server.headersTimeout = 2000;
server.keepAliveTimeout = 1000;
server.maxRequestsPerSocket = 100;
server.listen(port, host, () => {
  console.log(`RLDB query telemetry listening on http://${host}:${port}`);
  console.log(`Telemetry database: ${databasePath}`);
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(flushTimer);
  server.close(() => {
    while (queue.length > 0) flushQueue();
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
