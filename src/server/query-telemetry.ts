export type QueryTelemetryEnv = {
  TELEMETRY_ENDPOINT?: string;
  TELEMETRY_TOKEN?: string;
  APP_VERSION?: string;
  SCHEMA_VERSION?: string;
  RUNTIME_MODE?: string;
};

type StatementMethod = "all" | "first" | "run";

export type QueryStatementTelemetry = {
  ordinal: number;
  method: StatementMethod;
  sql: string;
  parameters: unknown[];
  durationMs: number;
  rowsFetched: number;
  databaseRowsRead: number | null;
  errorName: string | null;
  errorMessage: string | null;
};

export type QueryTelemetryCollector = {
  statements: QueryStatementTelemetry[];
  databaseExecutionMs: number;
  rowsFetched: number;
  databaseRowsRead: number;
  activeStatements: number;
  activeGroupStartedAt: number | null;
};

type QueryTelemetryEvent = {
  recordedAtUtc: string;
  requestId: string;
  endpoint: string;
  requestInput: Record<string, unknown>;
  queryShapeHash: string;
  queryCategory: string;
  databaseExecutionMs: number;
  applicationPostProcessingMs: number;
  totalRequestMs: number;
  rowsFetched: number;
  databaseRowsRead: number;
  rowsReturned: number | null;
  responseStatus: number;
  errorName: string | null;
  errorMessage: string | null;
  applicationVersion: string;
  databaseSchemaVersion: string;
  requestSource: "production" | "development" | "benchmark";
  statements: QueryStatementTelemetry[];
  truncationMarkers: string[];
};

const TRACKED_ENDPOINTS = new Set([
  "/api/query",
  "/api/query/full",
  "/api/export",
  "/api/player-profile",
  "/api/player-rank-cards",
  "/api/match-detail",
  "/api/season-index",
]);
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|password|secret|token|environment|client.?ip|ip.?address)/i;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_REQUEST_INPUT_CHARS = 64 * 1024;
const MAX_SQL_CHARS = 128 * 1024;
const MAX_PARAMETERS_CHARS = 64 * 1024;
const MAX_ERROR_CHARS = 16 * 1024;
const MAX_STATEMENTS = 100;
const DELIVERY_TIMEOUT_MS = 3000;

let lastDeliveryWarningAt = 0;

function nowMs(): number {
  return performance.now();
}

function errorDetails(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message || String(error) };
  }
  return { name: "Error", message: String(error) };
}

function rowsFetchedFromResult(method: StatementMethod, result: unknown): number {
  if (method === "first") return result === null || result === undefined ? 0 : 1;
  if (method === "all" && result && typeof result === "object") {
    const rows = (result as { results?: unknown[] }).results;
    return Array.isArray(rows) ? rows.length : 0;
  }
  return 0;
}

function databaseRowsReadFromResult(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const meta = (result as { meta?: { rows_read?: unknown } }).meta;
  const rowsRead = Number(meta?.rows_read);
  return Number.isFinite(rowsRead) ? rowsRead : null;
}

