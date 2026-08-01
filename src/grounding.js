/**
 * Structural grounding check: verifies that product-like mentions in a drafted
 * reply actually appeared in this turn's tool results. The system prompt asks the
 * model not to invent; this is the layer that doesn't take its word for it.
 *
 * Turn-scoped by design — a reply may only reference what a tool returned in the
 * same handleMessage call, so "recommending from memory" of an earlier turn also
 * fails and forces a fresh search.
 */

// Words that appear in product-shaped phrases without implying a product claim
// ("Payment Pending", "Out of Stock", "In Stock and Ready to Ship").
const GENERIC_WORDS = new Set([
  "all", "and", "any", "are", "available", "availability", "back", "browse",
  "but", "buy", "carry", "check", "choice", "choices", "colors", "colours",
  "currently", "delivered", "delivery", "details", "for", "free", "from", "get",
  "have", "here", "its", "item", "items", "just", "link", "moment", "more",
  "not", "now", "options", "order", "orders", "our", "out", "package", "page",
  "paid", "parcel", "carrier", "track", "verify", "verified", "email",
  "payment", "pending", "premium", "price", "priced", "product", "products",
  "ready", "results", "sale", "ship", "shipped", "shipping", "shop", "sorry",
  "status", "stock", "store", "support", "team", "thanks", "that", "the",
  "these", "this", "total", "tracking", "try", "unavailable", "unfulfilled",
  "usd", "view", "was", "website", "what", "with", "would", "yes", "you", "your",
]);

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function significantWords(candidate) {
  return normalize(candidate)
    .split(" ")
    .filter((word) => word.length >= 3 && /[a-z]/.test(word) && !GENERIC_WORDS.has(word));
}

/**
 * Build the grounding record for one turn from the parsed payloads of every
 * successful tool call in that turn.
 */
export function collectGrounding(payloads) {
  const names = new Set();
  const handles = new Set();
  let haystack = "";

  const addName = (value) => {
    if (typeof value === "string" && value.trim()) names.add(normalize(value));
  };

  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") continue;
    haystack += JSON.stringify(payload).toLowerCase();

    for (const product of payload.products ?? []) {
      addName(product.title);
      const handleMatch = String(product.url ?? "").match(/\/products\/([a-z0-9-]+)/);
      if (handleMatch) handles.add(handleMatch[1]);
      for (const variant of product.variants ?? []) {
        addName(variant.title);
        for (const value of Object.values(variant.options ?? {})) addName(value);
      }
      for (const option of product.options ?? []) {
        addName(option.name);
        for (const value of option.values ?? []) addName(value);
      }
    }

    // Order lookups ground line items, tracking and addresses the same way.
    if (payload.found) {
      addName(payload.order_number);
      for (const item of payload.line_items ?? []) {
        addName(item.title);
        addName(item.variant);
      }
      for (const fulfillment of payload.fulfillments ?? []) {
        for (const tracking of fulfillment.tracking ?? []) {
          addName(tracking.carrier);
          addName(tracking.number);
        }
      }
      if (payload.shipping_address) {
        addName(payload.shipping_address.name);
        addName(payload.shipping_address.city);
      }
    }
  }

  return { names, handles, haystack, toolCount: payloads.length };
}

function nameMatches(candidate, names) {
  const normalized = normalize(candidate);
  if (!normalized) return true;
  for (const name of names) {
    if (name.includes(normalized) || normalized.includes(name)) return true;
  }
  return false;
}

function candidatePasses(candidate, grounding) {
  const words = significantWords(candidate);
  if (!words.length) return true; // prices, "Out of Stock", pure punctuation
  if (nameMatches(candidate, grounding.names)) return true;
  // Every meaningful word individually present in raw tool data also counts —
  // covers rephrasings like "the Powder colourway" for variant "Powder".
  return words.every((word) => grounding.haystack.includes(word));
}

/**
 * Product-like mentions in a reply: bold spans, markdown link labels, URLs, and
 * Title Case phrases of two or more words (catches unformatted product names).
 */
function extractCandidates(reply) {
  const text = String(reply);
  const candidates = [];

  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    candidates.push({ kind: "bold", value: match[1] });
  }
  for (const match of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    candidates.push({ kind: "link-label", value: match[1] });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    candidates.push({ kind: "url", value: match[0].replace(/[.,;:!?]+$/, "") });
  }
  for (const match of text.matchAll(
    /\b(?:The\s+)?[A-Z][a-z0-9'-]+(?:\s+(?:of|and|for)\s+|\s+)(?:[A-Z][a-z0-9'-]+)(?:\s+[A-Z][a-z0-9'-]+)*/g
  )) {
    candidates.push({ kind: "title-case", value: match[0] });
  }

  return candidates;
}

/**
 * Returns a list of ungrounded mentions (empty when the reply is clean).
 * Every returned entry is a claim in the reply with no basis in this turn's
 * tool results.
 */
export function verifyReplyGrounding(reply, grounding) {
  const violations = [];

  for (const candidate of extractCandidates(reply)) {
    if (candidate.kind === "url") {
      const handleMatch = candidate.value.match(/\/products\/([a-z0-9-]+)/);
      if (handleMatch) {
        if (!grounding.handles.has(handleMatch[1])) {
          violations.push(`link to unknown product "${handleMatch[1]}"`);
        }
      } else if (!grounding.haystack.includes(candidate.value.toLowerCase())) {
        violations.push(`link "${candidate.value}" not present in any tool result`);
      }
      continue;
    }

    if (!candidatePasses(candidate.value, grounding)) {
      violations.push(`"${candidate.value.trim()}"`);
    }
  }

  return [...new Set(violations)];
}
