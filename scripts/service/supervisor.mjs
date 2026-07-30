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
let restartToken = await readText(restartRequestPath);

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

const monitor = setInterval(() => void reconcile(), 2000);
monitor.unref();
await reconcile();

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
    for (const service of services) {
      if (!children.get(service.name)?.process) startService(service);
    }
  }
  await writeStatus(desiredState);
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
  const temporaryPath = `${statusPath}.tmp`;
  await fsp.writeFile(temporaryPath, JSON.stringify(status, null, 2), "utf8");
  await fsp.rename(temporaryPath, statusPath);
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
