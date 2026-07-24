import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = process.cwd();
const outputPath = path.join(projectRoot, "runtime-data", "telemetry", "query-telemetry.test.mjs");

await build({
  entryPoints: [path.join(projectRoot, "tests", "query-telemetry.test.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: outputPath,
});

await import(`${pathToFileURL(outputPath).href}?run=${Date.now()}`);
