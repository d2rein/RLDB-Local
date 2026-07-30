import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1Database } from "../src/node/sqlite-d1.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rldb-d1-"));
  const databasePath = path.join(directory, "test.sqlite");
  const seed = new DatabaseSync(databasePath);
  seed.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL)");
  seed.close();
  const database = new SqliteD1Database(databasePath);
  return {
    database,
    cleanup() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("bind, run, all and first preserve D1-compatible shapes", async () => {
  const { database, cleanup } = fixture();
  try {
    const inserted = await database
      .prepare("INSERT INTO sample (name, active) VALUES (?, ?)")
      .bind("Alpha", true)
      .run();
    assert.equal(inserted.success, true);
    assert.equal(inserted.meta.changes, 1);
    assert.equal(inserted.meta.last_row_id, 1);

    const all = await database
      .prepare("SELECT id, name, active FROM sample WHERE active = ?")
      .bind(false)
      .all();
    assert.deepEqual(all.results, []);
    assert.equal(all.success, true);

    const first = await database
      .prepare("SELECT id, name, active FROM sample WHERE id = ?")
      .bind(1)
      .first();
    assert.deepEqual(first, { id: 1, name: "Alpha", active: 1 });

    const scalar = await database
      .prepare("SELECT name FROM sample WHERE id = ?")
      .bind(1)
      .first("name");
    assert.equal(scalar, "Alpha");
  } finally {
    cleanup();
  }
});

test("missing rows return null and SQLite failures retain D1 context", async () => {
  const { database, cleanup } = fixture();
  try {
    assert.equal(
      await database.prepare("SELECT * FROM sample WHERE id = ?").bind(99).first(),
      null
    );
    assert.throws(
      () => database.prepare("SELECT missing_column FROM sample"),
      /D1_ERROR:.*missing_column.*SQLITE_ERROR/
    );
  } finally {
    cleanup();
  }
});
