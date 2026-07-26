import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

const root = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args["base-url"] || "http://127.0.0.1:8797").replace(/\/$/, "");
const warmIterations = positiveInteger(args["warm-iterations"], 5);
const captureBaseline = Boolean(args["capture-baseline"]);
const explain = Boolean(args.explain);
const baselinePath = path.resolve(root, String(args.baseline || "benchmark/baselines/current-hybrid.json"));
const runDbPath = path.resolve(root, String(args["run-db"] || "runtime-data/benchmarks/benchmark-runs.sqlite"));
const telemetryDbPath = path.resolve(root, String(args["telemetry-db"] || "runtime-data/telemetry/query-performance.sqlite"));
const extraCasesPath = path.join(root, "benchmark", "extra-cases.json");
const migrationsPath = path.join(root, "benchmark", "migrations", "0001_benchmark_runs.sql");
const reportDirectory = path.resolve(root, String(args["report-dir"] || "reports/benchmarks"));
const restartScript = args["restart-script"] ? path.resolve(root, String(args["restart-script"])) : null;
const snapshotMetadata = args["snapshot-metadata"]
  ? JSON.parse(await fsp.readFile(path.resolve(root, String(args["snapshot-metadata"])), "utf8"))
  : null;

await fsp.mkdir(path.dirname(runDbPath), { recursive: true });
await fsp.mkdir(reportDirectory, { recursive: true });
if (captureBaseline) await fsp.mkdir(path.dirname(baselinePath), { recursive: true });

const version = JSON.parse(execFileSync("node", [path.join(root, "scripts", "runtime-version.mjs"), root], {
  cwd: root,
  encoding: "utf8",
}));
const bootstrap = await fetchJson(`${baseUrl}/api/meta/bootstrap`, {}, 30_000);
const suite = await fetchJson(`${baseUrl}/api/meta/regression-suite`, {}, 30_000);
const extras = JSON.parse(await fsp.readFile(extraCasesPath, "utf8"));
const liveCases = [...suite.cases, ...extras].map(cleanCase);
const existingBaseline = fs.existsSync(baselinePath)
  ? JSON.parse(await fsp.readFile(baselinePath, "utf8"))
  : null;
if (!captureBaseline && !existingBaseline) {
  throw new Error(`Baseline does not exist: ${baselinePath}. Run with --capture-baseline first.`);
}
const cases = captureBaseline ? liveCases : existingBaseline.cases.map((item) => item.case);
const baselineById = new Map((existingBaseline?.cases ?? []).map((item) => [item.case.id, item]));
const cutoff = bootstrap.app?.dataFreshness ?? [];
const snapshotId = snapshotMetadata?.sha256 ?? stableHash({ cutoff, schemaVersion: version.schemaVersion });

