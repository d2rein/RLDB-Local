import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import applicationWorker from "../application/worker";
import { SqliteD1Database } from "./sqlite-d1.mjs";

type WorkerConfiguration = {
  databasePath: string;
  environment: Record<string, string>;
};

type SerializedRequest = {
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  body?: Uint8Array;
};

const configuration = workerData as WorkerConfiguration;
const database = new SqliteD1Database(configuration.databasePath);
const environment = { ...configuration.environment, DB: database };
const pendingBackgroundTasks = new Set<Promise<unknown>>();
const maintenanceInterval = 10;
const slowRequestThresholdMs = 5000;
const backgroundTaskSettleLimitMs = 3250;
let completedRequestCount = 0;

const executionContext = {
  waitUntil(task: Promise<unknown>) {
    const settled = Promise.resolve(task).finally(() => pendingBackgroundTasks.delete(settled));
    pendingBackgroundTasks.add(settled);
  },
  passThroughOnException() {},
};

parentPort?.on("message", async (message: SerializedRequest) => {
  const started = performance.now();
  try {
    const request = new Request(message.url, {
      method: message.method,
      headers: message.headers,
      body: message.body,
    });
    const response = await applicationWorker.fetch(request, environment, executionContext);
    const body = new Uint8Array(await response.arrayBuffer());
    const headers = [...response.headers.entries()]
      .filter(([name]) => name.toLowerCase() !== "set-cookie");
    const getSetCookie = (response.headers as Headers & {
      getSetCookie?: () => string[];
    }).getSetCookie;
    if (getSetCookie) {
      for (const cookie of getSetCookie.call(response.headers)) {
        headers.push(["set-cookie", cookie]);
      }
    }
    parentPort?.postMessage({
      id: message.id,
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
    }, [body.buffer]);
  } catch (error) {
    const body = new TextEncoder().encode(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    parentPort?.postMessage({
      id: message.id,
      status: 500,
      statusText: "Internal Server Error",
      headers: [
        ["content-type", "application/json; charset=utf-8"],
        ["cache-control", "no-store"],
      ],
      body,
    }, [body.buffer]);
  }

  const durationMs = performance.now() - started;
  completedRequestCount += 1;
  const shouldMaintain = durationMs >= slowRequestThresholdMs
    || completedRequestCount % maintenanceInterval === 0;
  if (shouldMaintain) {
    try {
      await settleBackgroundTasksBounded();
      const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
      collectGarbage?.();
    } catch (error) {
      console.warn(JSON.stringify({
        event: "rldb_query_worker_maintenance_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  parentPort?.postMessage({ type: "ready_for_next" });
});

parentPort?.postMessage({ type: "ready" });

process.once("SIGTERM", async () => {
  await Promise.allSettled([...pendingBackgroundTasks]);
  database.close();
});

async function settleBackgroundTasksBounded(): Promise<void> {
  if (pendingBackgroundTasks.size === 0) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...pendingBackgroundTasks]),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, backgroundTaskSettleLimitMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
