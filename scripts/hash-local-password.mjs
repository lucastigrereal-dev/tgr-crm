import { randomBytes, scryptSync } from "node:crypto";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8").trimEnd();

if (password.length < 12) {
  console.error("Password must have at least 12 characters.");
  process.exit(1);
}

const salt = randomBytes(16);
const digest = scryptSync(password, salt, 64);
process.stdout.write(`scrypt:${salt.toString("hex")}:${digest.toString("hex")}`);
