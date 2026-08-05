import pg from "pg";

import { config } from "./config.js";
import { featuresForTier, DEFAULT_TIER } from "./features.js";

/**
 * Client registry access. Every request in multi-tenant mode resolves its
 * client row through here — there is deliberately no caching of "the current
 * client" anywhere; callers receive a per-request store object and pass it
 * down explicitly.
 */

let pool = null;

export function getPool() {
  if (!pool) {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is not configured — multi-tenant mode unavailable.");
    }
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      // Supabase's pooler presents a cert most local trust stores reject.
      ssl: config.databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false },
      max: 10,
    });
  }
  return pool;
}

/**
 * Test seam: inject a pg-compatible pool (e.g. pg-mem). Inert in production —
 * calling it requires code already running inside this process.
 */
export function setPoolForTesting(testPool) {
  pool = testPool;
}

function toStore(row) {
  return {
    // Namespace key for token cache and session isolation.
    clientKey: row.client_id,
    domain: row.store_domain,
    shopifyClientId: row.shopify_client_id,
    shopifyClientSecret: row.shopify_client_secret,
    adminToken: null,
    // 'live' -> real Admin API calls; 'demo' -> in-memory scraped catalogue,
    // no Shopify credentials, order lookups honestly declined.
    mode: row.mode === "demo" ? "demo" : "live",
    demoCatalog: row.demo_catalog ?? null,
    tier: row.tier ?? DEFAULT_TIER,
    // Resolved once per request so downstream code checks
    // store.features.<name> instead of re-deriving from the tier.
    features: featuresForTier(row.tier ?? DEFAULT_TIER),
    allowedOrigins: String(row.allowed_origin)
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  };
}

/** Resolve one client row into a store object, or null when unknown. */
export async function getClientById(clientId) {
  const result = await getPool().query(
    "select client_id, store_domain, shopify_client_id, shopify_client_secret, allowed_origin, mode, demo_catalog, tier from clients where client_id = $1",
    [clientId]
  );
  return result.rows[0] ? toStore(result.rows[0]) : null;
}

/**
 * Every client whose tier grants `featureName`, as resolved store objects.
 * The gate lives here (one place) rather than in each background job.
 */
export async function listClientsWithFeature(featureName) {
  const result = await getPool().query(
    "select client_id, store_domain, shopify_client_id, shopify_client_secret, allowed_origin, mode, demo_catalog, tier from clients"
  );
  return result.rows.map(toStore).filter((store) => store.features[featureName] === true);
}

/**
 * Whether any registered client allows this origin — used only to answer CORS
 * preflights, which carry no request body and therefore no client_id. The
 * origin↔client binding is enforced later, on the actual request.
 */
export async function originIsRegistered(origin) {
  if (!origin) return false;
  const normalized = origin.replace(/\/+$/, "");
  // Comma-separated lists with optional whitespace make SQL matching fragile;
  // the table is small (one row per client), so match in JS.
  const result = await getPool().query("select allowed_origin from clients");
  return result.rows.some((row) =>
    String(row.allowed_origin)
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .includes(normalized)
  );
}
