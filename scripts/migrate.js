#!/usr/bin/env node
/** Apply every migrations/*.sql to DATABASE_URL, in filename order. Idempotent. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { getPool } from "../src/db.js";

const dir = path.join(import.meta.dirname, "..", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const pool = getPool();
for (const file of files) {
  await pool.query(readFileSync(path.join(dir, file), "utf8"));
  console.log(`applied ${file}`);
}
await pool.end();
console.log("migrations complete");
