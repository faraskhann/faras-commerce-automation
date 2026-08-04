#!/usr/bin/env node
/**
 * Delete ALL events for ONE client — for wiping test/demo noise.
 *
 *   npm run clear-metrics -- --client-id cl_xxx
 *
 * client_id is mandatory by design: there is deliberately no way to clear
 * every client's metrics in one command.
 */
import { getPool } from "../src/db.js";

const i = process.argv.indexOf("--client-id");
const clientId = i > -1 ? process.argv[i + 1] : null;

if (!clientId || !clientId.trim()) {
  console.error(
    "Refusing to run: --client-id is required.\n" +
      "This command clears one client's events only; a global wipe is intentionally not supported."
  );
  process.exit(1);
}

const pool = getPool();
const result = await pool.query("delete from events where client_id = $1", [clientId.trim()]);
await pool.end();

console.log(`deleted ${result.rowCount} event(s) for client ${clientId.trim()}`);
