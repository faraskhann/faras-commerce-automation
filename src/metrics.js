import { getPool } from "./db.js";

/**
 * Shared metrics queries — the single source of truth for both the CLI
 * (scripts/metrics.js) and the admin dashboard API.
 *
 * All "day" bucketing converts created_at (stored UTC) to REPORT_TZ calendar
 * days using Postgres's timezone conversion, which tracks DST correctly.
 */

export const REPORT_TZ = "America/Toronto";

/**
 * The last `n` calendar days ending at `todayStr` (YYYY-MM-DD), oldest first.
 * Pure calendar arithmetic on date parts — DST transitions can't skip a day.
 */
export function previousDays(todayStr, n) {
  const [y, m, d] = todayStr.split("-").map(Number);
  const out = [];
  for (let k = n - 1; k >= 0; k -= 1) {
    const dt = new Date(Date.UTC(y, m - 1, d - k));
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Usage/health summary, optionally scoped to one client.
 *
 * Returns:
 *   totalConversations, conversationsToday, conversationsThisWeek,
 *   perDay: [{ day, n }] (zero-filled, oldest first, `days` entries),
 *   tools: { toolName: count }, toolCalls,
 *   groundingRetries, groundingFallbacks, retryRatePct, fallbackRatePct,
 *   rateLimited, verificationFailed, today
 */
export async function overviewMetrics({ clientId = null, days = 14 } = {}) {
  const pool = getPool();
  const clientFilter = clientId ? "and client_id = $1" : "";
  const params = clientId ? [clientId] : [];
  const p = (offset) => `$${params.length + offset}`;

  const [totals, perDayRes, tools, counts, todayRes] = await Promise.all([
    pool.query(
      `select count(*)::int as n from events where event_type = 'conversation_started' ${clientFilter}`,
      params
    ),
    pool.query(
      `select to_char((created_at at time zone ${p(1)})::date, 'YYYY-MM-DD') as day,
              count(*)::int as n
       from events
       where event_type = 'conversation_started' ${clientFilter}
         and (created_at at time zone ${p(1)})::date
             >= (now() at time zone ${p(1)})::date - (${p(2)}::int - 1)
       group by 1 order by 1`,
      [...params, REPORT_TZ, days]
    ),
    pool.query(
      `select metadata->>'tool' as tool, count(*)::int as n
       from events where event_type = 'tool_call' ${clientFilter}
       group by 1 order by 2 desc`,
      params
    ),
    pool.query(
      `select event_type, count(*)::int as n
       from events
       where event_type in ('tool_call', 'reply_generated', 'grounding_retry', 'grounding_fallback', 'rate_limited', 'order_verification_failed')
         ${clientFilter}
       group by 1`,
      params
    ),
    pool.query(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as today`, [
      REPORT_TZ,
    ]),
  ]);

  const count = (type) => counts.rows.find((r) => r.event_type === type)?.n ?? 0;
  const today = todayRes.rows[0].today;

  const byDay = new Map(perDayRes.rows.map((r) => [r.day, r.n]));
  const perDay = previousDays(today, days).map((day) => ({ day, n: byDay.get(day) ?? 0 }));

  const toolCalls = count("tool_call");
  const replies = count("reply_generated");

  // Retries are per drafted reply, NOT per tool call: one turn can retry twice,
  // and a turn that called no tool can still retry. Dividing by tool calls once
  // produced a nonsensical 116% "rate", so replies are the denominator.
  //
  // reply_generated was added after some events already existed, so the rate is
  // measured only from the first reply onwards — otherwise historic retries
  // divide by a denominator that was never recorded for them. Absolute
  // all-time counts are still reported alongside.
  const sinceRes = await pool.query(
    `select min(created_at) as since from events
     where event_type = 'reply_generated' ${clientFilter}`,
    params
  );
  const since = sinceRes.rows[0].since;

  const windowed = since
    ? await pool.query(
        `select event_type, count(*)::int as n from events
         where event_type in ('grounding_retry','grounding_fallback')
           and created_at >= ${p(1)} ${clientFilter}
         group by 1`,
        [...params, since]
      )
    : { rows: [] };
  const windowedCount = (type) => windowed.rows.find((r) => r.event_type === type)?.n ?? 0;

  const retries = count("grounding_retry");
  const fallbacks = count("grounding_fallback");
  const denominator = replies || toolCalls;
  const rateNumerator = since
    ? { retries: windowedCount("grounding_retry"), fallbacks: windowedCount("grounding_fallback") }
    : { retries, fallbacks };
  const pct = (n) => (denominator ? Number(((n / denominator) * 100).toFixed(1)) : null);

  return {
    today,
    totalConversations: totals.rows[0].n,
    conversationsToday: perDay[perDay.length - 1]?.n ?? 0,
    conversationsThisWeek: perDay.slice(-7).reduce((sum, d) => sum + d.n, 0),
    perDay,
    tools: Object.fromEntries(tools.rows.map((r) => [r.tool ?? "unknown", r.n])),
    toolCalls,
    replies,
    // What the retry/fallback percentages are measured against.
    groundingDenominator: denominator,
    groundingDenominatorLabel: replies ? "replies" : "tool calls",
    groundingRetries: retries,
    groundingFallbacks: fallbacks,
    // Numerators used for the percentages (window-matched to the denominator).
    groundingRetriesInWindow: rateNumerator.retries,
    groundingFallbacksInWindow: rateNumerator.fallbacks,
    retryRatePct: pct(rateNumerator.retries),
    fallbackRatePct: pct(rateNumerator.fallbacks),
    rateLimited: count("rate_limited"),
    verificationFailed: count("order_verification_failed"),
  };
}

/** Every client row plus its own all-time conversation count. */
export async function listClientsWithCounts() {
  const result = await getPool().query(
    `select c.client_id, c.store_domain, c.mode, c.tier, c.created_at,
            coalesce(e.n, 0)::int as conversations
     from clients c
     left join (
       select client_id, count(*)::int as n
       from events where event_type = 'conversation_started'
       group by 1
     ) e using (client_id)
     order by c.created_at`
  );
  return result.rows;
}
