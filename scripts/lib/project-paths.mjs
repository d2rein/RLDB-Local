import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsLibDir = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(scriptsLibDir, "..", "..");
export const DOCS_DIR = path.join(PROJECT_ROOT, "docs");
export const SEED_DIR = path.join(PROJECT_ROOT, "seed");
export const WRANGLER_STATE_DIR = path.join(
  PROJECT_ROOT,
  ".wrangler",
  "state",
  "v3",
  "d1",
  "miniflare-D1DatabaseObject"
);
export const LOCAL_SOURCE_ROOT = path.join(PROJECT_ROOT, "backups", "afltables");
