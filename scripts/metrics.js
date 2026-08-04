#!/usr/bin/env node
/**
 * Internal usage/health summary from the events table.
 *
 *   npm run metrics                          totals across all clients, last 7 days
 *   npm run metrics -- --client-id cl_xxx    one client
 *   npm run metrics -- --days 14             different window
 *
 * "Day" means a calendar day in America/Toronto — bucketing uses Postgres's
 * timezone conversion (DST-correct), never a fixed UTC offset. Storage stays UTC.
 *
 * Query logic lives in src/metrics.js, shared with the admin dashboard API.
 */
import { getPool } from "../src/db.js";
import { overviewMetrics, REPORT_TZ } from "../src/metrics.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const clientId = arg("client-id");
const days = Math.max(1, Number(arg("days")) || 7);

const m = await overviewMetrics({ clientId, days });
await getPool().end();

const scope = clientId ? `client ${clientId}` : "all clients";
console.log(`\nMetrics — ${scope} (days are ${REPORT_TZ} calendar days)\n`);
console.log(`Conversations, all time: ${m.totalConversations}`);

console.log(`\nConversations per day (last ${days}):`);
for (const { day, n } of m.perDay) {
  console.log(`  ${day}  ${String(n).padStart(4)}  ${"█".repeat(Math.min(n, 60))}`);
}

console.log("\nTool usage:");
const toolEntries = Object.entries(m.tools);
if (!toolEntries.length) console.log("  (no tool calls recorded)");
for (const [tool, n] of toolEntries) console.log(`  ${tool.padEnd(20)} ${n}`);

const pct = (v) => (v == null ? "n/a" : `${v}%`);
console.log(
  `\nGrounding (as % of ${m.groundingDenominatorLabel} — high rates signal a prompt or data problem):`
);
console.log(`  retries:   ${m.groundingRetriesInWindow} (${pct(m.retryRatePct)})   [all-time: ${m.groundingRetries}]`);
console.log(`  fallbacks: ${m.groundingFallbacksInWindow} (${pct(m.fallbackRatePct)})   [all-time: ${m.groundingFallbacks}]`);

console.log("\nAbuse / security signals:");
console.log(`  rate-limit hits:              ${m.rateLimited}`);
console.log(`  order verification failures:  ${m.verificationFailed}`);
console.log();
