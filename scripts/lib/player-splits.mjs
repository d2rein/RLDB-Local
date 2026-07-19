import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "./csv.mjs";
import { DOCS_DIR } from "./project-paths.mjs";

export const LONG_CAREER_SPLITS_CSV = path.join(DOCS_DIR, "player_long_career_afltables_splits.csv");

const MANUAL_SPLIT_OVERRIDES = [
  {
    baseDisplayName: "Peter Johnston",
    splitDisplayName: "Peter Johnston [1984-1991]",
    firstSeason: 1984,
    lastSeason: 1991,
    afltablesPlayerUrl: "players/P/Peter_JohnstonCB.html",
    allowedTeams: ["Canterbury", "Easts", "Newcastle"],
  },
  {
    baseDisplayName: "Peter Johnston",
    splitDisplayName: "Peter Johnston [1989-1997]",
    firstSeason: 1989,
    lastSeason: 1997,
    afltablesPlayerUrl: "players/P/Peter_JohnstonPR.html",
    allowedTeams: ["Parramatta", "Souths", "Illawarra"],
  },
  {
    baseDisplayName: "Steven Price",
    splitDisplayName: "Steven Price [1994-2009]",
    firstSeason: 1994,
    lastSeason: 2009,
    afltablesPlayerUrl: "players/S/Steven_PriceCB.html",
    allowedTeams: ["Canterbury", "Sydney Bulldogs", "Bulldogs", "New Zealand"],
  },
  {
    baseDisplayName: "Steven Price",
    splitDisplayName: "Steven Price [1997-1999]",
    firstSeason: 1997,
    lastSeason: 1999,
    afltablesPlayerUrl: "players/S/Steven_PriceSG.html",
    allowedTeams: ["St George", "St George Illawarra", "Balmain"],
  },
  {
    baseDisplayName: "Jeremy Smith",
    splitDisplayName: "Jeremy Smith [1996-1997]",
    firstSeason: 1996,
    lastSeason: 1997,
    afltablesPlayerUrl: "",
    allowedTeams: ["South Queensland"],
  },
  {
    baseDisplayName: "Jeremy Smith",
    splitDisplayName: "Jeremy Smith [2004-2016]",
    firstSeason: 2004,
    lastSeason: 2016,
    afltablesPlayerUrl: "players/J/Jeremy_SmithMS.html",
    allowedTeams: ["Melbourne", "Cronulla", "Newcastle"],
  },
  {
    baseDisplayName: "Jeremy Smith",
    splitDisplayName: "Jeremy Smith [2006-2008]",
    firstSeason: 2006,
    lastSeason: 2008,
    afltablesPlayerUrl: "players/J/Jeremy_SmithPR.html",
    allowedTeams: ["Parramatta", "Souths"],
  },
];

function normalizeTeamName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function seasonRangeOverlaps(leftFirst, leftLast, rightFirst, rightLast) {
  if (!Number.isFinite(leftFirst) || !Number.isFinite(leftLast) || !Number.isFinite(rightFirst) || !Number.isFinite(rightLast)) {
    return false;
  }
  return leftFirst <= rightLast && rightFirst <= leftLast;
}

export function resolveSeasonalAlias(aliasMap, sourceName, season, context = {}) {
  const entries = aliasMap.get(sourceName) ?? [];
  if (entries.length === 0) return null;
  if (!Number.isFinite(Number(season))) {
    return entries[0] ?? null;
  }

  const seasonNumber = Number(season);
  const matches = entries.filter((entry) => {
    const first = Number(entry.firstSeason);
    const last = Number(entry.lastSeason);
    if (Number.isFinite(first) && seasonNumber < first) return false;
    if (Number.isFinite(last) && seasonNumber > last) return false;
    return true;
  });

  if (matches.length === 0) {
    return entries[0] ?? null;
  }

  const normalizedTeam = normalizeTeamName(context.teamName);
  const teamMatches = normalizedTeam
    ? matches.filter((entry) => {
        if (!Array.isArray(entry.allowedTeams) || entry.allowedTeams.length === 0) return true;
        return entry.allowedTeams.includes(normalizedTeam);
      })
    : matches;

  const candidates = teamMatches.length > 0 ? teamMatches : matches;

  candidates.sort((left, right) => {
    const leftHasTeams = Array.isArray(left.allowedTeams) && left.allowedTeams.length > 0 ? 1 : 0;
    const rightHasTeams = Array.isArray(right.allowedTeams) && right.allowedTeams.length > 0 ? 1 : 0;
    if (leftHasTeams !== rightHasTeams) return rightHasTeams - leftHasTeams;
    const leftSpan = (Number(left.lastSeason) || Number(left.firstSeason) || 0) - (Number(left.firstSeason) || Number(left.lastSeason) || 0);
    const rightSpan = (Number(right.lastSeason) || Number(right.firstSeason) || 0) - (Number(right.firstSeason) || Number(right.lastSeason) || 0);
    if (leftSpan !== rightSpan) return leftSpan - rightSpan;
    return Number(right.confidence ?? 0) - Number(left.confidence ?? 0);
  });

  return candidates[0] ?? null;
}

