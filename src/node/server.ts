import http from "node:http";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const host = process.env.RLDB_HOST || "127.0.0.1";
const port = parseInteger(process.env.RLDB_PORT, 8899);
const databasePath = path.resolve(
  process.env.RLDB_DATABASE_PATH || path.join(root, "data", "rldb.sqlite")
);
const maxRequestBodyBytes = parseInteger(process.env.RLDB_MAX_REQUEST_BODY_BYTES, 1024 * 1024);
const maxQueryExecutionMs = parseInteger(process.env.RLDB_MAX_QUERY_EXECUTION_MS, 150_000);
const sqliteCacheMiB = parseBoundedInteger(process.env.RLDB_SQLITE_CACHE_MIB, 256, 16, 1024);
const sqliteMmapMiB = parseBoundedInteger(process.env.RLDB_SQLITE_MMAP_MIB, 1024, 0, 2047);

if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error(`RLDB_HOST must remain loopback-only; received ${host}`);
}
if (port === 8797 || port === 8798) {
  throw new Error(`Port ${port} is reserved for the operational RLDB service.`);
}

const environment = {
  REMOTE_QUERY_ORIGIN: "",
  LOCAL_API_TOKEN: process.env.LOCAL_API_TOKEN || "",
  STATS_SITE_PASSWORD_HASH: process.env.STATS_SITE_PASSWORD_HASH || "",
  STATS_SITE_SESSION_SECRET: process.env.STATS_SITE_SESSION_SECRET || "",
  TELEMETRY_ENDPOINT: process.env.TELEMETRY_ENDPOINT || "",
  TELEMETRY_TOKEN: process.env.TELEMETRY_TOKEN || "",
  APP_VERSION: process.env.RLDB_APPLICATION_VERSION || "development-dirty",
  SCHEMA_VERSION: process.env.RLDB_SCHEMA_VERSION || "unknown",
  RUNTIME_MODE: process.env.RLDB_RUNTIME_MODE || "development",
};

type SerializedRequest = {
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  body?: Uint8Array;
};

type SerializedResponse = {
  id: number;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
};

type QueuedRequest = {
  request: SerializedRequest;
  outgoing: http.ServerResponse;
  enqueuedAtMs: number;
  startedAtMs?: number;
  deadline?: ReturnType<typeof setTimeout>;
};

let queryWorker: Worker | null = null;
let workerReady = false;
let workerSqliteConfiguration: Record<string, number> | null = null;
let nextRequestId = 1;
let activeRequest: QueuedRequest | null = null;
const requestQueue: QueuedRequest[] = [];
let shuttingDown = false;

startQueryWorker();

const server = http.createServer(async (incoming, outgoing) => {
  const requestUrl = new URL(incoming.url || "/", `http://${incoming.headers.host || `${host}:${port}`}`);
  if (requestUrl.pathname === "/api/health") {
    writeHealthResponse(outgoing);
    return;
  }

  try {
    const request = await serializeRequest(incoming, requestUrl);
    const queued: QueuedRequest = { request, outgoing, enqueuedAtMs: Date.now() };
    requestQueue.push(queued);

    const cancel = () => {
      if (outgoing.writableEnded) return;
      if (activeRequest === queued) {
        restartQueryWorker("client_disconnected");
      } else {
        const index = requestQueue.indexOf(queued);
        if (index >= 0) requestQueue.splice(index, 1);
      }
    };
    incoming.once("aborted", cancel);
    incoming.socket.once("close", cancel);
    outgoing.once("close", cancel);
    dispatchNext();
  } catch (error) {
    writeError(outgoing, error);
  }
});

server.keepAliveTimeout = 5000;
server.headersTimeout = 10000;
server.requestTimeout = 135000;

server.listen(port, host, () => {
  console.log(JSON.stringify({
    event: "rldb_direct_node_started",
    host,
    port,
    databasePath,
    pid: process.pid,
    applicationVersion: environment.APP_VERSION,
  }));
});

async function serializeRequest(
  incoming: http.IncomingMessage,
  requestUrl: URL
): Promise<SerializedRequest> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const method = incoming.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(incoming) : undefined;
  return {
    id: nextRequestId++,
    url: requestUrl.toString(),
    method,
    headers: [...headers.entries()],
    body,
  };
}

