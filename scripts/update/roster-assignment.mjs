function normalizedName(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function numericJumper(player) {
  const value = Number(player?.Number);
  return Number.isFinite(value) ? value : null;
}

function isReserve(player) {
  return /reserve/i.test(String(player?.Position ?? ""));
}

function playedMinutes(player) {
  const raw = player?.["Mins Played"];
  if (raw === null || raw === undefined || raw === "" || raw === "na" || raw === "-") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function isActiveRosterPlayer(player) {
  return !isReserve(player) || Number(playedMinutes(player) ?? 0) > 0;
}

function playerIdentity(player) {
  const sourceId = player?._sourcePlayerId;
  if (sourceId !== null && sourceId !== undefined && sourceId !== "") return `id:${sourceId}`;
  return `name:${normalizedName(player?.Name)}`;
}

function validateSide(players, label, context) {
  if (!Array.isArray(players)) throw new Error(`${context}: ${label} roster is not an array.`);
  if (players.length < 17 || players.length > 21) {
    throw new Error(`${context}: impossible ${label} roster count ${players.length}; expected 17-21.`);
  }

  const active = players.filter(isActiveRosterPlayer);
  if (active.length < 15 || active.length > 18) {
    throw new Error(`${context}: impossible ${label} active-player count ${active.length}; expected 15-18.`);
  }

  const identities = new Set();
  for (const player of players) {
    const identity = playerIdentity(player);
    if (identity === "name:") throw new Error(`${context}: ${label} roster contains a player without an identity.`);
    if (identities.has(identity)) throw new Error(`${context}: duplicate ${label} player ${player?.Name ?? identity}.`);
    identities.add(identity);
  }

  const jumpers = new Map();
  for (const player of active) {
    const jumper = numericJumper(player);
    if (jumper === null) continue;
    const prior = jumpers.get(jumper);
    if (prior) {
      throw new Error(`${context}: duplicate active ${label} jumper ${jumper} (${prior} and ${player.Name}).`);
    }
    jumpers.set(jumper, player.Name);
  }
  return { activeCount: active.length, identities };
}

export function validateRosterSides(home, away, context = "match") {
  const homeValidation = validateSide(home, "home", context);
  const awayValidation = validateSide(away, "away", context);
  if (Math.abs(home.length - away.length) > 2) {
    throw new Error(`${context}: roster counts differ impossibly (${home.length} home, ${away.length} away).`);
  }
  for (const identity of homeValidation.identities) {
    if (awayValidation.identities.has(identity)) {
      throw new Error(`${context}: player ${identity} is assigned to both teams.`);
    }
  }
  return {
    homeCount: home.length,
    awayCount: away.length,
    homeActiveCount: homeValidation.activeCount,
    awayActiveCount: awayValidation.activeCount,
  };
}

export function createSideAwareRosterPayload(match, home, away, context = "match") {
  const counts = validateRosterSides(home, away, context);
  const homeTeamId = match?.homeTeam?.teamId;
  const awayTeamId = match?.awayTeam?.teamId;
  if (homeTeamId === null || homeTeamId === undefined || awayTeamId === null || awayTeamId === undefined || homeTeamId === awayTeamId) {
    throw new Error(`${context}: invalid or identical source team IDs.`);
  }
  for (const [players, teamId, label] of [[home, homeTeamId, "home"], [away, awayTeamId, "away"]]) {
    for (const player of players) {
      if (player._sourceTeamId !== teamId) {
        throw new Error(`${context}: ${player.Name} has source team ${player._sourceTeamId}, expected ${label} team ${teamId}.`);
      }
    }
  }
  return { schemaVersion: 2, homeTeamId, awayTeamId, home, away, counts };
}

export function splitRosterByJumperRuns(players) {
  const runs = [];
  let current = [];
  let previous = null;
  for (const player of players) {
    const number = Number(player?.Number ?? 999);
    if (current.length && number < previous) {
      runs.push(current);
      current = [];
    }
    current.push(player);
    previous = number;
  }
  if (current.length) runs.push(current);
  if (runs.length <= 1) return [runs.flat(), []];
  if (runs.length === 2) return [runs[0], runs[1]];
  const split = runs.length === 4 ? 2 : Math.ceil(runs.length / 2);
  return [runs.slice(0, split).flat(), runs.slice(split).flat()];
}

function decodeLegacyRoster(players, context) {
  if (!Array.isArray(players)) throw new Error(`${context}: unsupported player payload shape.`);
  const candidateIndexes = [];
  for (let index = 17; index <= 21 && index < players.length; index += 1) {
    if (players.length - index < 17 || players.length - index > 21) continue;
    candidateIndexes.push(index);
  }
  const plausible = candidateIndexes.filter((index) => {
    try {
      validateSide(players.slice(0, index), "legacy home", context);
      validateSide(players.slice(index), "legacy away", context);
      return true;
    } catch {
      return false;
    }
  });
  const ranked = plausible.map((index) => {
    const nextJumper = numericJumper(players[index]);
    const previousJumper = numericJumper(players[index - 1]);
    const boundaryReset = nextJumper !== null && previousJumper !== null && nextJumper < previousJumper;
    return {
      index,
      score: Math.abs(index - (players.length - index)) * 20
        + (nextJumper === 1 ? 0 : 8)
        + (/fullback/i.test(String(players[index]?.Position ?? "")) ? 0 : 4)
        + (boundaryReset ? 0 : 12),
    };
  }).sort((left, right) => left.score - right.score);
  if (ranked.length && (ranked.length === 1 || ranked[0].score !== ranked[1].score)) {
    return [players.slice(0, ranked[0].index), players.slice(ranked[0].index)];
  }

  // Some old NRL project files contain only a flattened jumper-number stream.
  // Preserve that decoder as a last resort, but never accept it without the
  // same validation used for explicit side-aware payloads.
  const legacyRunSplit = splitRosterByJumperRuns(players);
  try {
    validateRosterSides(legacyRunSplit[0], legacyRunSplit[1], context);
    return legacyRunSplit;
  } catch (error) {
    throw new Error(`${context}: cannot safely recover legacy roster boundary (candidates: ${plausible.join(",") || "none"}; jumper-run fallback rejected: ${error.message}).`);
  }
}

export function decodeRosterPayload(payload, context = "match") {
  let home;
  let away;
  let sourceTeamIds = null;
  if (payload && !Array.isArray(payload) && Number(payload.schemaVersion) >= 2) {
    home = payload.home;
    away = payload.away;
    sourceTeamIds = { home: payload.homeTeamId, away: payload.awayTeamId };
    if (sourceTeamIds.home === null || sourceTeamIds.home === undefined
      || sourceTeamIds.away === null || sourceTeamIds.away === undefined
      || sourceTeamIds.home === sourceTeamIds.away) {
      throw new Error(`${context}: invalid or identical source team IDs.`);
    }
    for (const [players, teamId, label] of [[home, sourceTeamIds.home, "home"], [away, sourceTeamIds.away, "away"]]) {
      if (!Array.isArray(players)) throw new Error(`${context}: ${label} roster is not an array.`);
      for (const player of players) {
        if (player._sourceTeamId !== teamId) {
          throw new Error(`${context}: ${player.Name} has source team ${player._sourceTeamId}, expected ${label} team ${teamId}.`);
        }
      }
    }
  } else {
    [home, away] = decodeLegacyRoster(payload, context);
  }
  const counts = validateRosterSides(home, away, context);
  return { home, away, sourceTeamIds, counts };
}