export function buildSeasonalAliasLookup(aliases, allowedSources) {
  const allowed = new Set(allowedSources);
  const lookup = new Map();

  for (const alias of aliases) {
    if (!allowed.has(alias.source)) continue;
    if (!lookup.has(alias.sourceName)) {
      lookup.set(alias.sourceName, []);
    }
    lookup.get(alias.sourceName).push(alias);
  }

  for (const entries of lookup.values()) {
    entries.sort((left, right) => {
      const leftFirst = Number(left.firstSeason) || 0;
      const rightFirst = Number(right.firstSeason) || 0;
      if (leftFirst !== rightFirst) return leftFirst - rightFirst;
      const leftLast = Number(left.lastSeason) || leftFirst;
      const rightLast = Number(right.lastSeason) || rightFirst;
      if (leftLast !== rightLast) return leftLast - rightLast;
      return Number(right.confidence ?? 0) - Number(left.confidence ?? 0);
    });
  }

  return lookup;
}

export async function loadLegacyPlayerSplitDefinitions() {
  try {
    const rows = parseCsv(await fs.readFile(LONG_CAREER_SPLITS_CSV, "utf8"));
    const grouped = new Map();
    for (const row of rows) {
      if (String(row.apply_split ?? "0") !== "1") continue;
      const baseName = String(row.base_display_name ?? "").trim();
      if (!baseName) continue;
      if (!grouped.has(baseName)) grouped.set(baseName, []);
      grouped.get(baseName).push({
        baseDisplayName: baseName,
        splitDisplayName: String(row.split_display_name ?? "").trim(),
        firstSeason: Number(row.first_season),
        lastSeason: Number(row.last_season),
        afltablesPlayerUrl: String(row.afltables_player_url ?? "").trim(),
        afltablesTries: Number(row.afltables_tries ?? 0),
        afltablesPoints: Number(row.afltables_points ?? 0),
        allowedTeams: [],
      });
    }
    for (const override of MANUAL_SPLIT_OVERRIDES) {
      const baseName = String(override.baseDisplayName ?? "").trim();
      if (!baseName) continue;
      if (!grouped.has(baseName)) grouped.set(baseName, []);
      const splits = grouped.get(baseName);
      const existing = splits.find((split) => split.splitDisplayName === override.splitDisplayName);
      if (existing) {
        existing.firstSeason = override.firstSeason;
        existing.lastSeason = override.lastSeason;
        existing.afltablesPlayerUrl = override.afltablesPlayerUrl || existing.afltablesPlayerUrl || "";
        existing.allowedTeams = (override.allowedTeams ?? []).map(normalizeTeamName).filter(Boolean);
      } else {
        splits.push({
          baseDisplayName: baseName,
          splitDisplayName: override.splitDisplayName,
          firstSeason: override.firstSeason,
          lastSeason: override.lastSeason,
          afltablesPlayerUrl: override.afltablesPlayerUrl ?? "",
          afltablesTries: Number(override.afltablesTries ?? 0),
          afltablesPoints: Number(override.afltablesPoints ?? 0),
          allowedTeams: (override.allowedTeams ?? []).map(normalizeTeamName).filter(Boolean),
        });
      }
    }
    for (const splits of grouped.values()) {
      splits.sort((left, right) => left.firstSeason - right.firstSeason || left.lastSeason - right.lastSeason);
    }
    return grouped;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}
