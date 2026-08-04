import "dotenv/config";

const SHOPIFY_API_VERSION = "2026-07";

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value.trim();
}

// Accepts "your-store.myshopify.com" or a full URL, normalizes to a bare host.
function normalizeDomain(raw) {
  return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

const port = Number(process.env.PORT) || 3000;

const databaseUrl = (process.env.DATABASE_URL || "").trim() || null;

/**
 * DEV-ONLY single-store fallback, active only when DATABASE_URL is not set.
 * In multi-tenant mode every request resolves its store from the clients table
 * and these env vars are ignored entirely — there is no default store to fall
 * back to.
 */
function resolveDevStore() {
  const domainRaw = (process.env.SHOPIFY_STORE_DOMAIN || "").trim();
  if (!domainRaw) return null;

  const clientId = (process.env.SHOPIFY_CLIENT_ID || "").trim() || null;
  const clientSecret = (process.env.SHOPIFY_CLIENT_SECRET || "").trim() || null;
  const adminToken = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim() || null;

  if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
    throw new Error(
      "SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set together — only one is present."
    );
  }
  if (!clientId && !adminToken) {
    throw new Error(
      "Dev store needs SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (recommended) " +
        "or SHOPIFY_ADMIN_TOKEN in .env."
    );
  }

  const domain = normalizeDomain(domainRaw);
  const configuredOrigins = (process.env.ALLOWED_ORIGIN || "").trim();
  const allowedOrigins = configuredOrigins
    ? configuredOrigins.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean)
    : [`https://${domain}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`];

  return {
    clientKey: "__dev",
    domain,
    shopifyClientId: clientId,
    shopifyClientSecret: clientSecret,
    adminToken,
    allowedOrigins,
  };
}

const devStore = resolveDevStore();

if (!databaseUrl && !devStore) {
  throw new Error(
    "Configure DATABASE_URL for multi-tenant mode, or SHOPIFY_STORE_DOMAIN (+ credentials) " +
      "for single-store local development."
  );
}

export const config = {
  port,
  databaseUrl,
  // true -> clients come from the database; false -> dev single-store mode.
  multiTenant: Boolean(databaseUrl),
  devStore,
  rateLimit: {
    perIpPerMinute: Number(process.env.RATE_LIMIT_PER_IP) || 20,
    perSessionPerMinute: Number(process.env.RATE_LIMIT_PER_SESSION) || 12,
  },
  // Set TRUST_PROXY=1 when deployed behind a reverse proxy (Railway, Render,
  // nginx...) so req.ip is the real client address from X-Forwarded-For rather
  // than the proxy's — otherwise the per-IP rate limit throttles all shoppers
  // collectively. Leave unset when the server is hit directly.
  trustProxy: process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true",
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  // Password for the /admin dashboard. Unset -> admin routes are disabled.
  adminPassword: (process.env.ADMIN_PASSWORD || "").trim() || null,
  shopifyApiVersion: SHOPIFY_API_VERSION,
  model: "claude-haiku-4-5-20251001",
  // Cap on how many tool_use -> tool_result round trips one /chat call may run.
  maxToolRounds: 5,
  // Cap on stored messages per session so memory doesn't grow unbounded.
  maxHistoryMessages: 40,
};

/** Admin GraphQL endpoint for a given store domain. */
export function graphqlUrlFor(domain) {
  return `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}
