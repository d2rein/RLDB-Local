import fs from "node:fs/promises";
import { parseCsv } from "./csv.mjs";
import { RECONCILED_MATCHES_CSV } from "./paths.mjs";

export async function loadReconciledMatches() {
  const text = await fs.readFile(RECONCILED_MATCHES_CSV, "utf8");
  return parseCsv(text);
}

export function buildMatchIndexes(matches) {
  const byMatchId = new Map();
  const byNrlUrl = new Map();
  const byMatchKey = new Map();

  for (const match of matches) {
    byMatchId.set(match.match_id, match);
    if (match.url_nrl) {
      byNrlUrl.set(match.url_nrl, match);
    }
    if (match.match_key) {
      byMatchKey.set(match.match_key, match);
    }
  }

  return { byMatchId, byNrlUrl, byMatchKey };
}
