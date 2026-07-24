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
const migrationPath = path.join(projectRoot, "telemetry", "migrations", "0001_query_performance.sql");
const expectedToken = process.env.RLDB_TELEMETRY_TOKEN || "";
const defaultApplicationVersion = process.env.RLDB_APPLICATION_VERSION || "unknown";
const defaultSchemaVersion = process.env.RLDB_SCHEMA_VERSION || "unknown";
const maxPayloadBytes = 512 * 1024;
const maxQueueLength = 5000;
const flushIntervalMs = 250;
const flushBatchSize = 50;

await fsPromises.mkdir(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(await fsPromises.readFile(migrationPath, "utf8"));

const insertEvent = database.prepare(`
  INSERT INTO query_events (
    recorded_at_utc, request_id, endpoint, request_input_json, query_shape_hash,
    query_category, database_execution_ms, application_post_processing_ms,
    total_request_ms, rows_fetched, database_rows_read, rows_returned,
    response_status, error_name, error_message, application_version,
    database_schema_version, request_source, statement_count, truncation_markers_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertStatement = database.prepare(`
  INSERT INTO query_statements (
    event_id, ordinal, method, sql_text, normalized_sql, parameters_json,
    duration_ms, rows_fetched, database_rows_read, error_name, error_message
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const result = insertEvent.run(
      String(event.recordedAtUtc ?? new Date().toISOString()),
      String(event.requestId ?? ""),
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
      JSON.stringify(event.truncationMarkers ?? [])
    );
    const eventId = Number(result.lastInsertRowid);
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
        statement.errorMessage ? String(statement.errorMessage) : null
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
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
