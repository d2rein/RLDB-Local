import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(root, "dist");

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: {
    server: path.join(root, "src", "node", "server.ts"),
    "request-worker": path.join(root, "src", "node", "request-worker.ts"),
  },
  outdir: outputDirectory,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  legalComments: "none",
});

console.log(`Built ${path.join(outputDirectory, "server.mjs")}`);
