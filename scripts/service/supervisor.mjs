import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const configPath = path.resolve(process.argv[2] || "");
if (!configPath) throw new Error("A service configuration path is required.");

const configText = (await fsp.readFile(configPath, "utf8")).replace(/^\uFEFF/, "");
const config = JSON.parse(configText);
const logRoot = path.resolve(config.logRoot);
const runtimeRoot = path.resolve(config.runtimeRoot);
const controlRoot = path.resolve(config.controlRoot);
const desiredStatePath = path.join(controlRoot, "desired-state.txt");
const restartRequestPath = path.join(controlRoot, "restart.request");
const updateRequestPath = path.join(controlRoot, "update.request");
const weeklyUpdateMarkerPath = path.join(runtimeRoot, "last-weekly-update.txt");
const statusPath = path.join(runtimeRoot, "status.json");
const supervisorLogPath = path.join(logRoot, "supervisor.log");

await Promise.all([
  fsp.mkdir(logRoot, { recursive: true }),
  fsp.mkdir(runtimeRoot, { recursive: true }),
  fsp.mkdir(controlRoot, { recursive: true }),
]);

if (!fs.existsSync(desiredStatePath)) {
  await fsp.writeFile(desiredStatePath, "running\n", "utf8");
}

const children = new Map();
let shuttingDown = false;
let reconcileInFlight = false;
let statusWriteSequence = 0;
let restartToken = await readText(restartRequestPath);
let updateToken = await readText(updateRequestPath);

const services = [
  {
    name: "telemetry",
    script: path.join(config.releaseRoot, "scripts", "query-telemetry-server.mjs"),
    environment: {
      RLDB_TELEMETRY_HOST: "127.0.0.1",
      RLDB_TELEMETRY_PORT: String(config.telemetryPort),
      RLDB_TELEMETRY_DB_PATH: config.telemetryDatabasePath,
      RLDB_APPLICATION_VERSION: config.applicationVersion,
      RLDB_SCHEMA_VERSION: config.schemaVersion,
    },
  },
  {
    name: "backend",
    script: path.join(config.releaseRoot, "dist", "server.mjs"),
    environment: {
      RLDB_HOST: "127.0.0.1",
      RLDB_PORT: String(config.backendPort),
      RLDB_DATABASE_PATH: config.databasePath,
      RLDB_MAX_REQUEST_BODY_BYTES: String(config.maxRequestBodyBytes || 1048576),
      TELEMETRY_ENDPOINT: `http://127.0.0.1:${config.telemetryPort}/events`,
      RLDB_APPLICATION_VERSION: config.applicationVersion,
      RLDB_SCHEMA_VERSION: config.schemaVersion,
      RLDB_RUNTIME_MODE: "candidate-service",
      STATS_SITE_PASSWORD_HASH: config.sitePasswordHash || "",
      STATS_SITE_SESSION_SECRET: config.siteSessionSecret || "",
    },
  },
];

log("supervisor_started", { pid: process.pid, configPath });

const monitor = setInterval(() => void scheduleReconcile(), 2000);
monitor.unref();
await scheduleReconcile();