const runDb = new DatabaseSync(runDbPath);
runDb.exec(await fsp.readFile(migrationsPath, "utf8"));
const telemetryDb = fs.existsSync(telemetryDbPath) ? new DatabaseSync(telemetryDbPath, { readOnly: true }) : null;
const startedAt = new Date().toISOString();
const runStarted = performance.now();
const runInsert = runDb.prepare(`
  INSERT INTO benchmark_runs (
    started_at_utc, git_commit, application_version, schema_version, snapshot_id,
    data_cutoff_json, hosting_mode, database_engine, base_url, machine_json,
    node_version, configuration_json, baseline_path
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const runResult = runInsert.run(
  startedAt,
  version.fullCommit,
  version.applicationVersion,
  version.schemaVersion,
  snapshotId,
  JSON.stringify(cutoff),
  String(args["hosting-mode"] || "operational-hybrid-local-origin"),
  String(args["database-engine"] || "Cloudflare D1 local SQLite"),
  baseUrl,
  JSON.stringify(machineInfo()),
  process.version,
  JSON.stringify({ warmIterations, firstObservation: 1, explain, snapshotMetadata }),
  path.relative(root, baselinePath).replaceAll("\\", "/"),
);
const runId = Number(runResult.lastInsertRowid);
const iterationInsert = runDb.prepare(`
  INSERT INTO benchmark_iterations (
    run_id, case_id, case_label, category, endpoint, query_input_json,
    stable_query_hash, iteration_number, temperature, request_id, response_status,
    database_execution_ms, post_processing_ms, total_request_ms, rows_fetched,
    rows_returned, generated_sql_json, explain_query_plan_json, passed,
    mismatch_json, error_message, attempt_count, recovered_after_failure,
    normalized_result_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const baselineCases = [];
const summaries = [];
let passedCases = 0;
let failedCases = 0;

for (const [caseIndex, benchmarkCase] of cases.entries()) {
  const expected = baselineById.get(benchmarkCase.id)?.normalizedResult ?? null;
  const iterations = [];
  let capturedReference = null;
  process.stdout.write(`[${caseIndex + 1}/${cases.length}] ${benchmarkCase.label}\n`);
  for (let iteration = 0; iteration <= warmIterations; iteration += 1) {
    await ensureBackend(baseUrl);
    const temperature = iteration === 0 ? "first" : "warm";
    const endpointPath = benchmarkCase.endpoint === "full" ? "/api/query/full" : "/api/query";
    const query = new URLSearchParams(benchmarkCase.params);
    query.set("_benchmarkRun", String(runId));
    query.set("_benchmarkIteration", String(iteration));
    const url = `${baseUrl}${endpointPath}?${query}`;
    let measuredAt = performance.now();
    let responseStatus = 0;
    let requestId = null;
    let payload = null;
    let errorMessage = null;
    let attemptCount = 0;
    let recoveredAfterFailure = false;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      attemptCount = attempt;
      measuredAt = performance.now();
      try {
        const response = await fetch(url, {
          headers: { "x-rldb-query-source": "benchmark" },
          signal: AbortSignal.timeout(Number(args["request-timeout-ms"] || 130_000)),
        });
        responseStatus = response.status;
        requestId = response.headers.get("x-rldb-request-id");
        const text = await response.text();
        payload = JSON.parse(text);
        errorMessage = response.ok ? null : payload?.error || `HTTP ${response.status}`;
        break;
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        payload = { benchmarkError: errorMessage };
        if (attempt < 2) {
          if (restartScript) restartBackend(restartScript);
          recoveredAfterFailure = await waitForHealth(baseUrl, 60_000);
        }
      }
    }
    const networkTotalMs = performance.now() - measuredAt;
    const normalizedResult = normalizeResult(payload);
    if (captureBaseline && iteration === 0) capturedReference = normalizedResult;
    const reference = captureBaseline ? capturedReference : expected;
    const mismatch = reference ? compareResults(reference, normalizedResult) : null;
    const passed = !errorMessage && !mismatch;
    const telemetry = requestId && telemetryDb ? await waitForTelemetry(telemetryDb, requestId) : null;
    const plans = explain && telemetry ? explainPlans(telemetryDbPath, telemetry.statements) : null;
    const item = {
      iteration,
      temperature,
      requestId,
      responseStatus,
      networkTotalMs,
      telemetry,
      passed,
      mismatch,
      errorMessage,
      attemptCount,
      recoveredAfterFailure,
      normalizedResult,
    };
    iterations.push(item);
    iterationInsert.run(
      runId,
      benchmarkCase.id,
      benchmarkCase.label,
      benchmarkCase.category,
      endpointPath,
      JSON.stringify(benchmarkCase.params),
      stableHash({ endpointPath, params: benchmarkCase.params }),
      iteration,
      temperature,
      requestId,
      responseStatus,
      telemetry?.databaseExecutionMs ?? null,
      telemetry?.postProcessingMs ?? null,
      telemetry?.totalRequestMs ?? networkTotalMs,
      telemetry?.rowsFetched ?? null,
      telemetry?.rowsReturned ?? countRows(payload),
      telemetry ? JSON.stringify(telemetry.statements) : null,
      plans ? JSON.stringify(plans) : null,
      passed ? 1 : 0,
      mismatch ? JSON.stringify(mismatch) : null,
      errorMessage,
      attemptCount,
      recoveredAfterFailure ? 1 : 0,
      JSON.stringify(normalizedResult),
    );
    await new Promise((resolve) => setTimeout(resolve, Number(args["pause-ms"] || 250)));
  }
  const baselineResult = captureBaseline ? iterations[0].normalizedResult : expected;
  if (captureBaseline) baselineCases.push({ case: benchmarkCase, normalizedResult: baselineResult });
  const successful = iterations.every((item) => item.passed);
  if (successful) passedCases += 1;
  else failedCases += 1;
  summaries.push(summarizeCase(benchmarkCase, iterations));
}

const totalDurationMs = performance.now() - runStarted;
runDb.prepare(`
  UPDATE benchmark_runs
  SET completed_at_utc = ?, total_duration_ms = ?, passed_cases = ?, failed_cases = ?
  WHERE run_id = ?
`).run(new Date().toISOString(), totalDurationMs, passedCases, failedCases, runId);

if (captureBaseline) {
  const baseline = {
    formatVersion: 1,
    capturedAtUtc: startedAt,
    applicationVersion: version.applicationVersion,
    gitCommit: version.fullCommit,
    schemaVersion: version.schemaVersion,
    snapshotId,
    dataCutoff: cutoff,
    hostingMode: String(args["hosting-mode"] || "operational-hybrid-local-origin"),
    databaseEngine: String(args["database-engine"] || "Cloudflare D1 local SQLite"),
    cases: baselineCases,
  };
  await fsp.writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

const reportStem = `benchmark-${startedAt.replaceAll(":", "-").replaceAll(".", "-")}`;
const report = renderMarkdown({
  runId, startedAt, version, snapshotId, cutoff, totalDurationMs,
  passedCases, failedCases, summaries, warmIterations, baseUrl,
});
const markdownPath = path.join(reportDirectory, `${reportStem}.md`);
const csvPath = path.join(reportDirectory, `${reportStem}.csv`);
await fsp.writeFile(markdownPath, report);
await fsp.writeFile(csvPath, renderCsv(summaries));
console.log(JSON.stringify({
  runId, cases: cases.length, passedCases, failedCases,
  totalDurationMs: round(totalDurationMs), baselinePath, markdownPath, csvPath,
}, null, 2));
runDb.close();
telemetryDb?.close();
if (failedCases > 0) process.exitCode = 1;

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) continue;
    const [key, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) parsed[key] = inline;
    else if (values[index + 1] && !values[index + 1].startsWith("--")) parsed[key] = values[++index];
    else parsed[key] = true;
  }
  return parsed;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function cleanCase(item) {
  return {
    id: item.id,
    label: item.label,
    category: item.category,
    endpoint: item.endpoint,
    params: Object.fromEntries(Object.entries(item.params).map(([key, value]) => [key, String(value)])),
  };
}

