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

/**
 * Origins allowed to call /chat from a browser.
 *
 * ALLOWED_ORIGIN takes a comma-separated list, or "*" to allow any origin. With it
 * unset, local development works out of the box: the dev store's own domain plus
 * localhost, so the demo page and the storefront both function without config.
 */
function resolveAllowedOrigins(storeDomain) {
  const configured = (process.env.ALLOWED_ORIGIN || "").trim();

  if (configured) {
    return configured
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean);
  }

  return [
    `https://${storeDomain}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
}

const shopifyDomain = normalizeDomain(required("SHOPIFY_STORE_DOMAIN"));

const adminToken = required("SHOPIFY_ADMIN_TOKEN");

export const config = {
  port,
  allowedOrigins: resolveAllowedOrigins(shopifyDomain),
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
  shopify: {
    domain: shopifyDomain,
    adminToken,
    apiVersion: SHOPIFY_API_VERSION,
    get graphqlUrl() {
      return `https://${this.domain}/admin/api/${this.apiVersion}/graphql.json`;
    },
  },
  model: "claude-haiku-4-5-20251001",
  // Cap on how many tool_use -> tool_result round trips one /chat call may run.
  maxToolRounds: 5,
  // Cap on stored messages per session so memory doesn't grow unbounded.
  maxHistoryMessages: 40,
};
