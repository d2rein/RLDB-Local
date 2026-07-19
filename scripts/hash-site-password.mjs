import crypto from "node:crypto";

const password = process.argv[2] ?? "";

if (!password) {
  console.error("Usage: npm run auth:hash-password -- <password>");
  process.exit(1);
}

process.stdout.write(crypto.createHash("sha256").update(password).digest("hex"));
