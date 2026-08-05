import crypto from "node:crypto";

import { config } from "./config.js";
import { getPool, listClientsWithFeature } from "./db.js";
import { shopifyGraphQL } from "./shopify.js";
import { sendEmail, emailConfigured } from "./email.js";
import { logEvent } from "./events.js";

/**
 * Tier-gated abandoned cart recovery.
 *
 * The gate is the first thing that happens: only clients whose tier grants
 * `abandonedCart` are ever polled, so a regular-tier client is never queried
 * and never emailed — even if its Shopify app has read_checkouts granted.
 * Tier is re-read from the database on every poll, so an upgrade takes effect
 * on the next cycle without a restart or redeploy.
 */

const ABANDONED_CHECKOUTS_QUERY = /* GraphQL */ `
  query AbandonedCheckouts($first: Int!) {
    abandonedCheckouts(first: $first) {
      edges {
        node {
          id
          name
          createdAt
          abandonedCheckoutUrl
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            email
            firstName
          }
          lineItems(first: 25) {
            edges {
              node {
                title
                quantity
                variantTitle
              }
            }
          }
        }
      }
    }
  }
`;

// Shopify's AbandonedCheckout type exposes no cart token, so a recovered cart
// cannot be matched to its order by token. Recovery is instead detected by an
// order from the same email placed after the cart was detected.
const RECOVERY_ORDER_QUERY = /* GraphQL */ `
  query RecoveryOrder($search: String!) {
    orders(first: 1, query: $search) {
      edges {
        node {
          id
          name
          processedAt
        }
      }
    }
  }
`;

const STAGES = [
  { stage: 1, afterHours: 1, subject: (s) => `You left something behind at ${s}` },
  { stage: 2, afterHours: 24, subject: (s) => `Still thinking it over? Your ${s} cart is saved` },
  { stage: 3, afterHours: 72, subject: (s) => `Last chance — your ${s} cart expires soon` },
];

/* ------------------------------------------------------------- unsubscribe */

