#!/usr/bin/env node
/**
 * Upgrade a DEMO client to LIVE once the prospect grants real Shopify access.
 *
 *   node scripts/upgrade-client.js --client-id cl_xxx \
 *     --shopify-client-id <id> --shopify-client-secret <secret> [--skip-verify]
 *
 * The client_id never changes, so a widget installed during evaluation keeps
 * working untouched — the bot simply starts answering real order questions the
 * moment this completes. Credentials are live-verified against the store's
 * domain before anything is written; demo_catalog is cleared so all product
 * data comes from the live API from then on.
 */
import { getPool } from "../src/db.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const clientId = arg("client-id");
const shopifyClientId = arg("shopify-client-id") || process.env.UPGRADE_SHOPIFY_CLIENT_ID;
// Prefer the env var: npm echoes the full command line, so a secret passed as a
// CLI flag lands in terminal history and logs.
const shopifyClientSecret =
  arg("shopify-client-secret") || process.env.UPGRADE_SHOPIFY_CLIENT_SECRET;

if (!clientId || !shopifyClientId || !shopifyClientSecret) {
  console.error(
    "Usage: node scripts/upgrade-client.js --client-id <id> " +
      "--shopify-client-id <id> --shopify-client-secret <secret> [--skip-verify]\n" +
      "Credentials may also be passed via UPGRADE_SHOPIFY_CLIENT_ID / " +
      "UPGRADE_SHOPIFY_CLIENT_SECRET env vars to keep them out of shell history."
  );
  process.exit(1);
}

const pool = getPool();
const existing = await pool.query(
  "select client_id, store_domain, mode from clients where client_id = $1",
  [clientId]
);
if (!existing.rows[0]) {
  console.error(`No client with client_id ${clientId}.`);
  process.exit(1);
}
const { store_domain: domain, mode } = existing.rows[0];
console.log(`client ${clientId} -> ${domain} (currently ${mode})`);

if (!process.argv.includes("--skip-verify")) {
  console.log(`verifying credentials against ${domain}…`);
  const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: shopifyClientId,
      client_secret: shopifyClientSecret,
    }),
  });
  if (!response.ok) {
    console.error(
      `credential check failed (HTTP ${response.status}) — nothing changed. ` +
        "Fix the credentials or pass --skip-verify to force."
    );
    process.exit(1);
  }
  console.log("credentials OK");
}

await pool.query(
  `update clients
   set shopify_client_id = $2, shopify_client_secret = $3, mode = 'live', demo_catalog = null
   where client_id = $1`,
  [clientId, shopifyClientId, shopifyClientSecret]
);
await pool.end();

console.log(`\n${clientId} upgraded to LIVE.`);
console.log("The existing widget keeps working unchanged — order lookups are active now.");