async function readBody(incoming: http.IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > maxRequestBodyBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function startQueryWorker() {
  workerReady = false;
  workerSqliteConfiguration = null;
  const worker = new Worker(new URL("./request-worker.mjs", import.meta.url), {
    workerData: {
      databasePath,
      environment,
      sqliteOptions: { cacheMiB: sqliteCacheMiB, mmapMiB: sqliteMmapMiB },
    },
  });
  queryWorker = worker;

  worker.on("message", (message: { type: string; sqlite?: Record<string, number> } | SerializedResponse) => {
    if ("type" in message && (message.type === "ready" || message.type === "ready_for_next")) {
      if (message.type === "ready" && message.sqlite) workerSqliteConfiguration = message.sqlite;
      workerReady = true;
      dispatchNext();
      return;
    }
    if ("type" in message) return;
    if (!activeRequest || message.id !== activeRequest.request.id) return;

    const completedRequest = activeRequest;
    const { outgoing } = completedRequest;
    clearActiveDeadline(completedRequest);
    activeRequest = null;
    if (!outgoing.destroyed) {
      outgoing.statusCode = message.status;
      outgoing.statusMessage = message.statusText;
      for (const [name, value] of message.headers) {
        if (name.toLowerCase() === "set-cookie") {
          const existing = outgoing.getHeader("set-cookie");
          const cookies = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
          outgoing.setHeader("set-cookie", [...cookies, value]);
        } else {
          outgoing.setHeader(name, value);
        }
      }
      const completedAtMs = Date.now();
      const workerElapsedMs = completedRequest.startedAtMs
        ? completedAtMs - completedRequest.startedAtMs
        : 0;
      const queueWaitMs = completedRequest.startedAtMs
        ? completedRequest.startedAtMs - completedRequest.enqueuedAtMs
        : 0;
      outgoing.setHeader("x-rldb-queue-wait-ms", String(Math.max(0, queueWaitMs)));
      outgoing.setHeader("x-rldb-worker-elapsed-ms", String(Math.max(0, workerElapsedMs)));
      outgoing.end(Buffer.from(message.body));
    }
  });

  worker.on("error", (error) => {
    console.error(JSON.stringify({ event: "rldb_query_worker_error", error: error.message }));
  });
  worker.on("exit", (code) => {
    if (queryWorker !== worker) return;
    queryWorker = null;
    workerReady = false;
    failActiveRequest(new Error(`Query worker exited with code ${code}.`));
    if (!shuttingDown) startQueryWorker();
  });
}

function dispatchNext() {
  if (!workerReady || !queryWorker || activeRequest || requestQueue.length === 0) return;
  activeRequest = requestQueue.shift() || null;
  if (!activeRequest) return;
  workerReady = false;
  const dispatchedRequest = activeRequest;
  activeRequest.startedAtMs = Date.now();
  activeRequest.deadline = setTimeout(() => {
    if (activeRequest !== dispatchedRequest) return;
    restartQueryWorker("server_query_timeout", 504);
  }, maxQueryExecutionMs);
  activeRequest.deadline.unref();
  queryWorker.postMessage(activeRequest.request);
}

function restartQueryWorker(reason: string, statusCode = 500) {
  const worker = queryWorker;
  queryWorker = null;
  workerReady = false;
  workerSqliteConfiguration = null;
  const error = reason === "server_query_timeout"
    ? new Error(`Query exceeded the ${Math.round(maxQueryExecutionMs / 1000)} second safety limit and was cancelled. The search service has recovered; narrower filters may complete faster.`)
    : new Error(`Query cancelled: ${reason}.`);
  failActiveRequest(error, statusCode);
  console.warn(JSON.stringify({ event: "rldb_query_worker_restart", reason }));
  if (worker) void worker.terminate();
  if (!shuttingDown) startQueryWorker();
}

function failActiveRequest(error: Error, statusCode = 500) {
  if (!activeRequest) return;
  const { outgoing } = activeRequest;
  clearActiveDeadline(activeRequest);
  activeRequest = null;
  if (!outgoing.destroyed) writeError(outgoing, error, statusCode);
}

function clearActiveDeadline(request: QueuedRequest) {
  if (request.deadline) clearTimeout(request.deadline);
  request.deadline = undefined;
}

function writeHealthResponse(outgoing: http.ServerResponse) {
  // A worker processing a query is healthy even though it is not ready to
  // accept the next queued request. Only report unavailable while no worker
  // exists, or while a replacement worker has not completed startup.
  const busy = Boolean(activeRequest);
  const healthy = Boolean(queryWorker && (workerReady || busy));
  outgoing.writeHead(healthy ? 200 : 503, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  outgoing.end(JSON.stringify({
    ok: healthy,
    service: "rugby-league-stats-database",
    database: {
      configured: true,
      reachable: healthy,
      sqlite: workerSqliteConfiguration || {
        cacheMiB: sqliteCacheMiB,
        requestedMmapMiB: sqliteMmapMiB,
      },
    },
    query_worker: {
      ready: workerReady,
      busy,
      queued_requests: requestQueue.length,
      active_request_ms: activeRequest?.startedAtMs ? Date.now() - activeRequest.startedAtMs : 0,
      execution_limit_ms: maxQueryExecutionMs,
    },
    checked_at_utc: new Date().toISOString(),
  }, null, 2));
}

function writeError(outgoing: http.ServerResponse, error: unknown, statusCode = 500) {
  const message = error instanceof Error ? error.message : String(error);
  if (!outgoing.headersSent) {
    outgoing.writeHead(message === "Request body is too large." ? 413 : statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
  }
  outgoing.end(JSON.stringify({ ok: false, error: message }));
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`SQLite setting must be an integer between ${minimum} and ${maximum}; received ${value}.`);
  }
  return parsed;
}

async function shutdown(signal: string) {
  shuttingDown = true;
  console.log(JSON.stringify({ event: "rldb_direct_node_stopping", signal }));
  server.close(async () => {
    if (queryWorker) await queryWorker.terminate();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
