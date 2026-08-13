import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const migrationPath = resolve(
  import.meta.dirname,
  "../migrations/application/0009_player_match_query_components.sql",
);

test("player query components backfill and remain synchronized", () => {
  const databasePath = resolve(tmpdir(), `rldb-query-components-${process.pid}-${Date.now()}.sqlite`);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE player_match_summary (
        player_match_summary_id INTEGER PRIMARY KEY,
        stats_json TEXT NOT NULL
      );
      INSERT INTO player_match_summary VALUES (
        1,
        '{"tries":2,"goals":3,"minutes_played":80}'
      );
    `);
    database.exec(readFileSync(migrationPath, "utf8"));

    assert.deepEqual(
      { ...database.prepare(`
        SELECT tries, goals, minutes_played, minutes_played_present
        FROM player_match_query_components
        WHERE player_match_summary_id = 1
      `).get() },
      { tries: 2, goals: 3, minutes_played: 80, minutes_played_present: 1 },
    );

    database.prepare("UPDATE player_match_summary SET stats_json = ? WHERE player_match_summary_id = 1")
      .run('{"tries":4}');
    assert.deepEqual(
      { ...database.prepare(`
        SELECT tries, goals, minutes_played, minutes_played_present
        FROM player_match_query_components
        WHERE player_match_summary_id = 1
      `).get() },
      { tries: 4, goals: 0, minutes_played: 0, minutes_played_present: 0 },
    );

    database.prepare("DELETE FROM player_match_summary WHERE player_match_summary_id = 1").run();
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM player_match_query_components").get().count,
      0,
    );
  } finally {
    database.close();
    rmSync(databasePath, { force: true });
  }
});
