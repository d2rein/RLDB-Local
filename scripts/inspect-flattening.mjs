import path from "node:path";
import { NRL_DATA_ROOT } from "./lib/paths.mjs";
import { flattenDetailedMatchFile, flattenPlayerStatsFile } from "./lib/nrl-json.mjs";

const detailedPath = path.join(NRL_DATA_ROOT, "2024", "NRL_detailed_match_data_2024.json");
const playerPath = path.join(NRL_DATA_ROOT, "2024", "NRL_player_statistics_2024.json");

const detailedRows = await flattenDetailedMatchFile(detailedPath);
const playerRows = await flattenPlayerStatsFile(playerPath);

console.log("Detailed match stat rows:", detailedRows.length);
console.log("Detailed sample:", detailedRows.slice(0, 5));
console.log("Player stat rows:", playerRows.length);
console.log("Player sample:", playerRows.slice(0, 5));
