import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PROJECT_ROOT = "C:\\Users\\d2rei\\Rugby-League-Stats-Database";
const SEED_DIR = path.join(PROJECT_ROOT, "seed");
const TMP_DIR = path.join(PROJECT_ROOT, ".wrangler", "tmp", "remote-seed");

function parseCliArgs(argv) {
  const options = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      options.set(rawKey, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(rawKey, next);
      index += 1;
    } else {
      options.set(rawKey, "1");
    }
  }
  return options;
}

const cliArgs = parseCliArgs(process.argv);
const DATABASE_BINDING = cliArgs.get("binding") || process.env.D1_DATABASE_BINDING || "rl_stats_db";
const WRANGLER_PACKAGE = cliArgs.get("wrangler-package") || process.env.WRANGLER_NPX_PACKAGE || "wrangler";
const REQUESTED_MAX_CHUNK_BYTES = Number.parseInt(cliArgs.get("max-chunk-bytes") || process.env.D1_REMOTE_SEED_MAX_CHUNK_BYTES || `${4 * 1024 * 1024}`, 10);
const START_AT = cliArgs.get("start-at") || process.env.D1_REMOTE_SEED_START_AT || "";
const END_AT = cliArgs.get("end-at") || process.env.D1_REMOTE_SEED_END_AT || "";
const ONLY_FILE = cliArgs.get("only-file") || process.env.D1_REMOTE_SEED_ONLY_FILE || "";
const MAX_CHUNKS = Number.parseInt(cliArgs.get("max-chunks") || process.env.D1_REMOTE_SEED_MAX_CHUNKS || "0", 10);
const MAX_RETRIES = Number.parseInt(cliArgs.get("max-retries") || process.env.D1_REMOTE_SEED_MAX_RETRIES || "4", 10);
const HEARTBEAT_MS = Number.parseInt(cliArgs.get("heartbeat-ms") || process.env.D1_REMOTE_SEED_HEARTBEAT_MS || "30000", 10);
const ALLOW_REMOTE_FULL_RESEED = cliArgs.get("allow-full-reseed") === "1" || process.env.D1_REMOTE_ALLOW_FULL_RESEED === "1";
const RESUME_CHECKPOINT = cliArgs.get("resume") === "1" || process.env.D1_REMOTE_SEED_RESUME === "1";
const RESET_CHECKPOINT = cliArgs.get("reset-checkpoint") === "1" || process.env.D1_REMOTE_SEED_RESET_CHECKPOINT === "1";
const CHECKPOINT_PATH = cliArgs.get("checkpoint") || process.env.D1_REMOTE_SEED_CHECKPOINT || path.join(TMP_DIR, "remote-seed-checkpoint.json");
const LEGACY_REMOTE_RESEED_PATTERN = /^000[1-5]_/;
const LEGACY_REMOTE_SAFE_CHUNK_BYTES = 1 * 1024 * 1024;
const CURRENT_REFRESH_PATTERN = /^0100_current_season_refresh_/;

async function readSqlFiles(dirPath) {
  const entries = await fs.readdir(dirPath);
  return entries
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((entry) => path.join(dirPath, entry));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runWranglerOnce(filePath) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const basename = path.basename(filePath);
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      console.log(`    still running ${basename}... ${elapsedSeconds}s elapsed`);
    }, HEARTBEAT_MS);

    const wranglerArgs = [WRANGLER_PACKAGE, "d1", "execute", DATABASE_BINDING, "--remote", "--yes", "--file", filePath];
    const child = process.platform === "win32"
      ? spawn(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `& 'npx.cmd' ${wranglerArgs.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(" ")}`,
          ],
          {
            cwd: PROJECT_ROOT,
            stdio: "inherit",
          }
        )
      : spawn("npx", wranglerArgs, {
          cwd: PROJECT_ROOT,
          stdio: "inherit",
        });

    child.on("exit", (code) => {
      clearInterval(heartbeat);
      if (code === 0) {
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        console.log(`    finished ${basename} in ${elapsedSeconds}s`);
        resolve();
        return;
      }
      reject(new Error(`wrangler d1 execute failed for ${path.basename(filePath)} with code ${code}`));
    });
    child.on("error", (error) => {
      clearInterval(heartbeat);
      reject(error);
    });
  });
}

