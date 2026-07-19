import fs from "node:fs/promises";
import path from "node:path";
import { parseNumberish, slugifyStatKey } from "./normalize.mjs";

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function flattenDetailedMatchFile(filePath) {
  const json = await readJson(filePath);
  const rows = [];
  const competitionKey = Object.keys(json).find((key) => Array.isArray(json[key]));

  for (const roundBlock of json[competitionKey] ?? []) {
    for (const [roundLabel, matches] of Object.entries(roundBlock)) {
      for (const wrapper of matches) {
        for (const [matchLabel, payload] of Object.entries(wrapper)) {
          for (const side of ["home", "away"]) {
            for (const [rawKey, rawValue] of Object.entries(payload[side] ?? {})) {
              rows.push({
                source_file: path.basename(filePath),
                round_label: roundLabel,
                match_label: matchLabel,
                side,
                stat_key_raw: rawKey,
                stat_key: slugifyStatKey(rawKey),
                stat_value_text: rawValue,
                stat_value_num: parseNumberish(rawValue),
              });
            }
          }

          for (const [rawKey, rawValue] of Object.entries(payload.match ?? {})) {
            rows.push({
              source_file: path.basename(filePath),
              round_label: roundLabel,
              match_label: matchLabel,
              side: "match",
              stat_key_raw: rawKey,
              stat_key: slugifyStatKey(rawKey),
              stat_value_text: Array.isArray(rawValue) ? JSON.stringify(rawValue) : rawValue,
              stat_value_num: parseNumberish(rawValue),
            });
          }
        }
      }
    }
  }

  return rows;
}

export async function flattenPlayerStatsFile(filePath) {
  const json = await readJson(filePath);
  const rows = [];

  for (const yearBlock of json.PlayerStats ?? []) {
    for (const [season, rounds] of Object.entries(yearBlock)) {
      for (const roundEntry of rounds) {
        for (const [roundLabel, matchEntries] of Object.entries(roundEntry)) {
          for (const matchEntry of matchEntries) {
            for (const [sourceMatchKey, playerRows] of Object.entries(matchEntry)) {
              for (const playerRow of playerRows) {
                const identity = {
                  source_file: path.basename(filePath),
                  season,
                  round_label: roundLabel,
                  source_match_key: sourceMatchKey,
                  player_name: playerRow.Name ?? "",
                  jumper_number: parseNumberish(playerRow.Number),
                  position_label: playerRow.Position ?? "",
                };

                for (const [rawKey, rawValue] of Object.entries(playerRow)) {
                  if (["Name", "Number", "Position"].includes(rawKey)) {
                    continue;
                  }

                  rows.push({
                    ...identity,
                    stat_key_raw: rawKey,
                    stat_key: slugifyStatKey(rawKey),
                    stat_value_text: rawValue,
                    stat_value_num: parseNumberish(rawValue),
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return rows;
}
