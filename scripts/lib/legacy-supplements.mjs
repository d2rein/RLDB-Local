import fs from "node:fs/promises";
import { parseCsv } from "./csv.mjs";
import { LEGACY_MATCH_SUPPLEMENT_CSVS, LEGACY_PLAYER_SCORING_CSV, LEGACY_PLAYER_SCORING_SUPPLEMENT_CSVS } from "./paths.mjs";

async function readCsvIfPresent(filePath) {
  try {
    return parseCsv(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function loadLegacyScoringRows() {
  const baseRows = parseCsv(await fs.readFile(LEGACY_PLAYER_SCORING_CSV, "utf8"));
  const supplementGroups = await Promise.all(
    LEGACY_PLAYER_SCORING_SUPPLEMENT_CSVS.map((filePath) => readCsvIfPresent(filePath))
  );
  return [...baseRows, ...supplementGroups.flat()];
}

export async function loadLegacyMatchSupplementRows() {
  const groups = await Promise.all(
    LEGACY_MATCH_SUPPLEMENT_CSVS.map(({ filePath }) => readCsvIfPresent(filePath))
  );
  return groups.flat();
}