async function runWrangler(filePath) {
  let attempt = 0;
  let lastError;

  while (attempt < MAX_RETRIES) {
    try {
      if (attempt > 0) {
        console.log(`  Retry ${attempt + 1} of ${MAX_RETRIES}: ${path.basename(filePath)}`);
      }
      await runWranglerOnce(filePath);
      return;
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= MAX_RETRIES) {
        throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

function isIgnorableStatement(statement) {
  const trimmed = statement.trim();
  return !trimmed || trimmed.startsWith("--");
}

function normalizeExecutableStatement(statement) {
  let normalized = statement.trim();

  while (normalized.startsWith("--")) {
    const newlineIndex = normalized.indexOf("\n");
    if (newlineIndex === -1) {
      return "";
    }
    normalized = normalized.slice(newlineIndex + 1).trim();
  }

  while (normalized.startsWith("/*")) {
    const blockEnd = normalized.indexOf("*/");
    if (blockEnd === -1) {
      return "";
    }
    normalized = normalized.slice(blockEnd + 2).trim();
  }

  return normalized.replace(/;\s*$/, "").trim();
}

function isTransactionControlStatement(statement) {
  const normalized = statement.trim().replace(/\s+/g, " ").toUpperCase();
  return normalized === "BEGIN TRANSACTION;" ||
    normalized === "BEGIN TRANSACTION" ||
    normalized === "BEGIN;" ||
    normalized === "BEGIN" ||
    normalized === "COMMIT;" ||
    normalized === "COMMIT" ||
    normalized.startsWith("SAVEPOINT ") ||
    normalized.startsWith("RELEASE SAVEPOINT ") ||
    normalized.startsWith("ROLLBACK TO SAVEPOINT ") ||
    normalized === "END TRANSACTION;" ||
    normalized === "END TRANSACTION";
}

async function removeExistingChunkFiles(filePath) {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const parsed = path.parse(filePath);
  const entries = await fs.readdir(TMP_DIR);
  await Promise.all(
    entries
      .filter((entry) => entry === parsed.base || (entry.startsWith(`${parsed.name}.part`) && entry.endsWith(parsed.ext)))
      .map((entry) => fs.rm(path.join(TMP_DIR, entry), { force: true }))
  );
}

async function writeChunkFile(baseName, chunkIndex, chunkContent) {
  const parsed = path.parse(baseName);
  const suffix = chunkIndex === 1 ? "" : `.part${String(chunkIndex).padStart(4, "0")}`;
  const chunkPath = path.join(TMP_DIR, `${parsed.name}${suffix}${parsed.ext}`);
  await new Promise((resolve, reject) => {
    const writer = createWriteStream(chunkPath, { encoding: "utf8" });
    writer.on("error", reject);
    writer.on("finish", resolve);
    writer.end(chunkContent);
  });
  return {
    chunkPath,
    bytes: Buffer.byteLength(chunkContent, "utf8"),
  };
}

function effectiveChunkBytesForFile(filePath) {
  const basename = path.basename(filePath);
  if (LEGACY_REMOTE_RESEED_PATTERN.test(basename)) {
    return Math.min(REQUESTED_MAX_CHUNK_BYTES, LEGACY_REMOTE_SAFE_CHUNK_BYTES);
  }
  return REQUESTED_MAX_CHUNK_BYTES;
}

async function createRemoteSqlChunks(filePath) {
  await removeExistingChunkFiles(filePath);
  const effectiveMaxChunkBytes = effectiveChunkBytesForFile(filePath);

  const chunkFiles = [];
  let currentStatement = "";
  let currentChunk = "";
  let currentChunkBytes = 0;
  let chunkIndex = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  async function flushChunk() {
    if (!currentChunk) return;
    const written = await writeChunkFile(path.basename(filePath), chunkIndex, currentChunk);
    chunkFiles.push(written);
    chunkIndex += 1;
    currentChunk = "";
    currentChunkBytes = 0;
  }

  async function appendStatement(statement) {
    if (isIgnorableStatement(statement)) {
      return;
    }
    const executable = normalizeExecutableStatement(statement);
    if (!executable || isTransactionControlStatement(executable)) {
      return;
    }
    const statementWithTerminator = `${executable};\n`;
    const statementBytes = Buffer.byteLength(statementWithTerminator, "utf8");
    if (statementBytes > effectiveMaxChunkBytes) {
      throw new Error(`Single SQL statement exceeds remote chunk size (${effectiveMaxChunkBytes} bytes).`);
    }
    if (currentChunk && currentChunkBytes + statementBytes > effectiveMaxChunkBytes) {
      await flushChunk();
    }
    currentChunk += statementWithTerminator;
    currentChunkBytes += statementBytes;
  }

  const stream = createReadStream(filePath, { encoding: "utf8" });
  for await (const chunk of stream) {
    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index];
      const nextChar = chunk[index + 1] ?? "";

      if (inLineComment) {
        currentStatement += char;
        if (char === "\n") {
          inLineComment = false;
        }
        continue;
      }

      if (inBlockComment) {
        currentStatement += char;
        if (char === "*" && nextChar === "/") {
          currentStatement += nextChar;
          index += 1;
          inBlockComment = false;
        }
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote) {
        if (char === "-" && nextChar === "-") {
          currentStatement += char + nextChar;
          index += 1;
          inLineComment = true;
          continue;
        }
        if (char === "/" && nextChar === "*") {
          currentStatement += char + nextChar;
          index += 1;
          inBlockComment = true;
          continue;
        }
      }

      currentStatement += char;

      if (char === "'" && !inDoubleQuote) {
        const escapedQuote = nextChar === "'";
        if (escapedQuote) {
          currentStatement += "'";
          index += 1;
        } else {
          inSingleQuote = !inSingleQuote;
        }
        continue;
      }

      if (char === "\"" && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      if (char === ";" && !inSingleQuote && !inDoubleQuote) {
        const statement = currentStatement.trim();
        currentStatement = "";
        if (statement) {
          await appendStatement(statement);
        }
      }
    }
  }

  const trailingStatement = currentStatement.trim();
  if (trailingStatement) {
    await appendStatement(trailingStatement);
  }
  await flushChunk();

  return chunkFiles.length > 0 ? chunkFiles : [await writeChunkFile(path.basename(filePath), 1, "")];
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function stepCheckpointKey(step) {
  return `${path.basename(step.seedFilePath)}::${path.basename(step.chunkPath)}`;
}

async function loadCheckpoint() {
  if (!RESUME_CHECKPOINT) {
    return { completed: new Set() };
  }
  if (RESET_CHECKPOINT) {
    await fs.rm(CHECKPOINT_PATH, { force: true });
    return { completed: new Set() };
  }
  try {
    const raw = await fs.readFile(CHECKPOINT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { completed: new Set(Array.isArray(parsed.completed) ? parsed.completed : []) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { completed: new Set() };
    }
    throw error;
  }
}

async function saveCheckpoint(completed) {
  if (!RESUME_CHECKPOINT) {
    return;
  }
  await fs.mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    completed: [...completed].sort(),
  };
  await fs.writeFile(CHECKPOINT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function buildExecutionPlan() {
  if (START_AT.includes(".part")) {
    const tempFiles = await readSqlFiles(TMP_DIR);
    let filteredFiles = tempFiles.filter((filePath) => path.basename(filePath) >= START_AT);
    if (ONLY_FILE) {
      const onlyParsed = path.parse(ONLY_FILE);
      filteredFiles = filteredFiles.filter((filePath) => path.basename(filePath).startsWith(onlyParsed.name));
    }
    let plan = await Promise.all(
      filteredFiles.map(async (filePath, index) => ({
        seedFilePath: filePath,
        chunkPath: filePath,
        fileIndex: index + 1,
        fileCount: filteredFiles.length,
        chunkIndex: 1,
        chunkCount: 1,
        bytes: (await fs.stat(filePath)).size,
      }))
    );
    if (END_AT) {
      plan = plan.filter((step) => path.basename(step.chunkPath) <= END_AT);
    }
    return plan;
  }

  const seedFiles = await readSqlFiles(SEED_DIR);
  let filteredSeedFiles = START_AT
    ? seedFiles.filter((filePath) => path.basename(filePath) >= START_AT)
    : seedFiles.filter((filePath) => !CURRENT_REFRESH_PATTERN.test(path.basename(filePath)));
  if (ONLY_FILE) {
    filteredSeedFiles = filteredSeedFiles.filter((filePath) => path.basename(filePath) === ONLY_FILE);
  }

  const plan = [];
  for (const [fileIndex, filePath] of filteredSeedFiles.entries()) {
    const remoteChunks = await createRemoteSqlChunks(filePath);
    for (const [chunkIndex, remoteChunk] of remoteChunks.entries()) {
      plan.push({
        seedFilePath: filePath,
        chunkPath: remoteChunk.chunkPath,
        fileIndex: fileIndex + 1,
        fileCount: filteredSeedFiles.length,
        chunkIndex: chunkIndex + 1,
        chunkCount: remoteChunks.length,
        bytes: remoteChunk.bytes,
        chunkSizeLimitBytes: effectiveChunkBytesForFile(filePath),
      });
    }
  }
  if (END_AT) {
    return plan.filter((step) => path.basename(step.chunkPath) <= END_AT);
  }
  return plan;
}

const checkpoint = await loadCheckpoint();
let executionPlan = await buildExecutionPlan();
if (RESUME_CHECKPOINT) {
  const beforeResumeFilter = executionPlan.length;
  executionPlan = executionPlan.filter((step) => !checkpoint.completed.has(stepCheckpointKey(step)));
  const skipped = beforeResumeFilter - executionPlan.length;
  if (skipped > 0) {
    console.log(`Resume checkpoint skipped ${skipped} already-completed chunk(s).`);
  }
}
if (MAX_CHUNKS > 0) {
  executionPlan = executionPlan.slice(0, MAX_CHUNKS);
}
const legacySeedFiles = [...new Set(
  executionPlan
    .map((step) => path.basename(step.seedFilePath))
    .filter((basename) => LEGACY_REMOTE_RESEED_PATTERN.test(basename))
)];
if (legacySeedFiles.length > 0 && !ALLOW_REMOTE_FULL_RESEED) {
  throw new Error(
    `Refusing to apply legacy remote reseed files without explicit opt-in: ${legacySeedFiles.join(", ")}. ` +
    "Set D1_REMOTE_ALLOW_FULL_RESEED=1 or pass --allow-full-reseed=1 only when you intentionally need a full historical restore."
  );
}
const totalChunks = executionPlan.length;
const totalBytes = executionPlan.reduce((sum, step) => sum + step.bytes, 0);
const overallStartedAt = Date.now();
const minimumChunkLimit = executionPlan.reduce(
  (minimum, step) => Math.min(minimum, step.chunkSizeLimitBytes ?? REQUESTED_MAX_CHUNK_BYTES),
  REQUESTED_MAX_CHUNK_BYTES
);

console.log(`Remote D1 seed plan: ${totalChunks} chunk(s) across ${new Set(executionPlan.map((step) => step.seedFilePath)).size} file(s).`);
console.log(`Requested chunk size limit: ${formatBytes(REQUESTED_MAX_CHUNK_BYTES)}. Total upload volume: ${formatBytes(totalBytes)}.`);
if (END_AT) {
  console.log(`Plan is bounded to chunks/files up to: ${END_AT}`);
}
if (ONLY_FILE) {
  console.log(`Plan is restricted to seed file: ${ONLY_FILE}`);
}
if (MAX_CHUNKS > 0) {
  console.log(`Plan is capped at ${MAX_CHUNKS} chunk(s) for this run.`);
}
if (RESUME_CHECKPOINT) {
  console.log(`Resume checkpoint: ${CHECKPOINT_PATH}`);
}
if (minimumChunkLimit !== REQUESTED_MAX_CHUNK_BYTES) {
  console.log(
    `Legacy reseed files are automatically capped at ${formatBytes(minimumChunkLimit)} per chunk to avoid remote D1 import/reset failures.`
  );
}

for (const [overallIndex, step] of executionPlan.entries()) {
  const seedBase = path.basename(step.seedFilePath);
  const chunkBase = path.basename(step.chunkPath);
  console.log(
    `[${overallIndex + 1}/${totalChunks}] File ${step.fileIndex}/${step.fileCount}: ${seedBase}` +
    `${step.chunkCount > 1 ? ` | chunk ${step.chunkIndex}/${step.chunkCount}` : ""}` +
    ` | ${formatBytes(step.bytes)}`
  );
  await runWrangler(step.chunkPath);
  checkpoint.completed.add(stepCheckpointKey(step));
  await saveCheckpoint(checkpoint.completed);

  const completed = overallIndex + 1;
  const elapsedSeconds = Math.floor((Date.now() - overallStartedAt) / 1000);
  const avgSecondsPerChunk = completed > 0 ? elapsedSeconds / completed : 0;
  const remainingChunks = totalChunks - completed;
  const etaSeconds = Math.max(0, Math.round(avgSecondsPerChunk * remainingChunks));
  console.log(
    `  progress: ${completed}/${totalChunks} chunks complete` +
    ` | elapsed ${elapsedSeconds}s` +
    ` | est. remaining ${etaSeconds}s`
  );
}

const totalElapsedSeconds = Math.floor((Date.now() - overallStartedAt) / 1000);
console.log(`Remote D1 refresh complete in ${totalElapsedSeconds}s.`);
