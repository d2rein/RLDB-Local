import path from "node:path";
import { DOCS_DIR, LOCAL_SOURCE_ROOT } from "./project-paths.mjs";

export const SOURCE_ROOT = process.env.SOURCE_ROOT_OVERRIDE ?? LOCAL_SOURCE_ROOT;
export const AFLTABLES_DIR = process.env.AFLTABLES_DIR_OVERRIDE ?? SOURCE_ROOT;
const DEFAULT_NRL_DATA_ROOT = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data", "NRL");
export const NRL_DATA_ROOT = process.env.NRL_DATA_ROOT_OVERRIDE ?? DEFAULT_NRL_DATA_ROOT;
const DEFAULT_NRLW_DATA_ROOT = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data", "NRLW");
export const NRLW_DATA_ROOT = process.env.NRLW_DATA_ROOT_OVERRIDE ?? DEFAULT_NRLW_DATA_ROOT;
const DEFAULT_SOO_DATA_ROOT = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data", "SOO");
export const SOO_DATA_ROOT = process.env.SOO_DATA_ROOT_OVERRIDE ?? DEFAULT_SOO_DATA_ROOT;
const DEFAULT_WSOO_DATA_ROOT = path.join(DOCS_DIR, "NRL-Data-main_duplicate", "data", "WSOO");
export const WSOO_DATA_ROOT = process.env.WSOO_DATA_ROOT_OVERRIDE ?? DEFAULT_WSOO_DATA_ROOT;

export const STRUCTURED_COMPETITION_DATASETS = [
  { competitionCode: "NRLW", sourceKey: "NRLW", root: NRLW_DATA_ROOT },
  { competitionCode: "SOO", sourceKey: "SOO", root: SOO_DATA_ROOT },
  { competitionCode: "WSOO", sourceKey: "WSOO", root: WSOO_DATA_ROOT },
];

export const NRL_COM_DATASETS = [
  { competitionCode: "NRL", sourceKey: "NRL", root: NRL_DATA_ROOT },
  ...STRUCTURED_COMPETITION_DATASETS,
];

export const RECONCILED_MATCHES_CSV = path.join(AFLTABLES_DIR, "master_matches_reconciled.csv");
export const LEGACY_PLAYER_SCORING_CSV = path.join(AFLTABLES_DIR, "player_stats.csv");
export const SOO_AFLTABLES_MATCHES_CSV = path.join(DOCS_DIR, "afltables_soo_matches.csv");
export const SOO_AFLTABLES_PLAYER_STATS_CSV = path.join(DOCS_DIR, "afltables_soo_player_stats.csv");
export const LEGACY_PLAYER_SCORING_SUPPLEMENT_CSVS = [
  SOO_AFLTABLES_PLAYER_STATS_CSV,
];
export const LEGACY_MATCH_SUPPLEMENT_CSVS = [
  { competitionCode: "SOO", filePath: SOO_AFLTABLES_MATCHES_CSV },
];
