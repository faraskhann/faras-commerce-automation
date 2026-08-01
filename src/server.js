import path from "node:path";

import express from "express";
import Anthropic from "@anthropic-ai/sdk";

import { config } from "./config.js";
import { handleMessage } from "./agent.js";
import { rateLimit } from "./ratelimit.js";
import { clearSession, sessionCount } from "./sessions.js";
import { refreshAccessToken, usingClientCredentials } from "./token.js";

const app = express();

if (config.trustProxy) app.set("trust proxy", 1);

/**
 * CORS for the storefront widget. The widget runs on the shop's domain and calls
 * this server cross-origin, so /chat needs both the response header and a preflight
 * answer — a JSON POST always triggers one.
 */
app.use((req, res, next) => {
  const { origin } = req.headers;
  const allowAny = config.allowedOrigins.includes("*");

  if (origin && (allowAny || config.allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", allowAny ? "*" : origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  // Responses differ by Origin, so caches must not share them across origins.
  res.setHeader("Vary", "Origin");

  // Disallowed origins fall through without the headers, and the browser blocks them.
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

app.use(express.json({ limit: "100kb" }));

// Serves widget.js and demo.html for local testing.
app.use(express.static(path.join(import.meta.dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: config.model, sessions: sessionCount() });
});

app.post("/chat", rateLimit(config.rateLimit), async (req, res) => {
  const { message, sessionId } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "`message` is required and must be a non-empty string." });
  }
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return res.status(400).json({ error: "`sessionId` is required and must be a non-empty string." });
  }

  try {
    const { reply, stopReason } = await handleMessage({
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

// Handy while testing: wipe one session's history.
app.delete("/chat/:sessionId", (req, res) => {
  const existed = clearSession(req.params.sessionId);
  res.json({ cleared: existed });
});

// Malformed JSON bodies reach here as a SyntaxError from express.json().
app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  return next(error);
});

app.listen(config.port, () => {
  console.log(`Listening on http://localhost:${config.port}`);
  console.log(`Model: ${config.model}`);
  console.log(`Store: ${config.shopify.domain} (Admin API ${config.shopify.apiVersion})`);
  if (usingClientCredentials()) {
    console.log("Auth:  client credentials (tokens auto-refresh)");
    // Warm the token now so the first shopper doesn't pay the refresh latency.
    // Failure is loud but non-fatal — calls will retry, and /health stays up.
    refreshAccessToken("startup").catch((error) =>
      console.error(`[shopify] startup token fetch failed: ${error.message}`)
    );
  } else {
    console.log("Auth:  static SHOPIFY_ADMIN_TOKEN (expires ~24h — set SHOPIFY_CLIENT_ID/SECRET for auto-refresh)");
  }
  console.log(`CORS:  ${config.allowedOrigins.join(", ")}`);
  console.log(`Demo:  http://localhost:${config.port}/demo.html`);
});

// Keep the process alive on unexpected async failures instead of crashing the server.
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection:", reason);
});
