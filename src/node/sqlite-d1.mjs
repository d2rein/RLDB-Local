import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_CACHE_MIB = 256;
const DEFAULT_MMAP_MIB = 0;

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function normalizeBinding(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

function normalizeRow(row) {
  return row === undefined ? undefined : { ...row };
}

function metadata(duration, rowsRead = 0, changes = 0, lastRowId = 0, diagnostics = null, queryPlan = null) {
  return {
    duration,
    size_after: 0,
    rows_read: rowsRead,
    rows_written: changes,
    changes,
    last_row_id: Number(lastRowId),
    changed_db: changes > 0,
    runtime_diagnostics: diagnostics,
    query_plan: queryPlan,
  };
}

function resourceSnapshot() {
  const usage = process.resourceUsage();
  const memory = process.memoryUsage();
  return {
    cpu: process.cpuUsage(),
    minorPageFault: Number(usage.minorPageFault ?? 0),
    majorPageFault: Number(usage.majorPageFault ?? 0),
    fsRead: Number(usage.fsRead ?? 0),
    fsWrite: Number(usage.fsWrite ?? 0),
    voluntaryContextSwitches: Number(usage.voluntaryContextSwitches ?? 0),
    involuntaryContextSwitches: Number(usage.involuntaryContextSwitches ?? 0),
    rssBytes: Number(memory.rss ?? 0),
    heapUsedBytes: Number(memory.heapUsed ?? 0),
    externalBytes: Number(memory.external ?? 0),
  };
}

function resourceDelta(started) {
  const completed = resourceSnapshot();
  const cpu = process.cpuUsage(started.cpu);
  return {
    userCpuMicros: Number(cpu.user ?? 0),
    systemCpuMicros: Number(cpu.system ?? 0),
    minorPageFaults: completed.minorPageFault - started.minorPageFault,
    majorPageFaults: completed.majorPageFault - started.majorPageFault,
    fsReads: completed.fsRead - started.fsRead,
    fsWrites: completed.fsWrite - started.fsWrite,
    voluntaryContextSwitches: completed.voluntaryContextSwitches - started.voluntaryContextSwitches,
    involuntaryContextSwitches: completed.involuntaryContextSwitches - started.involuntaryContextSwitches,
    rssBytesBefore: started.rssBytes,
    rssBytesAfter: completed.rssBytes,
    heapUsedBytesBefore: started.heapUsedBytes,
    heapUsedBytesAfter: completed.heapUsedBytes,
    externalBytesBefore: started.externalBytes,
    externalBytesAfter: completed.externalBytes,
  };
}

function d1Error(error) {
  if (!(error instanceof Error)) return error;
  const wrapped = new Error(`D1_ERROR: ${error.message}: SQLITE_ERROR`, { cause: error });
  wrapped.name = error.name;
  return wrapped;
}

export class SqliteD1PreparedStatement {
  #statement;
  #parameters;
  #database;
  #sql;
  #slowQueryPlanThresholdMs;

  constructor(statement, parameters = [], database = null, sql = "", slowQueryPlanThresholdMs = 5000) {
    this.#statement = statement;
    this.#parameters = parameters;
    this.#database = database;
    this.#sql = sql;
    this.#slowQueryPlanThresholdMs = slowQueryPlanThresholdMs;
  }

  bind(...values) {
    return new SqliteD1PreparedStatement(
      this.#statement,
      values.map(normalizeBinding),
      this.#database,
      this.#sql,
      this.#slowQueryPlanThresholdMs
    );
  }

  async all() {
    const started = performance.now();
    const resources = resourceSnapshot();
    try {
      const results = this.#statement.all(...this.#parameters).map(normalizeRow);
      const duration = performance.now() - started;
      return {
        results,
        success: true,
        meta: metadata(
          duration,
          results.length,
          0,
          0,
          resourceDelta(resources),
          duration >= this.#slowQueryPlanThresholdMs ? this.#captureQueryPlan() : null
        ),
      };
    } catch (error) {
      throw d1Error(error);
    }
  }

  async first(columnName) {
    try {
      const row = normalizeRow(this.#statement.get(...this.#parameters));
      if (row === undefined) return null;
      return columnName === undefined ? row : row[columnName] ?? null;
    } catch (error) {
      throw d1Error(error);
    }
  }

  async run() {
    const started = performance.now();
    const resources = resourceSnapshot();
    try {
      const result = this.#statement.run(...this.#parameters);
      const duration = performance.now() - started;
      return {
        results: [],
        success: true,
        meta: metadata(
          duration,
          0,
          Number(result.changes),
          result.lastInsertRowid,
          resourceDelta(resources)
        ),
      };
    } catch (error) {
      throw d1Error(error);
    }
  }

  #captureQueryPlan() {
    if (!this.#database || !/^\s*(?:SELECT|WITH)\b/i.test(this.#sql)) return null;
    try {
      return this.#database
        .prepare(`EXPLAIN QUERY PLAN ${this.#sql}`)
        .all(...this.#parameters)
        .slice(0, 250)
        .map(normalizeRow);
    } catch (error) {
      return [{ detail: `Plan capture failed: ${error instanceof Error ? error.message : String(error)}` }];
    }
  }
}

export class SqliteD1Database {
  #database;
  #slowQueryPlanThresholdMs;
  #runtimeConfiguration;

  constructor(databasePath, options = {}) {
    const cacheMiB = boundedInteger(options.cacheMiB, DEFAULT_CACHE_MIB, 16, 1024, "cacheMiB");
    const mmapMiB = boundedInteger(options.mmapMiB, DEFAULT_MMAP_MIB, 0, 2047, "mmapMiB");
    this.#database = new DatabaseSync(databasePath, {
      readOnly: Boolean(options.readOnly),
      enableForeignKeyConstraints: true,
      timeout: Number(options.timeoutMs ?? 5000),
    });
    this.#slowQueryPlanThresholdMs = Math.max(0, Number(options.slowQueryPlanThresholdMs ?? 5000));
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA temp_store = MEMORY");
    // Negative cache_size values are kibibytes. This is an upper bound and
    // SQLite allocates cache pages on demand, so an idle worker does not
    // reserve the full amount. The previous 64 MiB bound repeatedly evicted
    // pages needed by the broad player-query families.
    this.#database.exec(`PRAGMA cache_size = -${cacheMiB * 1024}`);
    // Keep memory mapping configurable but disabled by default. Cold random
    // analytical reads were substantially slower through Windows mapped-file
    // faults than through SQLite's buffered reads in production preflight.
    this.#database.exec(`PRAGMA mmap_size = ${mmapMiB * MEBIBYTE}`);
    if (!options.readOnly) {
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec("PRAGMA synchronous = NORMAL");
    }
    this.#runtimeConfiguration = Object.freeze({
      cacheMiB,
      cacheKiB: Math.abs(Number(this.#database.prepare("PRAGMA cache_size").get()?.cache_size ?? 0)),
      requestedMmapMiB: mmapMiB,
      effectiveMmapBytes: Number(this.#database.prepare("PRAGMA mmap_size").get()?.mmap_size ?? 0),
      tempStore: Number(this.#database.prepare("PRAGMA temp_store").get()?.temp_store ?? 0),
    });
  }

  prepare(sql) {
    try {
      return new SqliteD1PreparedStatement(
        this.#database.prepare(sql),
        [],
        this.#database,
        sql,
        this.#slowQueryPlanThresholdMs
      );
    } catch (error) {
      throw d1Error(error);
    }
  }

  close() {
    this.#database.close();
  }

  runtimeConfiguration() {
    return { ...this.#runtimeConfiguration };
  }
}
