/**
 * Shopify access-token lifecycle, per client store.
 *
 * Tokens from the client credentials grant expire after ~24 hours. Each store's
 * token is cached independently, keyed by the store's clientKey — one client's
 * expiry, refresh, or failure never touches another's. Refreshes happen
 * proactively within EXPIRY_MARGIN_MS of expiry, and once more reactively if
 * Shopify answers 401 anyway.
 *
 * Stores carrying a static adminToken (the dev fallback) bypass the cache.
 *
 * All functions take the store object explicitly — no module-level "current
 * store" exists anywhere, so concurrent requests for different clients cannot
 * read each other's credentials.
 */

const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// clientKey -> { token, expiresAt }
const cache = new Map();
// clientKey -> in-flight refresh promise (concurrent callers share one request)
const inflight = new Map();

export function usingClientCredentials(store) {
  return Boolean(store.shopifyClientId && store.shopifyClientSecret);
}

/** The token for this store's next API call, refreshing first when needed. */
export async function getAccessToken(store) {
  if (!usingClientCredentials(store)) return store.adminToken;

  const cached = cache.get(store.clientKey);
  if (cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) {
    return cached.token;
  }
  return refreshAccessToken(store, cached ? "token near expiry" : "no token cached");
}

/** Force this store's next getAccessToken() to fetch fresh — used after a 401. */
export function invalidateAccessToken(store) {
  cache.delete(store.clientKey);
}

/** Fetch a new token for this store via the client credentials grant. */
export function refreshAccessToken(store, reason) {
  let pending = inflight.get(store.clientKey);
  if (!pending) {
    pending = requestToken(store, reason).finally(() => {
      inflight.delete(store.clientKey);
    });
    inflight.set(store.clientKey, pending);
  }
  return pending;
}

async function requestToken(store, reason) {
  const url = `https://${store.domain}/admin/oauth/access_token`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: store.shopifyClientId,
        client_secret: store.shopifyClientSecret,
      }),
    });
  } catch (cause) {
    throw new Error(`Shopify token refresh failed for ${store.domain}: ${cause.message}`);
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.access_token) {
    // Never include the secret or any returned token material in the error.
    const detail = body.error_description || body.error || `HTTP ${response.status}`;
    throw new Error(`Shopify token refresh rejected for ${store.domain} (${detail}).`);
  }

  const expiresInSec = Number(body.expires_in) || 86400;
  cache.set(store.clientKey, {
    token: body.access_token,
    expiresAt: Date.now() + expiresInSec * 1000,
  });

  console.log(
    `[shopify:${store.clientKey}] access token refreshed (${reason}); ` +
      `expires in ${Math.round(expiresInSec / 3600)}h at ${new Date(
        Date.now() + expiresInSec * 1000
      ).toISOString()}`
  );
  return body.access_token;
}
