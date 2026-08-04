/**
 * Simple in-memory sliding-window rate limiter for /chat.
 *
 * Keyed by client IP and by sessionId independently — the IP cap slows a single
 * machine cycling sessionIds, the session cap slows one session being hammered
 * through a proxy pool. Per-process only; use Redis when running more than one
 * instance.
 */

import { logEvent } from "./events.js";

const WINDOW_MS = 60_000;

const buckets = new Map();

function hit(key, max, now) {
  let timestamps = buckets.get(key);
  if (!timestamps) {
    timestamps = [];
    buckets.set(key, timestamps);
  }

  const cutoff = now - WINDOW_MS;
  while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();

  if (timestamps.length >= max) return false;
  timestamps.push(now);
  return true;
}

// Drop idle buckets so the map doesn't grow with every IP that ever connected.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, timestamps] of buckets) {
    if (!timestamps.length || timestamps[timestamps.length - 1] <= cutoff) {
      buckets.delete(key);
    }
  }
}, WINDOW_MS).unref();

/**
 * Express middleware. Reads the per-minute caps lazily so config stays the
 * single source of truth.
 */
export function rateLimit({ perIpPerMinute, perSessionPerMinute }) {
  return (req, res, next) => {
    const now = Date.now();
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : null;

    const ipOk = hit(`ip:${req.ip}`, perIpPerMinute, now);
    const sessionOk = sessionId
      ? hit(`session:${sessionId}`, perSessionPerMinute, now)
      : true;

    if (!ipOk || !sessionOk) {
      // Runs before client resolution, so the client_id is the (unverified)
      // one claimed in the body — good enough for an internal abuse metric.
      const claimedClient =
        typeof req.body?.client_id === "string" ? req.body.client_id : "__unknown";
      logEvent(claimedClient, "rate_limited", {
        limited_by: !ipOk ? "ip" : "session",
      });
      return res
        .status(429)
        .json({ error: "Too many requests — please wait a moment and try again." });
    }
    return next();
  };
}
