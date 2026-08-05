import crypto from "node:crypto";
import path from "node:path";

import express from "express";

import { config } from "./config.js";
import { overviewMetrics, listClientsWithCounts } from "./metrics.js";
import { getClientDiscountInfo } from "./db.js";

/**
 * Password-protected internal admin dashboard.
 *
 * One shared password (ADMIN_PASSWORD) — no accounts, no registration. On
 * login a random session token is stored server-side and handed out as an
 * httpOnly cookie; everything under /admin and /admin/api requires it.
 * With ADMIN_PASSWORD unset, every admin route answers 503.
 */

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "admin_session";

// token -> expiry epoch ms. In-memory: restarts log everyone out, acceptable.
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}, 60 * 60 * 1000).unref();

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest();
}

// Hashing both sides first gives equal-length buffers, which timingSafeEqual
// requires — and keeps the comparison timing-safe regardless of input length.
function passwordMatches(supplied) {
  if (!config.adminPassword || typeof supplied !== "string") return false;
  return crypto.timingSafeEqual(sha256(supplied), sha256(config.adminPassword));
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > -1) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const expiresAt = sessions.get(token);
  return Boolean(expiresAt && expiresAt > Date.now());
}

/**
 * True when the request reached us over HTTPS. Checks X-Forwarded-Proto directly
 * as well as req.secure, so the Secure flag is still set behind Railway's proxy
 * even if TRUST_PROXY was never configured.
 */
function isHttps(req) {
  if (req.secure) return true;
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  return proto === "https";
}

function sessionCookie(req, token, maxAgeSec) {
  // Secure only over HTTPS — a Secure cookie would silently break plain-HTTP
  // localhost development.
  const secure = isHttps(req) ? "; Secure" : "";
  // Expires alongside Max-Age so older browsers also drop a cleared cookie.
  const expires =
    maxAgeSec === 0 ? "; Expires=Thu, 01 Jan 1970 00:00:00 GMT" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${expires}${secure}`;
}

/** Admin responses must never be cached — a cached shell survives logout. */
function noStore(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function loginPage(error) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin login</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  form{background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.08);width:320px}
  h1{font-size:1.1rem;margin:0 0 16px;color:#111827}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;margin-bottom:12px}
  button{width:100%;padding:10px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  .err{color:#b91c1c;font-size:13px;margin:0 0 12px}
</style></head><body>
<form method="post" action="/admin/login">
  <h1>Admin dashboard</h1>
  ${error ? '<p class="err">Wrong password.</p>' : ""}
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
</form>
</body></html>`;
}

export const adminRouter = express.Router();

// Everything below 503s cleanly when the dashboard isn't configured.
adminRouter.use("/admin", (req, res, next) => {
  if (!config.adminPassword) {
    return res
      .status(503)
      .send("Admin dashboard is not configured — set ADMIN_PASSWORD in the environment.");
  }
  if (!config.multiTenant) {
    return res
      .status(503)
      .send("Admin dashboard requires multi-tenant mode (DATABASE_URL).");
  }
  return next();
});

adminRouter.get("/admin/login", (req, res) => {
  noStore(res);
  if (isAuthed(req)) return res.redirect("/admin");
  res.type("html").send(loginPage("error" in req.query));
});

adminRouter.post(
  "/admin/login",
  express.urlencoded({ extended: false, limit: "10kb" }),
  (req, res) => {
    if (!passwordMatches(req.body?.password)) {
      return res.redirect("/admin/login?error");
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_TTL_MS / 1000));
    res.redirect("/admin");
  }
);

adminRouter.get("/admin/logout", (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  // Delete the server-side session first: even if the browser ignored the
  // cookie clear, the token is dead and no longer grants access.
  if (token) sessions.delete(token);
  noStore(res);
  res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
  res.redirect("/admin/login");
});

// Auth gate for the dashboard page and all API routes. Registered AFTER the
// login/logout handlers (so those stay reachable) and BEFORE every route below,
// which is what actually protects them.
adminRouter.use("/admin", (req, res, next) => {
  noStore(res);
  if (isAuthed(req)) return next();
  if (req.path.startsWith("/api")) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  return res.redirect("/admin/login");
});

// The dashboard page lives OUTSIDE public/ so the static middleware can never
// serve it without passing through the auth gate above.
//
// The isAuthed() re-check is deliberate belt-and-braces: this route serves the
// dashboard, and it must not become reachable if the middleware above is ever
// reordered or its path prefix edited.
adminRouter.get("/admin", (req, res) => {
  if (!isAuthed(req)) return res.redirect("/admin/login");
  noStore(res);
  res.sendFile(path.join(import.meta.dirname, "..", "views", "admin.html"));
});

adminRouter.get("/admin/api/overview", async (_req, res) => {
  try {
    const [metrics, clients] = await Promise.all([
      overviewMetrics({ days: 14 }),
      listClientsWithCounts(),
    ]);
    res.json({
      ...metrics,
      clients: {
        total: clients.length,
        live: clients.filter((c) => c.mode === "live").length,
        demo: clients.filter((c) => c.mode === "demo").length,
      },
    });
  } catch (error) {
    console.error("[admin] overview failed:", error.message);
    res.status(500).json({ error: "Failed to load metrics." });
  }
});

adminRouter.get("/admin/api/clients", async (_req, res) => {
  try {
    res.json({ clients: await listClientsWithCounts() });
  } catch (error) {
    console.error("[admin] clients failed:", error.message);
    res.status(500).json({ error: "Failed to load clients." });
  }
});

adminRouter.get("/admin/api/clients/:clientId", async (req, res) => {
  try {
    const [metrics, discount] = await Promise.all([
      overviewMetrics({ clientId: req.params.clientId, days: 14 }),
      getClientDiscountInfo(req.params.clientId),
    ]);
    res.json({
      ...metrics,
      discountCode: discount?.discount_code ?? null,
      discountCodeStatus: discount?.discount_code_status ?? null,
      discountCodeCheckedAt: discount?.discount_code_checked_at ?? null,
    });
  } catch (error) {
    console.error("[admin] client detail failed:", error.message);
    res.status(500).json({ error: "Failed to load client metrics." });
  }
});