export function unsubscribeToken(clientId, email) {
  const secret = config.abandonedCart.unsubscribeSecret;
  if (!secret) return null;
  return crypto
    .createHmac("sha256", secret)
    .update(`${clientId}:${String(email).toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

export function unsubscribeUrl(clientId, email) {
  const token = unsubscribeToken(clientId, email);
  const base = config.publicBaseUrl;
  if (!token || !base) return null;
  const params = new URLSearchParams({ c: clientId, e: email, t: token });
  return `${base}/unsubscribe?${params.toString()}`;
}

/** Flags every cart for this email+client as unsubscribed. Returns rows changed. */
export async function unsubscribeEmail(clientId, email) {
  const result = await getPool().query(
    "update abandoned_checkouts set unsubscribed = true where client_id = $1 and lower(customer_email) = lower($2)",
    [clientId, email]
  );
  return result.rowCount;
}

/* ----------------------------------------------------------------- content */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderEmail({ store, row, stage }) {
  const snapshot = row.cart_snapshot ?? {};
  const items = snapshot.line_items ?? [];
  const firstName = snapshot.first_name;
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi there,";
  const unsub = unsubscribeUrl(row.client_id, row.customer_email);
  const discount = stage === 3 ? config.abandonedCart.discountCode : null;

  const itemLines = items
    .map((i) => `${i.quantity} × ${i.title}${i.variant ? ` (${i.variant})` : ""}`)
    .join("\n");

  const itemHtml = items
    .map(
      (i) =>
        `<li>${escapeHtml(i.quantity)} × ${escapeHtml(i.title)}` +
        `${i.variant ? ` <span style="color:#6b7280">(${escapeHtml(i.variant)})</span>` : ""}</li>`
    )
    .join("");

  const discountHtml = discount
    ? `<p style="background:#fef3c7;border-radius:8px;padding:12px 14px">
         Use code <strong>${escapeHtml(discount)}</strong> at checkout.</p>`
    : "";
  const discountText = discount ? `\nUse code ${discount} at checkout.\n` : "";

  // CASL/CAN-SPAM: identify the sender and give a working one-click opt-out.
  const footerHtml =
    `<hr style="border:0;border-top:1px solid #e5e7eb;margin:26px 0">
     <p style="color:#6b7280;font-size:12px;line-height:1.5">
       This message was sent by ${escapeHtml(store.domain)} because a cart was left
       at their online store.<br>
       ${unsub ? `<a href="${escapeHtml(unsub)}">Unsubscribe from cart reminders</a>` : "To stop receiving these, reply STOP."}
     </p>`;
  const footerText =
    `\n---\nThis message was sent by ${store.domain} because a cart was left at their online store.\n` +
    (unsub ? `Unsubscribe: ${unsub}\n` : "To stop receiving these, reply STOP.\n");

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111827">
      <p>${greeting}</p>
      <p>You left these items in your cart at ${escapeHtml(store.domain)}:</p>
      <ul>${itemHtml}</ul>
      ${snapshot.total ? `<p><strong>Total: ${escapeHtml(snapshot.total)}</strong></p>` : ""}
      ${discountHtml}
      <p><a href="${escapeHtml(row.recovery_url)}"
            style="display:inline-block;background:#2563eb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">
         Complete your order</a></p>
      ${footerHtml}
    </div>`;

  const text = `${firstName ? `Hi ${firstName},` : "Hi there,"}

You left these items in your cart at ${store.domain}:

${itemLines}
${snapshot.total ? `\nTotal: ${snapshot.total}\n` : ""}${discountText}
Complete your order: ${row.recovery_url}
${footerText}`;

  return { html, text };
}

/* -------------------------------------------------------------------- poll */

function mapCheckout(node) {
  return {
    shopifyId: node.id,
    email: node.customer?.email ?? null,
    recoveryUrl: node.abandonedCheckoutUrl ?? null,
    snapshot: {
      first_name: node.customer?.firstName ?? null,
      total: node.totalPriceSet?.shopMoney
        ? `${node.totalPriceSet.shopMoney.amount} ${node.totalPriceSet.shopMoney.currencyCode}`
        : null,
      line_items: (node.lineItems?.edges ?? []).map(({ node: li }) => ({
        title: li.title,
        quantity: li.quantity,
        variant: li.variantTitle ?? null,
      })),
    },
  };
}

/** Insert newly-detected checkouts for one premium client. */
async function ingestCheckouts(store) {
  const data = await shopifyGraphQL(store, ABANDONED_CHECKOUTS_QUERY, { first: 50 });
  const nodes = (data?.abandonedCheckouts?.edges ?? []).map(({ node }) => node);
  const pool = getPool();
  let inserted = 0;

  for (const node of nodes) {
    const c = mapCheckout(node);
    // No email address means no way to contact them — skip entirely.
    if (!c.email || !c.recoveryUrl) continue;

    // Never resurrect a cart this customer has already opted out of.
    const optedOut = await pool.query(
      "select 1 from abandoned_checkouts where client_id = $1 and lower(customer_email) = lower($2) and unsubscribed = true limit 1",
      [store.clientKey, c.email]
    );
    if (optedOut.rows.length) continue;

    const res = await pool.query(
      `insert into abandoned_checkouts
         (client_id, shopify_checkout_id, customer_email, recovery_url, cart_snapshot)
       values ($1, $2, $3, $4, $5)
       on conflict (client_id, shopify_checkout_id) do nothing`,
      [store.clientKey, c.shopifyId, c.email, c.recoveryUrl, JSON.stringify(c.snapshot)]
    );
    if (res.rowCount > 0) {
      inserted += 1;
      logEvent(store.clientKey, "abandoned_checkout_detected");
    }
  }
  return { seen: nodes.length, inserted };
}

/** Mark carts recovered when an order from the same email arrives afterwards. */
async function markRecovered(store) {
  const pool = getPool();
  const open = await pool.query(
    `select id, customer_email, detected_at from abandoned_checkouts
     where client_id = $1 and recovered_at is null and customer_email is not null`,
    [store.clientKey]
  );

  let recovered = 0;
  for (const row of open.rows) {
    const since = new Date(row.detected_at).toISOString();
    const safeEmail = String(row.customer_email).replace(/["'\\]/g, "");
    const data = await shopifyGraphQL(store, RECOVERY_ORDER_QUERY, {
      search: `email:"${safeEmail}" AND created_at:>='${since}'`,
    });
    const order = data?.orders?.edges?.[0]?.node;
    if (order) {
      await pool.query(
        "update abandoned_checkouts set recovered_at = $2 where id = $1",
        [row.id, order.processedAt ?? new Date().toISOString()]
      );
      recovered += 1;
    }
  }
  return recovered;
}

/** Send whichever stage each open cart is now due for. */
async function sendDueEmails(store) {
  const pool = getPool();
  const due = await pool.query(
    `select * from abandoned_checkouts
     where client_id = $1
       and recovered_at is null
       and unsubscribed = false
       and customer_email is not null
       and emails_sent < 3
       and (
         (emails_sent = 0 and detected_at <= now() - interval '1 hour')  or
         (emails_sent = 1 and detected_at <= now() - interval '24 hours') or
         (emails_sent = 2 and detected_at <= now() - interval '72 hours')
       )`,
    [store.clientKey]
  );

  let sent = 0;
  for (const row of due.rows) {
    const stageDef = STAGES[row.emails_sent];
    if (!stageDef) continue;

    const { html, text } = renderEmail({ store, row, stage: stageDef.stage });
    const result = await sendEmail({
      to: row.customer_email,
      subject: stageDef.subject(store.domain),
      html,
      text,
    });

    if (!result.sent) {
      console.error(
        `[abandoned-cart:${store.clientKey}] stage ${stageDef.stage} send skipped/failed: ${result.reason}`
      );
      continue;
    }

    await pool.query(
      "update abandoned_checkouts set emails_sent = emails_sent + 1, last_email_sent_at = now() where id = $1",
      [row.id]
    );
    logEvent(store.clientKey, "abandoned_cart_email_sent", { stage: stageDef.stage });
    sent += 1;
  }
  return sent;
}

/**
 * One full cycle across every client whose tier grants the feature.
 * Exported so tests and manual runs can trigger it directly.
 */
export async function runAbandonedCartCycle() {
  const stores = await listClientsWithFeature("abandonedCart");
  const summary = [];

  for (const store of stores) {
    // Demo clients have no Shopify credentials at all.
    if (store.mode !== "live") continue;
    try {
      const { seen, inserted } = await ingestCheckouts(store);
      const recovered = await markRecovered(store);
      const sent = await sendDueEmails(store);
      summary.push({ client: store.clientKey, seen, inserted, recovered, sent });
    } catch (error) {
      console.error(`[abandoned-cart:${store.clientKey}] cycle failed: ${error.message}`);
      summary.push({ client: store.clientKey, error: error.message });
    }
  }
  return summary;
}

/** Start the recurring poller. Returns a stop function. */
export function startAbandonedCartPoller() {
  if (!config.multiTenant) return () => {};

  const everyMs = Math.max(5, config.abandonedCart.pollMinutes) * 60 * 1000;
  console.log(
    `Carts: abandoned-cart poller every ${config.abandonedCart.pollMinutes}m ` +
      `(premium tier only; email ${emailConfigured() ? "configured" : "NOT configured — sends will be skipped"})`
  );

  const tick = () => {
    runAbandonedCartCycle()
      .then((summary) => {
        const active = summary.filter((s) => s.inserted || s.sent || s.recovered || s.error);
        if (active.length) console.log("[abandoned-cart] cycle:", JSON.stringify(active));
      })
      .catch((error) => console.error("[abandoned-cart] cycle error:", error.message));
  };

  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
