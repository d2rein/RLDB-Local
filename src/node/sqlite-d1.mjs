import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

function normalizeBinding(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

function normalizeRow(row) {
  return row === undefined ? undefined : { ...row };
}

function metadata(duration, rowsRead = 0, changes = 0, lastRowId = 0) {
  return {
    duration,
    size_after: 0,
    rows_read: rowsRead,
    rows_written: changes,
    changes,
    last_row_id: Number(lastRowId),
    changed_db: changes > 0,
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

  constructor(statement, parameters = []) {
    this.#statement = statement;
    this.#parameters = parameters;
  }

  bind(...values) {
    return new SqliteD1PreparedStatement(
      this.#statement,
      values.map(normalizeBinding)
    );
  }

  async all() {
    const started = performance.now();
    try {
      const results = this.#statement.all(...this.#parameters).map(normalizeRow);
      return {
        results,
        success: true,
        meta: metadata(performance.now() - started, results.length),
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
    try {
      const result = this.#statement.run(...this.#parameters);
      return {
        results: [],
        success: true,
        meta: metadata(
          performance.now() - started,
          0,
          Number(result.changes),
          result.lastInsertRowid
        ),
      };
    } catch (error) {
      throw d1Error(error);
    }
  }
}

export class SqliteD1Database {
  #database;

  constructor(databasePath, options = {}) {
    this.#database = new DatabaseSync(databasePath, {
      readOnly: Boolean(options.readOnly),
      enableForeignKeyConstraints: true,
      timeout: Number(options.timeoutMs ?? 5000),
    });
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA temp_store = MEMORY");
    this.#database.exec("PRAGMA cache_size = -65536");
    if (!options.readOnly) {
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec("PRAGMA synchronous = NORMAL");
    }
  }

  prepare(sql) {
    try {
      return new SqliteD1PreparedStatement(this.#database.prepare(sql));
    } catch (error) {
      throw d1Error(error);
    }
  }

  close() {
    this.#database.close();
  }
}
