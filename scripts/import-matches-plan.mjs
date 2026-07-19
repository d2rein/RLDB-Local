import { loadReconciledMatches } from "./lib/reconciled-matches.mjs";
import { isFinalsRound } from "./lib/normalize.mjs";

const matches = await loadReconciledMatches();

const summary = {
  total_matches: matches.length,
  finals_matches: matches.filter((match) => isFinalsRound(match.round)).length,
  nrl_backed_matches: matches.filter((match) => match.source_nrl === "1").length,
  afltables_only_matches: matches.filter((match) => match.source_afltables === "1" && match.source_nrl === "0").length,
};

console.log(JSON.stringify(summary, null, 2));
console.log("Sample:", matches.slice(0, 3));
