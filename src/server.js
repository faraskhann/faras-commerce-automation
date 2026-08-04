import path from "node:path";
import { pathToFileURL } from "node:url";

import express from "express";
import Anthropic from "@anthropic-ai/sdk";

import { config } from "./config.js";
import { handleMessage } from "./agent.js";
import { rateLimit } from "./ratelimit.js";
import { clearSession, sessionCount } from "./sessions.js";
import { refreshAccessToken, usingClientCredentials } from "./token.js";
import { getClientById, originIsRegistered } from "./db.js";

export const app = express();

if (config.trustProxy) app.set("trust proxy", 1);

function normalizeOrigin(origin) {
  return String(origin || "").replace(/\/+$/, "");
}

/**
 * CORS. Preflights carry no body, so a preflight is answered for any origin
 * registered to ANY client (or the dev store's origins in dev mode). The strict
 * origin↔client binding is enforced on the actual POST below, where the
 * client_id is available.
 */
app.use(async (req, res, next) => {
  const origin = normalizeOrigin(req.headers.origin);
  res.setHeader("Vary", "Origin");

  if (origin) {
    let known = false;
    try {
      known = config.multiTenant
        ? await originIsRegistered(origin)
        : config.devStore.allowedOrigins.includes("*") ||
          config.devStore.allowedOrigins.includes(origin);
    } catch (error) {
      console.error("[cors] origin lookup failed:", error.message);
    }
    if (known) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

app.use(express.json({ limit: "100kb" }));

// Serves widget.js and demo.html for local testing.
app.use(express.static(path.join(import.meta.dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    model: config.model,
    mode: config.multiTenant ? "multi-tenant" : "dev-single-store",
    sessions: sessionCount(),
  });
});

/**
 * Resolve which store this request is for. Multi-tenant mode requires a valid
 * client_id and enforces the origin↔client binding; there is no fallback store.
 * Dev mode (no DATABASE_URL) serves exactly the env-configured store.
 *
 * Returns { store } or { status, error }.
 */
async function resolveRequestStore(req) {
  const clientId = req.body?.client_id;
  const origin = normalizeOrigin(req.headers.origin);

  if (!config.multiTenant) {
    if (clientId) {
      return {
        status: 400,
        error: "This server is not configured for multi-tenant use (no client registry).",
      };
    }
    return { store: config.devStore };
  }

  if (typeof clientId !== "string" || !clientId.trim()) {
    return { status: 400, error: "`client_id` is required." };
  }

  let store;
  try {
    store = await getClientById(clientId.trim());
  } catch (error) {
    console.error("[chat] client lookup failed:", error.message);
    return { status: 503, error: "Service temporarily unavailable. Please try again." };
  }

  if (!store) {
    // Same response shape as an origin mismatch — don't confirm which IDs exist.
    return { status: 403, error: "Unknown client or origin not allowed." };
  }

  // A browser request claiming this client must arrive from one of the origins
  // registered TO THIS CLIENT — another client's origin is rejected even though
  // it would pass the generic preflight above. The backend's own origin is also
  // allowed: that's our demo page (demo.html?client=...), served by this server.
  const selfOrigin = `${req.protocol}://${req.headers.host}`;
  if (origin && origin !== selfOrigin && !store.allowedOrigins.includes(origin)) {
    console.warn(
      `[chat] origin/client mismatch: client ${store.clientKey} from origin ${origin}`
    );
    return { status: 403, error: "Unknown client or origin not allowed." };
  }

  return { store };
}

app.post("/chat", rateLimit(config.rateLimit), async (req, res) => {
  const { message, sessionId } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "`message` is required and must be a non-empty string." });
  }
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return res.status(400).json({ error: "`sessionId` is required and must be a non-empty string." });
  }

  const resolved = await resolveRequestStore(req);
  if (!resolved.store) {
    return res.status(resolved.status).json({ error: resolved.error });
  }

  try {
    const { reply, stopReason } = await handleMessage({
      store: resolved.store,
      sessionId: sessionId.trim(),
      message: message.trim(),
    });
    res.json({ sessionId: sessionId.trim(), reply, stopReason });
  } catch (error) {
    // Claude API failures land here. Everything Shopify-related is already
    // converted into a tool_result inside the agent, so it never reaches this.
    if (error instanceof Anthropic.APIError) {
      console.error(`[chat] Anthropic API error ${error.status}:`, error.message);
      const status = error.status === 429 || error.status >= 500 ? 503 : 502;
      return res.status(status).json({
        error: "The assistant is unavailable right now. Please try again shortly.",
      });
    }

    console.error("[chat] unexpected error:", error);
    res.status(500).json({ error: "Something went wrong handling that message." });
  }
});

// Handy while testing: wipe one session's history (scoped per client).
app.delete("/chat/:sessionId", async (req, res) => {
  const resolved = await resolveRequestStore(req);
  if (!resolved.store) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  const existed = clearSession(`${resolved.store.clientKey}::${req.params.sessionId}`);
  res.json({ cleared: existed });
});

// Malformed JSON bodies reach here as a SyntaxError from express.json().
app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  return next(error);
});

export function start() {
  return app.listen(config.port, () => {
    console.log(`Listening on http://localhost:${config.port}`);
    console.log(`Model: ${config.model}`);
    if (config.multiTenant) {
      console.log("Mode:  multi-tenant (clients resolved from database per request)");
    } else {
      const dev = config.devStore;
      console.log(`Mode:  DEV single-store — ${dev.domain} (set DATABASE_URL for multi-tenant)`);
      console.log(`CORS:  ${dev.allowedOrigins.join(", ")}`);
      if (usingClientCredentials(dev)) {
        console.log("Auth:  client credentials (tokens auto-refresh)");
        refreshAccessToken(dev, "startup").catch((error) =>
          console.error(`[shopify] startup token fetch failed: ${error.message}`)
        );
      } else {
        console.log("Auth:  static SHOPIFY_ADMIN_TOKEN (expires ~24h)");
      }
    }
    console.log(`Demo:  http://localhost:${config.port}/demo.html`);
  });
}

// Keep the process alive on unexpected async failures instead of crashing the server.
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection:", reason);
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  start();
}
