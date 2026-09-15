import assert from "node:assert/strict";
import test from "node:test";

import {
  createSideAwareRosterPayload,
  decodeRosterPayload,
  splitRosterByJumperRuns,
  validateRosterSides,
} from "../scripts/update/roster-assignment.mjs";

function roster(prefix, count = 19, teamId = 1) {
  return Array.from({ length: count }, (_, index) => ({
    Name: `${prefix} ${index + 1}`,
    Number: String(index + 1),
    Position: index === 0 ? "Fullback" : index < 13 ? "Starter" : index < 17 ? "Interchange" : "Reserve",
    "Mins Played": index < 17 ? "40" : "0",
    _sourcePlayerId: `${prefix}-${index + 1}`,
    _sourceTeamId: teamId,
  }));
}

test("legacy concatenated rosters split at the second fullback, not jumper-number decreases", () => {
  const home = roster("Home", 19, 10);
  const away = roster("Away", 19, 20);
  // Reproduce match 15491's internal away-side jumper decreases.
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 12, 14, 17, 21, 18, 19]
    .forEach((number, index) => { away[index].Number = String(number); });

  const decoded = decodeRosterPayload([...home, ...away], "test match");
  assert.equal(decoded.home.length, 19);
  assert.equal(decoded.away.length, 19);
  assert.equal(decoded.away[0].Name, "Away 1");
  assert.deepEqual(splitRosterByJumperRuns([...home, ...away]).map((side) => side.length), [32, 6]);
});

test("side-aware payload retains and verifies upstream team identity", () => {
  const match = { homeTeam: { teamId: 10 }, awayTeam: { teamId: 20 } };
  const payload = createSideAwareRosterPayload(match, roster("Home", 19, 10), roster("Away", 19, 20));
  const decoded = decodeRosterPayload(payload);
  assert.deepEqual(decoded.sourceTeamIds, { home: 10, away: 20 });
  assert.equal(decoded.counts.homeActiveCount, 17);
  assert.equal(decoded.counts.awayActiveCount, 17);

  payload.away[0]._sourceTeamId = 10;
  assert.throws(
    () => createSideAwareRosterPayload(match, payload.home, payload.away, "bad source"),
    /expected away team 20/,
  );
  assert.throws(() => decodeRosterPayload(payload, "tampered cache"), /expected away team 20/);
});

test("impossible side counts, duplicate jumpers, and dual-team players are rejected", () => {
  assert.throws(() => validateRosterSides(roster("Home", 19), roster("Away", 6)), /impossible away roster count/);

  const duplicate = roster("Away", 19, 20);
  duplicate[1].Number = duplicate[0].Number;
  assert.throws(() => validateRosterSides(roster("Home", 19, 10), duplicate), /duplicate active away jumper/);

  const away = roster("Away", 19, 20);
  away[0]._sourcePlayerId = "Home-1";
  assert.throws(() => validateRosterSides(roster("Home", 19, 10), away), /assigned to both teams/);
});