async function scheduleReconcile() {
  if (shuttingDown || reconcileInFlight) return;
  reconcileInFlight = true;
  try {
    await reconcile();
  } catch (error) {
    log("reconcile_failed", {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    reconcileInFlight = false;
  }
}

async function reconcile() {
  if (shuttingDown) return;
  const desiredState = (await readText(desiredStatePath)).trim().toLowerCase() || "running";
  const nextRestartToken = await readText(restartRequestPath);

  if (desiredState === "stopped") {
    await stopAll("desired_state_stopped");
  } else {
    if (nextRestartToken !== restartToken) {
      restartToken = nextRestartToken;
      await stopAll("restart_requested");
    }
    await maybeRunUpdate();
    for (const service of services) {
      if (!children.get(service.name)?.process) startService(service);
    }
  }
  await writeStatus(desiredState);
}

async function maybeRunUpdate() {
  if (!config.updateEnabled) return;
  const nextUpdateToken = await readText(updateRequestPath);
  const manualRequested = nextUpdateToken !== updateToken;
  const now = new Date();
  const localDay = now.getDay();
  const localHour = now.getHours();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((localDay + 6) % 7));
  const weekKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
  const lastWeekly = (await readText(weeklyUpdateMarkerPath)).trim();
  const scheduled = localDay === Number(config.updateDayOfWeek ?? 1)
    && localHour >= Number(config.updateHourLocal ?? 1)
    && lastWeekly !== weekKey;
  if (!manualRequested && !scheduled) return;

  updateToken = nextUpdateToken;
  log("weekly_update_started", { trigger: manualRequested ? "manual" : "schedule", weekKey });
  let servicesRestarted = false;
  try {
    await runUpdater("prepare");
    await stopAll("weekly_update_promotion");
    await runUpdater("promote");
    startMissingServices();
    servicesRestarted = true;
    if (!await waitForBackendHealth(45000)) {
      log("weekly_update_health_failed", { action: "rollback" });
      await stopAll("weekly_update_health_rollback");
      await runUpdater("rollback");
      startMissingServices();
      if (!await waitForBackendHealth(45000)) {
        throw new Error("Candidate remained unhealthy after automatic update rollback.");
      }
      throw new Error("Updated database failed its health check and was rolled back.");
    }
    if (scheduled) await fsp.writeFile(weeklyUpdateMarkerPath, `${weekKey}\n`, "utf8");
    log("weekly_update_completed", { trigger: manualRequested ? "manual" : "schedule", weekKey });
  } catch (error) {
    log("weekly_update_failed", { name: error?.name ?? "Error", message: error?.message ?? String(error) });
  } finally {
    if (!servicesRestarted) startMissingServices();
  }
}

function startMissingServices() {
  for (const service of services) {
    if (!children.get(service.name)?.process) startService(service);
  }
}

async function waitForBackendHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `http://127.0.0.1:${config.backendPort}/api/health`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function runUpdater(mode) {
  const script = path.join(config.releaseRoot, "scripts", "update", "weekly-update.mjs");
  const stdout = fs.openSync(path.join(logRoot, "update.out.log"), "a");
  const stderr = fs.openSync(path.join(logRoot, "update.err.log"), "a");
  const child = spawn(config.nodePath, [script, mode, configPath], {
    cwd: config.releaseRoot,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
  });
  fs.closeSync(stdout); fs.closeSync(stderr);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Updater ${mode} exited ${code ?? signal}`)));
  });
}

function startService(service) {
  const previous = children.get(service.name) || { restarts: 0 };
  const stdout = fs.openSync(path.join(logRoot, `${service.name}.out.log`), "a");
  const stderr = fs.openSync(path.join(logRoot, `${service.name}.err.log`), "a");
  const child = spawn(config.nodePath, [service.script], {
    cwd: config.releaseRoot,
    env: { ...process.env, ...service.environment },
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);

  const entry = {
    process: child,
    pid: child.pid,
    startedAtUtc: new Date().toISOString(),
    restarts: previous.restarts + (previous.pid ? 1 : 0),
    lastExit: previous.lastExit || null,
  };
  children.set(service.name, entry);
  log("service_started", { service: service.name, pid: child.pid, restarts: entry.restarts });

  child.once("error", (error) => {
    log("service_spawn_error", { service: service.name, name: error.name, message: error.message });
  });
  child.once("exit", (code, signal) => {
    const current = children.get(service.name);
    if (!current || current.process !== child) return;
    children.set(service.name, {
      ...current,
      process: null,
      pid: null,
      lastExit: { code, signal, atUtc: new Date().toISOString() },
    });
    log("service_exited", { service: service.name, code, signal });
  });
}

async function stopAll(reason) {
  const active = [...children.entries()].filter(([, entry]) => entry.process);
  if (active.length === 0) return;
  log("services_stopping", { reason, count: active.length });
  await Promise.all(active.map(([name, entry]) => stopChild(name, entry.process)));
}

async function stopChild(name, child) {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
  ]);
  if (!graceful && child.pid) {
    log("service_force_stop", { service: name, pid: child.pid });
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((resolve) => killer.once("exit", resolve));
  }
}

async function writeStatus(desiredState) {
  const status = {
    updatedAtUtc: new Date().toISOString(),
    supervisorPid: process.pid,
    desiredState,
    applicationVersion: config.applicationVersion,
    releaseRoot: config.releaseRoot,
    databasePath: config.databasePath,
    update: await readUpdateStatus(),
    services: Object.fromEntries(
      services.map((service) => {
        const entry = children.get(service.name) || {};
        return [service.name, {
          pid: entry.pid || null,
          running: Boolean(entry.process),
          startedAtUtc: entry.startedAtUtc || null,
          restarts: entry.restarts || 0,
          lastExit: entry.lastExit || null,
        }];
      })
    ),
  };
  statusWriteSequence += 1;
  const temporaryPath = `${statusPath}.${process.pid}.${statusWriteSequence}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, JSON.stringify(status, null, 2), "utf8");
    await fsp.rename(temporaryPath, statusPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readUpdateStatus() {
  try { return JSON.parse(await fsp.readFile(path.join(runtimeRoot, "update-status.json"), "utf8")); }
  catch { return null; }
}

async function readText(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function log(event, details = {}) {
  const line = JSON.stringify({ atUtc: new Date().toISOString(), event, ...details });
  fs.appendFileSync(supervisorLogPath, `${line}\n`, "utf8");
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(monitor);
  log("supervisor_stopping", { signal });
  await stopAll(`supervisor_${signal}`);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("uncaughtException", (error) => {
  log("supervisor_uncaught_exception", { name: error.name, message: error.message, stack: error.stack });
  process.exit(1);
});
process.once("unhandledRejection", (error) => {
  log("supervisor_unhandled_rejection", { message: String(error) });
  process.exit(1);
});
