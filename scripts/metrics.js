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
 */
import { getPool } from "../src/db.js";

const REPORT_TZ = "America/Toronto";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const clientId = arg("client-id");
const days = Math.max(1, Number(arg("days")) || 7);

const clientFilter = clientId ? "and client_id = $1" : "";
const params = clientId ? [clientId] : [];

const pool = getPool();

// Calendar-day arithmetic on a date string — no timestamps involved, so DST
// transitions can't skip or duplicate a day.
function previousDays(todayStr, n) {
  const [y, m, d] = todayStr.split("-").map(Number);
  const out = [];
  for (let k = n - 1; k >= 0; k -= 1) {
    const dt = new Date(Date.UTC(y, m - 1, d - k));
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

const totals = await pool.query(
  `select count(*)::int as n from events where event_type = 'conversation_started' ${clientFilter}`,
  params
);

const perDay = await pool.query(
  `select to_char((created_at at time zone $${params.length + 1})::date, 'YYYY-MM-DD') as day,
          count(*)::int as n
   from events
   where event_type = 'conversation_started' ${clientFilter}
     and (created_at at time zone $${params.length + 1})::date
         >= (now() at time zone $${params.length + 1})::date - ($${params.length + 2}::int - 1)
   group by 1 order by 1`,
  [...params, REPORT_TZ, days]
);

const tools = await pool.query(
  `select metadata->>'tool' as tool, count(*)::int as n
   from events where event_type = 'tool_call' ${clientFilter}
   group by 1 order by 2 desc`,
  params
);

const counts = await pool.query(
  `select event_type, count(*)::int as n
   from events
   where event_type in ('tool_call', 'grounding_retry', 'grounding_fallback', 'rate_limited', 'order_verification_failed')
     ${clientFilter}
   group by 1`,
  params
);
const count = (type) => counts.rows.find((r) => r.event_type === type)?.n ?? 0;

const todayRes = await pool.query(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as today`, [REPORT_TZ]);
const today = todayRes.rows[0].today;

await pool.end();

const scope = clientId ? `client ${clientId}` : "all clients";
console.log(`\nMetrics — ${scope} (days are ${REPORT_TZ} calendar days)\n`);
console.log(`Conversations, all time: ${totals.rows[0].n}`);

console.log(`\nConversations per day (last ${days}):`);
const byDay = new Map(perDay.rows.map((r) => [r.day, r.n]));
for (const day of previousDays(today, days)) {
  const n = byDay.get(day) ?? 0;
  console.log(`  ${day}  ${String(n).padStart(4)}  ${"█".repeat(Math.min(n, 60))}`);
}

console.log("\nTool usage:");
if (!tools.rows.length) console.log("  (no tool calls recorded)");
for (const row of tools.rows) console.log(`  ${String(row.tool).padEnd(20)} ${row.n}`);

const toolCalls = count("tool_call");
const retries = count("grounding_retry");
const fallbacks = count("grounding_fallback");
const pct = (n) => (toolCalls ? ((n / toolCalls) * 100).toFixed(1) + "%" : "n/a");
console.log("\nGrounding (as % of tool calls — high rates signal a prompt or data problem):");
console.log(`  retries:   ${retries} (${pct(retries)})`);
console.log(`  fallbacks: ${fallbacks} (${pct(fallbacks)})`);

console.log("\nAbuse / security signals:");
console.log(`  rate-limit hits:              ${count("rate_limited")}`);
console.log(`  order verification failures:  ${count("order_verification_failed")}`);
console.log();
