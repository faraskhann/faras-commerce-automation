#!/usr/bin/env node
/**
 * Change a client's plan tier.
 *
 *   npm run set-tier -- --client-id cl_xxx --tier premium
 *
 * Tiers map to features in src/features.js. Takes effect on the next request
 * and the next poll — no restart or redeploy.
 */
import { getPool } from "../src/db.js";
import { VALID_TIERS, featuresForTier } from "../src/features.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const clientId = arg("client-id");
const tier = arg("tier");

if (!clientId || !tier) {
  console.error(`Usage: npm run set-tier -- --client-id <id> --tier <${VALID_TIERS.join("|")}>`);
  process.exit(1);
}
if (!VALID_TIERS.includes(tier)) {
  console.error(`Invalid tier "${tier}". Valid tiers: ${VALID_TIERS.join(", ")}`);
  process.exit(1);
}

const pool = getPool();
const existing = await pool.query(
  "select client_id, store_domain, tier from clients where client_id = $1",
  [clientId]
);
if (!existing.rows[0]) {
  console.error(`No client with client_id ${clientId}.`);
  process.exit(1);
}

const previous = existing.rows[0].tier;
await pool.query("update clients set tier = $2 where client_id = $1", [clientId, tier]);
await pool.end();

const featureList = (features) =>
  Object.entries(features)
    .map(([name, on]) => `${name}=${on ? "on" : "off"}`)
    .join(", ");

console.log(`${clientId} (${existing.rows[0].store_domain})`);
console.log(`  tier:     ${previous}  ->  ${tier}${previous === tier ? "   (unchanged)" : ""}`);
console.log(`  features: ${featureList(featuresForTier(previous))}  ->  ${featureList(featuresForTier(tier))}`);