async function fetchJson(url, options = {}, timeoutMs = 30_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function stableHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeResult(value, key = "") {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeResult(item));
    if (key === "rows") return normalizeRows(normalized);
    return normalized;
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const childKey of Object.keys(value).sort()) {
      if (["summary", "generatedAtUtc", "durationMs", "requestId"].includes(childKey)) continue;
      output[childKey] = normalizeResult(value[childKey], childKey);
    }
    return output;
  }
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  return value;
}

function normalizeRows(rows) {
  if (rows.length < 2 || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) return rows;
  const scoreKey = ["stat_total", "streak", "margin", "selected_stat", "value"]
    .find((candidate) => rows.some((row) => row[candidate] !== undefined));
  if (!scoreKey) return rows;
  const output = [];
  for (let index = 0; index < rows.length;) {
    const score = rows[index][scoreKey];
    let end = index + 1;
    while (end < rows.length && Object.is(rows[end][scoreKey], score)) end += 1;
    output.push(...rows.slice(index, end).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))));
    index = end;
  }
  return output;
}

function compareResults(expected, actual) {
  const expectedText = stableStringify(expected);
  const actualText = stableStringify(actual);
  if (expectedText === actualText) return null;
  return {
    expectedHash: stableHash(expected),
    actualHash: stableHash(actual),
    firstDifference: firstDifference(expected, actual),
  };
}

function firstDifference(expected, actual, location = "$") {
  if (Object.is(expected, actual)) return null;
  if (typeof expected !== typeof actual || expected === null || actual === null) {
    return { path: location, expected, actual };
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return { path: location, expected, actual };
    if (expected.length !== actual.length) return { path: `${location}.length`, expected: expected.length, actual: actual.length };
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], `${location}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (typeof expected === "object") {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const childKey of keys) {
      if (!(childKey in expected) || !(childKey in actual)) {
        return { path: `${location}.${childKey}`, expected: expected[childKey], actual: actual[childKey] };
      }
      const difference = firstDifference(expected[childKey], actual[childKey], `${location}.${childKey}`);
      if (difference) return difference;
    }
    return null;
  }
  return { path: location, expected, actual };
}

async function waitForTelemetry(database, requestId) {
  const query = database.prepare(`
    SELECT
      e.database_execution_ms, e.application_post_processing_ms, e.total_request_ms,
      e.rows_fetched, e.rows_returned, e.response_status,
      s.ordinal, s.method, s.sql_text, s.parameters_json, s.duration_ms
    FROM query_events e
    LEFT JOIN query_statements s ON s.event_id = e.event_id
    WHERE e.request_id = ?
    ORDER BY s.ordinal
  `);
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const rows = query.all(requestId);
    if (rows.length > 0) {
      const event = rows[0];
      return {
        databaseExecutionMs: event.database_execution_ms,
        postProcessingMs: event.application_post_processing_ms,
        totalRequestMs: event.total_request_ms,
        rowsFetched: event.rows_fetched,
        rowsReturned: event.rows_returned,
        responseStatus: event.response_status,
        statements: rows.filter((row) => row.ordinal !== null).map((row) => ({
          ordinal: row.ordinal,
          method: row.method,
          sql: row.sql_text,
          parameters: JSON.parse(row.parameters_json),
          durationMs: row.duration_ms,
        })),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForHealth(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return true;
    } catch {
      // The watchdog may be replacing a wedged Worker.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Backend did not become healthy within ${timeoutMs} ms.`);
}

