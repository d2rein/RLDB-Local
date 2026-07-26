import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..");
const sourceDirectory = path.join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const candidates = (await fsp.readdir(sourceDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite")
  .map((entry) => path.join(sourceDirectory, entry.name));
const files = await Promise.all(candidates.map(async (filePath) => ({ filePath, stat: await fsp.stat(filePath) })));
files.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
const sourcePath = path.resolve(process.argv[2] || files[0]?.filePath || "");
if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error("Unable to locate the operational D1 SQLite database.");

const date = new Date().toISOString().slice(0, 10);
const destinationPath = path.resolve(
  process.argv[3] || path.join(root, "runtime-data", "benchmarks", "snapshots", `rldb-${date}.sqlite`)
);
await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
if (fs.existsSync(destinationPath)) throw new Error(`Snapshot already exists: ${destinationPath}`);

console.log(`Creating online snapshot from ${sourcePath}`);
console.log(`Destination: ${destinationPath}`);
const source = new DatabaseSync(sourcePath, { readOnly: true });
await backup(source, destinationPath, {
  rate: 1000,
  progress({ totalPages, remainingPages }) {
    const copied = totalPages - remainingPages;
    if (copied === totalPages || copied % 50_000 === 0) {
      console.log(`Copied ${copied.toLocaleString()} / ${totalPages.toLocaleString()} pages`);
    }
    return 0;
  },
});
source.close();

const hash = crypto.createHash("sha256");
await new Promise((resolve, reject) => {
  const stream = fs.createReadStream(destinationPath);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", resolve);
});
const stat = await fsp.stat(destinationPath);
const metadata = {
  createdAtUtc: new Date().toISOString(),
  sourcePath,
  destinationPath,
  sizeBytes: stat.size,
  sha256: hash.digest("hex"),
};
const metadataPath = `${destinationPath}.metadata.json`;
await fsp.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(metadataPath);
