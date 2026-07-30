import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import applicationWorker from "../application/worker";
import { SqliteD1Database } from "./sqlite-d1.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const host = process.env.RLDB_HOST || "127.0.0.1";
const port = parseInteger(process.env.RLDB_PORT, 8899);
const databasePath = path.resolve(
  process.env.RLDB_DATABASE_PATH || path.join(root, "data", "rldb.sqlite")
);
const maxRequestBodyBytes = parseInteger(process.env.RLDB_MAX_REQUEST_BODY_BYTES, 1024 * 1024);

if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error(`RLDB_HOST must remain loopback-only; received ${host}`);
}
if (port === 8797 || port === 8798) {
  throw new Error(`Port ${port} is reserved for the operational RLDB service.`);
}

const database = new SqliteD1Database(databasePath);
const pendingBackgroundTasks = new Set<Promise<unknown>>();
const environment = {
  DB: database,
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

const executionContext = {
  waitUntil(task: Promise<unknown>) {
    const settled = Promise.resolve(task).finally(() => pendingBackgroundTasks.delete(settled));
    pendingBackgroundTasks.add(settled);
  },
  passThroughOnException() {},
};

const server = http.createServer(async (incoming, outgoing) => {
  try {
    const request = await toFetchRequest(incoming);
    const response = await applicationWorker.fetch(request, environment, executionContext);
    await writeFetchResponse(outgoing, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!outgoing.headersSent) {
      outgoing.writeHead(message === "Request body is too large." ? 413 : 500, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
    }
    outgoing.end(JSON.stringify({ ok: false, error: message }));
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

async function toFetchRequest(incoming: http.IncomingMessage): Promise<Request> {
  const authority = incoming.headers.host || `${host}:${port}`;
  const requestUrl = new URL(incoming.url || "/", `http://${authority}`);
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
  return new Request(requestUrl, { method, headers, body });
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

async function writeFetchResponse(
  outgoing: http.ServerResponse,
  response: Response
): Promise<void> {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) {
    const cookies = getSetCookie.call(response.headers);
    if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
  }
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function shutdown(signal: string) {
  console.log(JSON.stringify({ event: "rldb_direct_node_stopping", signal }));
  server.close(async () => {
    await Promise.allSettled([...pendingBackgroundTasks]);
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