async function ensureBackend(origin) {
  try {
    return await waitForHealth(origin, 5_000);
  } catch {
    if (!restartScript) throw new Error(`Backend is unhealthy and no --restart-script was supplied: ${origin}`);
    restartBackend(restartScript);
    return waitForHealth(origin, 60_000);
  }
}

function restartBackend(scriptPath) {
  execFileSync("powershell", [
    "-ExecutionPolicy", "Bypass", "-File", scriptPath,
  ], { cwd: root, stdio: "inherit" });
}

function explainPlans(_telemetryPath, statements) {
  // D1 SQL is retained for later EXPLAIN execution against the pinned snapshot.
  return statements.map((statement) => ({ ordinal: statement.ordinal, status: "not-run-against-live-database" }));
}

function countRows(payload) {
  return Array.isArray(payload?.rows) ? payload.rows.length : null;
}

function machineInfo() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
}

function summarizeCase(benchmarkCase, iterations) {
  const warm = iterations.filter((item) => item.temperature === "warm");
  const warmTimes = warm.map((item) => item.telemetry?.totalRequestMs ?? item.networkTotalMs);
  const dbTimes = warm.map((item) => item.telemetry?.databaseExecutionMs).filter(Number.isFinite);
  const postTimes = warm.map((item) => item.telemetry?.postProcessingMs).filter(Number.isFinite);
  return {
    id: benchmarkCase.id,
    label: benchmarkCase.label,
    category: benchmarkCase.category,
    passed: iterations.every((item) => item.passed),
    coldMs: round(iterations[0].telemetry?.totalRequestMs ?? iterations[0].networkTotalMs),
    medianMs: round(percentile(warmTimes, 0.5)),
    minimumMs: round(Math.min(...warmTimes)),
    maximumMs: round(Math.max(...warmTimes)),
    meanMs: round(mean(warmTimes)),
    medianDbMs: round(percentile(dbTimes, 0.5)),
    medianPostMs: round(percentile(postTimes, 0.5)),
    rowsFetched: iterations.at(-1)?.telemetry?.rowsFetched ?? null,
    rowsReturned: iterations.at(-1)?.telemetry?.rowsReturned ?? null,
    recoveries: iterations.filter((item) => item.recoveredAfterFailure).length,
    error: iterations.find((item) => !item.passed)?.errorMessage
      || JSON.stringify(iterations.find((item) => item.mismatch)?.mismatch?.firstDifference ?? ""),
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function renderMarkdown(context) {
  const lines = [
    "# RLDB Benchmark Run",
    "",
    `- Run ID: ${context.runId}`,
    `- Started: ${context.startedAt}`,
    `- Application: ${context.version.applicationVersion}`,
    `- Schema: ${context.version.schemaVersion}`,
    `- Snapshot: ${context.snapshotId}`,
    `- Data cutoff: ${context.cutoff.map((item) => `${item.competition} ${item.season} ${item.roundLabel}`).join("; ")}`,
    `- Endpoint: ${context.baseUrl}`,
    `- Iterations: 1 first observation + ${context.warmIterations} warm`,
    `- Cases: ${context.summaries.length} (${context.passedCases} passed, ${context.failedCases} failed)`,
    `- Total duration: ${round(context.totalDurationMs / 1000)} seconds`,
    "",
    "| Case | Category | Pass | First ms | Warm median | Min | Max | Mean | DB median | Post median | DB rows | Returned | Recoveries |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const item of context.summaries) {
    lines.push(`| ${escapeMarkdown(item.label)} | ${item.category} | ${item.passed ? "yes" : "NO"} | ${item.coldMs ?? ""} | ${item.medianMs ?? ""} | ${item.minimumMs ?? ""} | ${item.maximumMs ?? ""} | ${item.meanMs ?? ""} | ${item.medianDbMs ?? ""} | ${item.medianPostMs ?? ""} | ${item.rowsFetched ?? ""} | ${item.rowsReturned ?? ""} | ${item.recoveries} |`);
  }
  const failures = context.summaries.filter((item) => !item.passed);
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const item of failures) lines.push(`- **${item.label}:** ${item.error || "result mismatch"}`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|");
}

function renderCsv(items) {
  const columns = ["id", "label", "category", "passed", "coldMs", "medianMs", "minimumMs", "maximumMs", "meanMs", "medianDbMs", "medianPostMs", "rowsFetched", "rowsReturned", "recoveries", "error"];
  return `${columns.join(",")}\n${items.map((item) => columns.map((column) => csvCell(item[column])).join(",")).join("\n")}\n`;
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
