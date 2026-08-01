import { config } from "./config.js";

/**
 * Shopify access-token lifecycle for the client credentials grant.
 *
 * Tokens from this grant expire after ~24 hours, so a pasted SHOPIFY_ADMIN_TOKEN
 * silently dies in production. With SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET set,
 * the backend fetches its own token at runtime, refreshes proactively within
 * EXPIRY_MARGIN_MS of expiry, and re-fetches on an unexpected 401.
 *
 * Falls back to the static SHOPIFY_ADMIN_TOKEN when client credentials are not
 * configured (useful for quick local testing with a token you just minted).
 */

const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

let cached = { token: null, expiresAt: 0 };
let inflight = null;

export function usingClientCredentials() {
  return Boolean(config.shopify.clientId && config.shopify.clientSecret);
}

/**
 * The token to use for the next API call. Refreshes first when the cached one
 * is missing, expired, or inside the expiry margin.
 */
export async function getAccessToken() {
  if (!usingClientCredentials()) return config.shopify.adminToken;

  if (cached.token && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) {
    return cached.token;
  }
  return refreshAccessToken(cached.token ? "token near expiry" : "no token cached");
}

/** Force the next getAccessToken() to fetch fresh — used after a 401. */
export function invalidateAccessToken() {
  cached = { token: null, expiresAt: 0 };
}

/**
 * Fetch a new token via the client credentials grant. Concurrent callers share
 * one in-flight request rather than stampeding the OAuth endpoint.
 */
export function refreshAccessToken(reason) {
  if (!inflight) {
    inflight = requestToken(reason).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function requestToken(reason) {
  const url = `https://${config.shopify.domain}/admin/oauth/access_token`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: config.shopify.clientId,
        client_secret: config.shopify.clientSecret,
      }),
    });
  } catch (cause) {
    throw new Error(`Shopify token refresh failed: ${cause.message}`);
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.access_token) {
    // Never include the secret or any returned token material in the error.
    const detail = body.error_description || body.error || `HTTP ${response.status}`;
    throw new Error(`Shopify token refresh rejected (${detail}).`);
  }

  const expiresInSec = Number(body.expires_in) || 86400;
  cached = {
    token: body.access_token,
    expiresAt: Date.now() + expiresInSec * 1000,
  };

  console.log(
    `[shopify] access token refreshed (${reason}); ` +
      `expires in ${Math.round(expiresInSec / 3600)}h at ${new Date(cached.expiresAt).toISOString()}`
  );
  return cached.token;
}
