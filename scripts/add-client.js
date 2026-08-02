#!/usr/bin/env node
/**
 * Register a client store (run by the operator, never exposed as an endpoint).
 *
 *   node scripts/add-client.js \
 *     --domain acme.myshopify.com \
 *     --shopify-client-id <id> \
 *     --shopify-client-secret <secret> \
 *     --origin https://acme.myshopify.com,https://www.acme.com \
 *     [--client-id acme]        (default: generated)
 *     [--skip-verify]           (skip the live credential check)
 *
 * Verifies the Shopify credentials with a real token grant before inserting,
 * so a typo fails here instead of in production.
 */
import crypto from "node:crypto";

import { getPool } from "../src/db.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const domain = (arg("domain") || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const shopifyClientId = arg("shopify-client-id");
const shopifyClientSecret = arg("shopify-client-secret");
const origin = (arg("origin") || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean)
  .join(",");
const clientId = arg("client-id") || `cl_${crypto.randomBytes(8).toString("hex")}`;

if (!domain || !shopifyClientId || !shopifyClientSecret || !origin) {
  console.error(
    "Usage: node scripts/add-client.js --domain <store.myshopify.com> " +
      "--shopify-client-id <id> --shopify-client-secret <secret> " +
      "--origin <https://...[,https://...]> [--client-id <id>] [--skip-verify]"
  );
  process.exit(1);
}

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
      `credential check failed (HTTP ${response.status}) — not inserting. ` +
        "Fix the credentials or pass --skip-verify to force."
    );
    process.exit(1);
  }
  console.log("credentials OK");
}

const pool = getPool();
await pool.query(
  `insert into clients (client_id, store_domain, shopify_client_id, shopify_client_secret, allowed_origin)
   values ($1, $2, $3, $4, $5)`,
  [clientId, domain, shopifyClientId, shopifyClientSecret, origin]
);
await pool.end();

console.log(`\nclient registered: ${clientId} -> ${domain}`);
console.log(`allowed origins:   ${origin}`);
console.log("\nWidget snippet for this client's theme.liquid:\n");
console.log(`  <script`);
console.log(`    src="https://YOUR-BACKEND-HOST/widget.js"`);
console.log(`    data-api-url="https://YOUR-BACKEND-HOST"`);
console.log(`    data-client-id="${clientId}"`);
console.log(`  ></script>`);