function wrapPreparedStatement(
  statement: D1PreparedStatement,
  sql: string,
  parameters: unknown[],
  collector: QueryTelemetryCollector
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property, receiver) {
      if (property === "bind") {
        return (...values: unknown[]) =>
          wrapPreparedStatement(target.bind(...values), sql, values, collector);
      }
      if (property === "all" || property === "first" || property === "run") {
        const method = property as StatementMethod;
        return async (...args: unknown[]) => {
          const startedAt = nowMs();
          if (collector.activeStatements === 0) collector.activeGroupStartedAt = startedAt;
          collector.activeStatements += 1;
          let result: unknown;
          let caughtError: unknown = null;
          try {
            const original = Reflect.get(target, property, receiver) as (...methodArgs: unknown[]) => Promise<unknown>;
            result = await original.apply(target, args);
            return result;
          } catch (error) {
            caughtError = error;
            throw error;
          } finally {
            const durationMs = nowMs() - startedAt;
            collector.activeStatements -= 1;
            if (collector.activeStatements === 0 && collector.activeGroupStartedAt !== null) {
              collector.databaseExecutionMs += nowMs() - collector.activeGroupStartedAt;
              collector.activeGroupStartedAt = null;
            }
            const fetched = rowsFetchedFromResult(method, result);
            const rowsRead = databaseRowsReadFromResult(result);
            const details = caughtError === null ? null : errorDetails(caughtError);
            collector.rowsFetched += fetched;
            collector.databaseRowsRead += rowsRead ?? 0;
            collector.statements.push({
              ordinal: collector.statements.length + 1,
              method,
              sql,
              parameters: parameters.slice(),
              durationMs,
              rowsFetched: fetched,
              databaseRowsRead: rowsRead,
              errorName: details?.name ?? null,
              errorMessage: details?.message ?? null,
            });
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1PreparedStatement;
}

export function instrumentD1Database(
  database: D1Database,
  collector: QueryTelemetryCollector
): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => wrapPreparedStatement(target.prepare(sql), sql, [], collector);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

function truncateText(value: string, maxChars: number, markerName: string, markers: string[]): string {
  if (value.length <= maxChars) return value;
  markers.push(`${markerName}:original_chars=${value.length}`);
  const suffix = `...[TRUNCATED original_chars=${value.length}]`;
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function safeJsonValue(value: unknown, maxChars: number, markerName: string, markers: string[]): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length <= maxChars) return value;
  return truncateText(encoded, maxChars, markerName, markers);
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function sanitizedRequestInput(url: URL, markers: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [...new Set(url.searchParams.keys())].sort()) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    const values = url.searchParams.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return safeJsonValue(result, MAX_REQUEST_INPUT_CHARS, "request_input", markers) as Record<string, unknown>;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function queryCategory(url: URL): string {
  if (url.pathname === "/api/query" || url.pathname === "/api/query/full") {
    const scope = url.searchParams.get("scope") ?? "player";
    const mode = url.searchParams.get("mode") ?? "totals";
    const format = url.searchParams.get("format") ?? "overall";
    return `${url.pathname === "/api/query/full" ? "full" : "leaderboard"}.${scope}.${mode}.${format}`;
  }
  if (url.pathname === "/api/export") return `export.${url.searchParams.get("dataset") ?? "unknown"}`;
  return url.pathname.replace(/^\/api\//, "").replace(/\//g, ".");
}

function requestSource(request: Request, env: QueryTelemetryEnv): "production" | "development" | "benchmark" {
  if (request.headers.get("x-rldb-query-source") === "benchmark") return "benchmark";
  if (request.headers.get("x-rldb-proxied-by") === "cloudflare-public-site") return "production";
  return env.RUNTIME_MODE === "production" ? "production" : "development";
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function structuralRequestShape(url: URL): Record<string, unknown> {
  const conditions = (() => {
    try {
      const parsed = JSON.parse(url.searchParams.get("conditions") ?? "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.map((condition) => ({
        statKey: String(condition?.statKey ?? ""),
        operator: String(condition?.operator ?? ""),
        joiner: String(condition?.joiner ?? ""),
        hasValue: condition?.value !== null && condition?.value !== undefined,
      }));
    } catch {
      return [{ invalidConditionsJson: true }];
    }
  })();
  const specificFilters = [
    "team", "opponent", "venue", "referee", "position", "player", "matchPlayer",
    "groundCondition", "weatherCondition", "homeAway", "result",
  ].filter((key) => {
    const value = url.searchParams.get(key);
    return value !== null && value !== "" && value.toLowerCase() !== "any";
  });
  return {
    endpoint: url.pathname,
    scope: url.searchParams.get("scope"),
    statKey: url.searchParams.get("statKey"),
    mode: url.searchParams.get("mode"),
    format: url.searchParams.get("format"),
    scoreHalf: url.searchParams.get("scoreHalf"),
    sortColumn: url.searchParams.get("sortColumn"),
    sortDirection: url.searchParams.get("sortDirection"),
    columns: url.searchParams.get("columns"),
    specificFilters,
    conditions,
  };
}

async function responseDetails(response: Response): Promise<{
  rowsReturned: number | null;
  errorName: string | null;
  errorMessage: string | null;
}> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { rowsReturned: null, errorName: response.ok ? null : "HttpError", errorMessage: null };
  }
  try {
    const payload = await response.clone().json<Record<string, unknown>>();
    const rows = Array.isArray(payload.rows) ? payload.rows.length : null;
    const message = typeof payload.error === "string" ? payload.error : null;
    return {
      rowsReturned: rows,
      errorName: response.ok || !message ? null : "QueryError",
      errorMessage: message,
    };
  } catch {
    return {
      rowsReturned: null,
      errorName: response.ok ? null : "InvalidJsonResponse",
      errorMessage: response.ok ? null : "Unable to parse error response.",
    };
  }
}

function boundedEvent(event: QueryTelemetryEvent): QueryTelemetryEvent {
  const markers = event.truncationMarkers;
  event.statements = event.statements.slice(0, MAX_STATEMENTS).map((statement, index) => ({
    ...statement,
    ordinal: index + 1,
    sql: truncateText(statement.sql, MAX_SQL_CHARS, `statement_${index + 1}_sql`, markers),
    parameters: safeJsonValue(
      statement.parameters,
      MAX_PARAMETERS_CHARS,
      `statement_${index + 1}_parameters`,
      markers
    ) as unknown[],
    errorMessage: statement.errorMessage
      ? truncateText(statement.errorMessage, MAX_ERROR_CHARS, `statement_${index + 1}_error`, markers)
      : null,
  }));
  if (event.errorMessage) {
    event.errorMessage = truncateText(event.errorMessage, MAX_ERROR_CHARS, "request_error", markers);
  }
  const originalBytes = encodedBytes(event);
  if (originalBytes > MAX_EVENT_BYTES) {
    markers.push(`event:original_bytes=${originalBytes}`);
    event.requestInput = { _truncated: `Event exceeded ${MAX_EVENT_BYTES} bytes.` };
    event.statements = event.statements.map((statement) => ({
      ...statement,
      sql: truncateText(statement.sql, 4096, `statement_${statement.ordinal}_sql_hard_cap`, markers),
      parameters: [],
      errorMessage: statement.errorMessage
        ? truncateText(statement.errorMessage, 1024, `statement_${statement.ordinal}_error_hard_cap`, markers)
        : null,
    }));
  }
  if (encodedBytes(event) > MAX_EVENT_BYTES) {
    markers.push("event:statements_reduced_to_20");
    event.statements = event.statements.slice(0, 20).map((statement) => ({
      ...statement,
      sql: "[TRUNCATED: event byte cap]",
      parameters: [],
      errorMessage: statement.errorMessage ? "[TRUNCATED: event byte cap]" : null,
    }));
  }
  return event;
}

async function deliverTelemetry(env: QueryTelemetryEnv, event: QueryTelemetryEvent): Promise<void> {
  const endpoint = String(env.TELEMETRY_ENDPOINT ?? "").trim();
  if (!endpoint) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const headers = new Headers({ "content-type": "application/json" });
    if (env.TELEMETRY_TOKEN) headers.set("x-rldb-telemetry-token", env.TELEMETRY_TOKEN);
    const body = JSON.stringify(boundedEvent(event));
    if (new TextEncoder().encode(body).byteLength > MAX_EVENT_BYTES) {
      throw new Error(`Telemetry event still exceeds the ${MAX_EVENT_BYTES}-byte hard cap.`);
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Telemetry sidecar returned HTTP ${response.status}.`);
  } catch (error) {
    const currentTime = Date.now();
    if (currentTime - lastDeliveryWarningAt >= 60_000) {
      lastDeliveryWarningAt = currentTime;
      console.warn("Query telemetry delivery failed; query response was unaffected.", error);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleWithQueryTelemetry(
  request: Request,
  env: QueryTelemetryEnv & { DB?: D1Database },
  context: ExecutionContext,
  handler: (request: Request, env: QueryTelemetryEnv & { DB?: D1Database }) => Promise<Response>
): Promise<Response> {
  const url = new URL(request.url);
  if (!TRACKED_ENDPOINTS.has(url.pathname) || !env.TELEMETRY_ENDPOINT || !env.DB) {
    return handler(request, env);
  }

  const collector: QueryTelemetryCollector = {
    statements: [],
    databaseExecutionMs: 0,
    rowsFetched: 0,
    databaseRowsRead: 0,
    activeStatements: 0,
    activeGroupStartedAt: null,
  };
  const requestId = crypto.randomUUID();
  const startedAt = nowMs();
  let response: Response;
  try {
    response = await handler(request, { ...env, DB: instrumentD1Database(env.DB, collector) });
  } catch (error) {
    const totalRequestMs = nowMs() - startedAt;
    context.waitUntil((async () => {
      const details = errorDetails(error);
      const markers: string[] = [];
      const shape = {
        request: structuralRequestShape(url),
        sql: collector.statements.map((statement) => normalizeSql(statement.sql)),
      };
      const event: QueryTelemetryEvent = {
        recordedAtUtc: new Date().toISOString(),
        requestId,
        endpoint: url.pathname,
        requestInput: sanitizedRequestInput(url, markers),
        queryShapeHash: await sha256Hex(JSON.stringify(shape)),
        queryCategory: queryCategory(url),
        databaseExecutionMs: collector.databaseExecutionMs,
        applicationPostProcessingMs: Math.max(0, totalRequestMs - collector.databaseExecutionMs),
        totalRequestMs,
        rowsFetched: collector.rowsFetched,
        databaseRowsRead: collector.databaseRowsRead,
        rowsReturned: null,
        responseStatus: 500,
        errorName: details.name,
        errorMessage: details.message,
        applicationVersion: env.APP_VERSION ?? "unknown",
        databaseSchemaVersion: env.SCHEMA_VERSION ?? "unknown",
        requestSource: requestSource(request, env),
        statements: collector.statements,
        truncationMarkers: markers,
      };
      await deliverTelemetry(env, event);
    })());
    throw error;
  }

  const totalRequestMs = nowMs() - startedAt;
  const markers: string[] = [];
  context.waitUntil((async () => {
    const details = await responseDetails(response);
    const shape = {
      request: structuralRequestShape(url),
      sql: collector.statements.map((statement) => normalizeSql(statement.sql)),
    };
    await deliverTelemetry(env, {
      recordedAtUtc: new Date().toISOString(),
      requestId,
      endpoint: url.pathname,
      requestInput: sanitizedRequestInput(url, markers),
      queryShapeHash: await sha256Hex(JSON.stringify(shape)),
      queryCategory: queryCategory(url),
      databaseExecutionMs: collector.databaseExecutionMs,
      applicationPostProcessingMs: Math.max(0, totalRequestMs - collector.databaseExecutionMs),
      totalRequestMs,
      rowsFetched: collector.rowsFetched,
      databaseRowsRead: collector.databaseRowsRead,
      rowsReturned: details.rowsReturned,
      responseStatus: response.status,
      errorName: details.errorName,
      errorMessage: details.errorMessage,
      applicationVersion: env.APP_VERSION ?? "unknown",
      databaseSchemaVersion: env.SCHEMA_VERSION ?? "unknown",
      requestSource: requestSource(request, env),
      statements: collector.statements,
      truncationMarkers: markers,
    });
  })());
  return response;
}
