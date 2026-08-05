import { config } from "./config.js";

/**
 * Email delivery via Postmark.
 *
 * Chosen over SendGrid for two reasons that matter here: Postmark separates
 * traffic into explicit message streams, so cart-recovery mail (promotional)
 * rides a Broadcast stream and cannot damage the sending reputation of any
 * transactional mail added later; and its send API is a single JSON POST, so
 * no SDK dependency is needed. Deliverability on small volumes is also
 * consistently better in practice than SendGrid's shared pools.
 *
 * Set POSTMARK_SERVER_TOKEN, EMAIL_FROM and POSTMARK_MESSAGE_STREAM
 * (a Broadcast stream) to enable sending. Without them, sends are skipped and
 * logged rather than failing — a missing key must never crash the poller.
 */
export function emailConfigured() {
  return Boolean(config.email.postmarkToken && config.email.from);
}

export async function sendEmail({ to, subject, html, text }) {
  if (!emailConfigured()) {
    return { sent: false, reason: "email_not_configured" };
  }

  let response;
  try {
    response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Postmark-Server-Token": config.email.postmarkToken,
      },
      body: JSON.stringify({
        From: config.email.from,
        To: to,
        Subject: subject,
        HtmlBody: html,
        TextBody: text,
        MessageStream: config.email.messageStream,
      }),
    });
  } catch (cause) {
    return { sent: false, reason: `network_error: ${cause.message}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Never log the recipient address — that is customer PII.
    return { sent: false, reason: `postmark_http_${response.status}`, detail: body.slice(0, 300) };
  }

  return { sent: true };
}
