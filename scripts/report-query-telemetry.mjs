import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[++index]
    : "1";
  args.set(key.replace(/^--/, ""), value);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.resolve(
  args.get("database")
    || process.env.RLDB_TELEMETRY_DB_PATH
    || path.join(projectRoot, "runtime-data", "telemetry", "query-performance.sqlite")
);
const format = String(args.get("format") || "markdown").toLowerCase();
const days = Math.max(0, Number(args.get("days") || 30));
const outputDir = path.resolve(args.get("output-dir") || path.join(projectRoot, "reports", "query-performance"));
const database = new DatabaseSync(databasePath, { readOnly: true });
const where = days > 0 ? "WHERE recorded_at_utc >= datetime('now', ?)" : "";
const binds = days > 0 ? [`-${days} days`] : [];
const events = database.prepare(`
  SELECT * FROM query_events
  ${where}
  ORDER BY recorded_at_utc DESC
`).all(...binds);

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function groupedSummary(keys) {
  const groups = new Map();
  for (const event of events) {
    const key = keys.map((name) => String(event[name] ?? "unknown")).join("\u0000");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const durations = rows.map((row) => Number(row.total_request_ms));
    return {
      keys: key.split("\u0000"),
      count: rows.length,
      median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      maximum: Math.max(...durations),
      mean: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    };
  });
}

const categories = groupedSummary(["query_category"]).sort((a, b) => b.median - a.median);
const routes = groupedSummary(["execution_route"]).sort((a, b) => b.median - a.median);
const shapes = groupedSummary(["query_shape_hash"]).sort((a, b) => b.count - a.count);
const versions = groupedSummary(["query_shape_hash", "application_version"])
  .sort((a, b) => a.keys[0].localeCompare(b.keys[0]) || b.median - a.median);
const slowest = events.slice().sort((a, b) => Number(b.total_request_ms) - Number(a.total_request_ms)).slice(0, 25);
const highRows = events.slice().sort((a, b) => Number(b.database_rows_read) - Number(a.database_rows_read)).slice(0, 25);
const highPost = events.slice()
  .sort((a, b) => Number(b.application_post_processing_ms) - Number(a.application_post_processing_ms))
  .slice(0, 25);

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

await fs.mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
if (format === "csv") {
  const columns = Object.keys(events[0] ?? { recorded_at_utc: "", request_id: "" });
  const output = [
    columns.join(","),
    ...events.map((event) => columns.map((column) => csvCell(event[column])).join(",")),
  ].join("\n");
  const outputPath = path.join(outputDir, `query-performance-${stamp}.csv`);
  await fs.writeFile(outputPath, `${output}\n`, "utf8");
  console.log(outputPath);
} else {
  const lines = [
    "# RLDB Query Performance", "",
    `Generated: ${new Date().toISOString()}`,
    `Database: ${databasePath}`,
    `Window: ${days > 0 ? `${days} days` : "all records"}`,
    `Queries: ${events.length}`, "",
    "## Query Categories", "",
    markdownTable(
      ["Category", "Count", "Median ms", "P95 ms", "Maximum ms", "Mean ms"],
      categories.map((row) => [
        row.keys[0], row.count, row.median.toFixed(2), row.p95.toFixed(2),
        row.maximum.toFixed(2), row.mean.toFixed(2),
      ])
    ), "",
    "## Execution Routes", "",
    markdownTable(
      ["Route", "Count", "Median ms", "P95 ms", "Maximum ms", "Mean ms"],
      routes.map((row) => [
        row.keys[0], row.count, row.median.toFixed(2), row.p95.toFixed(2),
        row.maximum.toFixed(2), row.mean.toFixed(2),
      ])
    ), "",
    "## Slowest Queries", "",
    markdownTable(
      ["Timestamp", "Request ID", "Category", "Route", "Total ms", "DB ms", "Post ms", "Rows read", "Status", "Version"],
      slowest.map((row) => [
        row.recorded_at_utc, row.request_id, row.query_category, row.execution_route,
        Number(row.total_request_ms).toFixed(2), Number(row.database_execution_ms).toFixed(2),
        Number(row.application_post_processing_ms).toFixed(2), row.database_rows_read,
        row.response_status, row.application_version,
      ])
    ), "",
    "## Most Frequent Shapes", "",
    markdownTable(
      ["Shape hash", "Count", "Median ms", "Maximum ms"],
      shapes.slice(0, 25).map((row) => [
        row.keys[0], row.count, row.median.toFixed(2), row.maximum.toFixed(2),
      ])
    ), "",
    "## Performance by Version and Shape", "",
    markdownTable(
      ["Shape hash", "Application version", "Count", "Median ms", "Maximum ms"],
      versions.slice(0, 100).map((row) => [
        row.keys[0], row.keys[1], row.count, row.median.toFixed(2), row.maximum.toFixed(2),
      ])
    ), "",
    "## Highest Database Row Counts", "",
    markdownTable(
      ["Request ID", "Category", "Rows read", "Rows fetched", "Total ms"],
      highRows.map((row) => [
        row.request_id, row.query_category, row.database_rows_read,
        row.rows_fetched, Number(row.total_request_ms).toFixed(2),
      ])
    ), "",
    "## Highest Post-processing Time", "",
    markdownTable(
      ["Request ID", "Category", "Post ms", "DB ms", "Total ms"],
      highPost.map((row) => [
        row.request_id, row.query_category, Number(row.application_post_processing_ms).toFixed(2),
        Number(row.database_execution_ms).toFixed(2), Number(row.total_request_ms).toFixed(2),
      ])
    ), "",
  ];
  const outputPath = path.join(outputDir, `query-performance-${stamp}.md`);
  await fs.writeFile(outputPath, lines.join("\n"), "utf8");
  console.log(outputPath);
}
database.close();
