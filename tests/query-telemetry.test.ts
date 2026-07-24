import assert from "node:assert/strict";
import {
  handleWithQueryTelemetry,
  instrumentD1Database,
  type QueryTelemetryCollector,
} from "../src/server/query-telemetry";

class FakeStatement {
  constructor(
    readonly sql: string,
    readonly parameters: unknown[] = [],
    readonly failure: Error | null = null
  ) {}

  bind(...parameters: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, parameters, this.failure);
  }

  async all(): Promise<object> {
    if (this.failure) throw this.failure;
    return { results: [{ value: 1 }, { value: 2 }], meta: { rows_read: 7 } };
  }

  async first(): Promise<object> {
    if (this.failure) throw this.failure;
    return { value: 1 };
  }

  async run(): Promise<object> {
    if (this.failure) throw this.failure;
    return { success: true, meta: { rows_read: 3 } };
  }
}

class FakeDatabase {
  constructor(readonly failure: Error | null = null) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, [], this.failure);
  }
}

function collector(): QueryTelemetryCollector {
  return {
    statements: [],
    databaseExecutionMs: 0,
    rowsFetched: 0,
    databaseRowsRead: 0,
    activeStatements: 0,
    activeGroupStartedAt: null,
  };
}

const directCollector = collector();
const directDatabase = instrumentD1Database(new FakeDatabase() as unknown as D1Database, directCollector);
const allResult = await directDatabase.prepare("SELECT ? AS value").bind("bound-value").all();
assert.deepEqual(allResult.results, [{ value: 1 }, { value: 2 }]);
assert.deepEqual(directCollector.statements[0].parameters, ["bound-value"]);
assert.equal(directCollector.statements[0].rowsFetched, 2);
assert.equal(directCollector.statements[0].databaseRowsRead, 7);
await directDatabase.prepare("SELECT 1").first();
await directDatabase.prepare("UPDATE example SET value = 1").run();
assert.deepEqual(directCollector.statements.map((row) => row.method), ["all", "first", "run"]);

const expectedError = new Error("same-error-object");
const failingDatabase = instrumentD1Database(
  new FakeDatabase(expectedError) as unknown as D1Database,
  collector()
);
await assert.rejects(
  failingDatabase.prepare("SELECT broken").first(),
  (error) => error === expectedError
);

const waitUntilPromises: Promise<unknown>[] = [];
const context = {
  waitUntil(promise: Promise<unknown>) {
    waitUntilPromises.push(promise);
  },
} as ExecutionContext;
const expectedResponse = Response.json({ rows: [{ value: 1 }] });
const response = await handleWithQueryTelemetry(
  new Request("http://test/api/query?scope=player&statKey=tries&token=do-not-log"),
  { DB: new FakeDatabase() as unknown as D1Database },
  context,
  async () => expectedResponse
);
assert.equal(response, expectedResponse, "The wrapper must return the original Response object.");
assert.equal(waitUntilPromises.length, 0, "Telemetry must be bypassed when no endpoint is configured.");

console.log("Query telemetry contract checks passed.");
