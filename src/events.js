import { config } from "./config.js";
import { getPool } from "./db.js";

/**
 * Fire-and-forget internal event logging. Metrics must never break or slow the
 * actual chat path: the insert is not awaited, and every failure is swallowed
 * into a console line.
 *
 * No-ops in dev single-store mode (no database configured).
 */
export function logEvent(clientKey, eventType, metadata = null) {
  if (!config.multiTenant) return;

  try {
    getPool()
      .query("insert into events (client_id, event_type, metadata) values ($1, $2, $3)", [
        clientKey ?? "__unknown",
        eventType,
        metadata ? JSON.stringify(metadata) : null,
      ])
      .catch((error) => {
        console.error(`[events] failed to record ${eventType}: ${error.message}`);
      });
  } catch (error) {
    console.error(`[events] failed to record ${eventType}: ${error.message}`);
  }
}
