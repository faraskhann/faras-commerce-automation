import { graphqlUrlFor } from "./config.js";
import { logEvent } from "./events.js";
import {
  getAccessToken,
  invalidateAccessToken,
  refreshAccessToken,
  usingClientCredentials,
} from "./token.js";

export class ShopifyError extends Error {
  constructor(message, { status, details } = {}) {
    super(message);
    this.name = "ShopifyError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Run a GraphQL operation against one store's Admin API.
 *
 * `store` is the per-request resolved client (domain + credentials) and is
 * passed explicitly through the whole call chain — nothing here reads a
 * module-level "current store", so concurrent requests for different clients
 * cannot cross.
 *
 * Throws ShopifyError on transport failures, HTTP errors, or GraphQL `errors`.
 * The access token is refreshed proactively near expiry, and once more here if
 * Shopify still answers 401 (clock skew, revocation).
 */
export async function shopifyGraphQL(store, query, variables = {}, { retryOn401 = true } = {}) {
  let token;
  try {
    token = await getAccessToken(store);
  } catch (cause) {
    throw new ShopifyError(`Could not obtain a Shopify access token: ${cause.message}`);
  }

  let response;
  try {
    response = await fetch(graphqlUrlFor(store.domain), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (cause) {
    throw new ShopifyError(`Could not reach Shopify: ${cause.message}`);
  }

  // An expired-anyway token: drop it, mint a fresh one, retry exactly once.
  if (response.status === 401 && retryOn401 && usingClientCredentials(store)) {
    console.warn(
      `[shopify:${store.clientKey}] got 401 — refreshing access token and retrying once`
    );
    invalidateAccessToken(store);
    try {
      await refreshAccessToken(store, "401 from API");
    } catch (cause) {
      throw new ShopifyError(`Could not obtain a Shopify access token: ${cause.message}`);
    }
    return shopifyGraphQL(store, query, variables, { retryOn401: false });
  }

  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new ShopifyError("Shopify returned a non-JSON response.", {
      status: response.status,
      details: raw.slice(0, 500),
    });
  }

  if (!response.ok) {
    logShopifyFailure(response.status, raw, query);
    throw new ShopifyError(
      `Shopify responded with HTTP ${response.status}.`,
      { status: response.status, details: body.errors ?? body }
    );
  }

  if (body.errors?.length) {
    logShopifyFailure(response.status, raw, query);
    throw new ShopifyError(
      body.errors.map((e) => e.message).join("; "),
      { status: response.status, details: body.errors }
    );
  }

  return body.data;
}

// Keys whose values are customer PII and must never reach the logs.
const PII_KEY_RE =
  /email|phone|name|address|city|zip|postal|province|first|last|company|latitude|longitude/i;

/**
 * Deep-copy a parsed response with PII values masked. Key-based masking first,
 * then a regex pass for email addresses that appear in non-obvious places
 * (error messages, search echoes).
 */
function redactPII(value, keyHint = "") {
  if (Array.isArray(value)) return value.map((item) => redactPII(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redactPII(inner, key);
    return out;
  }
  if (typeof value === "string") {
    if (PII_KEY_RE.test(keyHint)) return "[REDACTED]";
    return value.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[REDACTED_EMAIL]");
  }
  return PII_KEY_RE.test(keyHint) ? "[REDACTED]" : value;
}

// Server-console diagnostics for failed GraphQL calls: real status and response
// structure, with customer PII redacted — log the error, not the person.
function logShopifyFailure(status, rawBody, query) {
  const operation = String(query).trim().slice(0, 80).replace(/\s+/g, " ");
  let body;
  try {
    body = JSON.stringify(redactPII(JSON.parse(rawBody)));
  } catch {
    // Not JSON — redact emails and digit runs (phone numbers, zips) wholesale.
    body = String(rawBody)
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[REDACTED_EMAIL]")
      .replace(/\d{5,}/g, "[REDACTED_DIGITS]");
  }
  console.error(
    `[shopify] GraphQL call failed (HTTP ${status})\n` +
      `  operation: ${operation}…\n` +
      `  response:  ${body.slice(0, 2000)}`
  );
}

const ORDER_BY_NAME_QUERY = /* GraphQL */ `
  query OrderByName($search: String!) {
    orders(first: 1, query: $search) {
      edges {
        node {
          id
          name
          email
          processedAt
          cancelledAt
          displayFulfillmentStatus
          displayFinancialStatus
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          shippingAddress {
            name
            city
            provinceCode
            zip
            countryCodeV2
          }
          lineItems(first: 50) {
            edges {
              node {
                title
                variantTitle
                sku
                quantity
              }
            }
          }
          fulfillments(first: 10) {
            status
            createdAt
            estimatedDeliveryAt
            trackingInfo {
              company
              number
              url
            }
          }
        }
      }
    }
  }
`;

// Shopify's search syntax is quote-delimited; strip characters that would break out of it.
function stripQuotes(value) {
  return String(value).trim().replace(/["'\\]/g, "");
}

async function findOrderByName(store, name) {
  const data = await shopifyGraphQL(store, ORDER_BY_NAME_QUERY, {
    search: `name:"${name}"`,
  });
  return data?.orders?.edges?.[0]?.node ?? null;
}

// One indistinguishable result for every verification failure — wrong number,
// wrong email, order with no email on file. Distinct reasons would let an
// attacker with a stolen order number confirm it exists, then enumerate emails.
function verificationFailure() {
  return {
    verified: false,
    message:
      "Could not verify that order. Ask the customer to double-check both the " +
      "order number and the email address the order was placed with.",
  };
}

/**
 * Look up a single order's fulfillment status, shipping info, and line items —
 * only when the supplied email matches the email on the order.
 *
 * Returns a plain object that is safe to hand back to Claude as a tool result.
 * Every failure (no such order, wrong email, no email on file) returns the same
 * generic `{ verified: false }` shape — never throws for "not found", and never
 * reveals which part of the check failed.
 */
export async function getOrderStatus(store, orderNumberInput, emailInput) {
  // Demo clients run on a scraped public catalogue — order data was never
  // public, so there is nothing to look up. Structured refusal, not an error,
  // so Claude explains it truthfully instead of apologizing for a failure.
  if (store.mode === "demo") {
    return {
      demo_mode: true,
      order_tracking_connected: false,
      message:
        "This store's order tracking is not connected yet — it activates once the " +
        "store connects its Shopify account. Product questions can still be answered.",
    };
  }

  const cleaned = stripQuotes(orderNumberInput);
  const email = String(emailInput ?? "").trim().toLowerCase();

  if (!cleaned || !email) {
    return verificationFailure();
  }

  // Shopify stores order names with the store's prefix, usually "#1001".
  // Try the input as given and with a leading "#" so both "1001" and "#1001" work.
  const candidates = cleaned.startsWith("#")
    ? [cleaned, cleaned.slice(1)]
    : [`#${cleaned}`, cleaned];

  let order = null;
  for (const candidate of candidates) {
    order = await findOrderByName(store, candidate);
    if (order) break;
  }

  const orderEmail = String(order?.email ?? "").trim().toLowerCase();
  if (!order || !orderEmail || orderEmail !== email) {
    // A real attempt (both inputs present) that failed to verify — security-
    // relevant, worth counting. The metadata stays PII-free by design.
    logEvent(store.clientKey, "order_verification_failed", {
      order_found: Boolean(order),
    });
    return verificationFailure();
  }

  const fulfillments = (order.fulfillments ?? []).map((f) => ({
    status: f.status,
    created_at: f.createdAt,
    estimated_delivery_at: f.estimatedDeliveryAt,
    tracking: (f.trackingInfo ?? []).map((t) => ({
      carrier: t.company,
      number: t.number,
      url: t.url,
    })),
  }));

  return {
    verified: true,
    found: true,
    order_number: order.name,
    placed_at: order.processedAt,
    cancelled_at: order.cancelledAt,
    fulfillment_status: order.displayFulfillmentStatus,
    financial_status: order.displayFinancialStatus,
    total: order.totalPriceSet?.shopMoney
      ? `${order.totalPriceSet.shopMoney.amount} ${order.totalPriceSet.shopMoney.currencyCode}`
      : null,
    shipping_address: order.shippingAddress
      ? {
          name: order.shippingAddress.name,
          city: order.shippingAddress.city,
          province: order.shippingAddress.provinceCode,
          postal_code: order.shippingAddress.zip,
          country: order.shippingAddress.countryCodeV2,
        }
      : null,
    line_items: (order.lineItems?.edges ?? []).map(({ node }) => ({
      title: node.title,
      variant: node.variantTitle,
      sku: node.sku,
      quantity: node.quantity,
    })),
    fulfillments,
  };
}

const PRODUCT_SEARCH_QUERY = /* GraphQL */ `
  query SearchProducts($search: String!, $first: Int!) {
    products(first: $first, query: $search) {
      edges {
        node {
          title
          handle
          description
          productType
          tags
          onlineStoreUrl
          publishedAt
          totalInventory
          priceRangeV2 {
            minVariantPrice {
              amount
              currencyCode
            }
            maxVariantPrice {
              amount
              currencyCode
            }
          }
          options {
            name
            values
          }
          variants(first: 25) {
            edges {
              node {
                title
                sku
                price
                availableForSale
                inventoryQuantity
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

const MAX_PRODUCT_RESULTS = 5;
const EXCERPT_LENGTH = 180;
// Below this many hits, retry with broadened keywords before giving up.
const MIN_RESULTS_BEFORE_BROADENING = 2;
// Highest price >= this multiple of the lowest counts as a wide spread.
const WIDE_PRICE_RATIO = 3;

// Words that carry no signal in a product search and only dilute the OR query.
const STOP_WORDS = new Set([
  "a", "an", "and", "any", "anyone", "are", "do", "does", "for", "from", "got",
  "have", "hi", "hello", "i", "im", "is", "it", "looking", "me", "my", "need",
  "of", "on", "or", "please", "show", "some", "somebody", "someone", "something",
  "the", "there", "to", "want", "was", "we", "who", "with", "would", "you", "your",
]);

// Words describing the *recipient* or *occasion* rather than the product. They stay
// in the first pass ("gift" really does match a Gift Card) but are dropped when
// broadening, so the actual product noun isn't competing with them for the 5 slots.
const RECIPIENT_WORDS = new Set([
  "anniversary", "birthday", "boyfriend", "brother", "christmas", "dad", "daughter",
  "family", "father", "friend", "gift", "girlfriend", "graduation", "him", "her",
  "holiday", "husband", "kid", "kids", "mom", "mother", "partner", "present",
  "sister", "son", "teen", "wedding", "wife",
]);

/**
 * Crude suffix stripper. Shopify's `field:term*` is a prefix match, so a shopper's
 * "snowboarding" never matches a product titled "Snowboard" unless the inflection is
 * removed first. Over-stemming is safe here — a shorter prefix only widens the search,
 * and Claude picks the relevant results out of what comes back.
 */
function stem(word) {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function keywordsFrom(query) {
  return [
    ...new Set(
      stripQuotes(query)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
        .map(stem)
    ),
  ].slice(0, 8);
}

/**
 * Reduce a person-noun to the activity or product behind it: "skier" -> "ski",
 * "snowboarder" -> "snowboard", "cyclist" -> "cycl". Returns null when the word
 * isn't shaped like an agent noun, so callers can tell "no change" from a result.
 */
function agentNounRoot(word) {
  if (word.length > 4 && word.endsWith("er")) return word.slice(0, -2);
  if (word.length > 5 && word.endsWith("ist")) return word.slice(0, -3);
  return null;
}

/**
 * Second-pass keywords for when the first search comes back thin.
 * Drops recipient/occasion words and reduces agent nouns to their root, so
 * "gift for a skier" retries as "ski" rather than giving up.
 */
function broadenKeywords(keywords) {
  const broadened = new Set();

  for (const word of keywords) {
    if (RECIPIENT_WORDS.has(word)) continue;
    broadened.add(agentNounRoot(word) ?? word);
  }

  // Everything was a recipient word ("a gift for my brother") — nothing to broaden to.
  return [...broadened];
}

/**
 * Turn a keyword list into a Shopify search string. Each keyword is matched as a
 * prefix against title, product type and tags; keywords are OR'd so "warm hiking
 * jacket" still surfaces a product tagged only "hiking".
 */
function buildProductSearch(keywords) {
  const clauses = keywords.map(
    (word) => `(title:${word}* OR product_type:${word}* OR tag:${word}*)`
  );
  // Only products a shopper can actually see: active AND published to the Online
  // Store channel. Draft, archived, and active-but-hidden products stay invisible.
  return `status:active AND published_status:published AND (${clauses.join(" OR ")})`;
}

function excerpt(description) {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= EXCERPT_LENGTH) return text;
  const cut = text.slice(0, EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : cut.length)}…`;
}

function formatPrice(priceRange) {
  const min = priceRange?.minVariantPrice;
  const max = priceRange?.maxVariantPrice;
  if (!min) return null;
  if (max && max.amount !== min.amount) {
    return `${min.amount}–${max.amount} ${min.currencyCode}`;
  }
  return `${min.amount} ${min.currencyCode}`;
}

// Shopify gives single-variant products a synthetic "Title / Default Title" option.
// It isn't a real choice, so it's stripped rather than shown to a shopper as one.
function isSyntheticOption(name, value) {
  return name === "Title" && value === "Default Title";
}

function mapVariants(node) {
  return (node.variants?.edges ?? []).map(({ node: variant }) => {
    const options = {};
    for (const { name, value } of variant.selectedOptions ?? []) {
      if (!isSyntheticOption(name, value)) options[name] = value;
    }
    return {
      title: variant.title,
      sku: variant.sku || null,
      price: variant.price,
      options,
      in_stock: variant.availableForSale === true,
      inventory: variant.inventoryQuantity ?? null,
    };
  });
}

function mapOptions(node) {
  return (node.options ?? [])
    .filter((option) => !(option.name === "Title" && option.values?.length === 1))
    .map((option) => ({ name: option.name, values: option.values ?? [] }));
}

async function runSingleKeywordSearch(store, keyword) {
  const data = await shopifyGraphQL(store, PRODUCT_SEARCH_QUERY, {
    search: buildProductSearch([keyword]),
    first: MAX_PRODUCT_RESULTS,
  });

  // Belt and braces on top of the published_status search filter: publishedAt is
  // null whenever a product isn't published to the Online Store channel, so any
  // product the search filter lets slip is still dropped here.
  const visible = (data?.products?.edges ?? []).filter(
    ({ node }) => node.publishedAt != null
  );

  return visible.map(({ node }) => ({
    title: node.title,
    price: formatPrice(node.priceRangeV2),
    description: excerpt(node.description),
    product_type: node.productType || null,
    tags: node.tags ?? [],
    // onlineStoreUrl is null until a product is published to the Online Store
    // channel; the handle URL is the address it will have once it is.
    url: node.onlineStoreUrl ?? `https://${store.domain}/products/${node.handle}`,
    in_stock: node.totalInventory === null ? null : node.totalInventory > 0,
    options: mapOptions(node),
    variants: mapVariants(node),
    _amount: Number(node.priceRangeV2?.minVariantPrice?.amount ?? NaN),
    _currency: node.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
  }));
}

/**
 * Demo-mode equivalent of one keyword's Shopify search: word-prefix match
 * against title, product type and tags of the scraped catalogue, mirroring the
 * semantics of Shopify's `field:term*` so demo and live behave alike.
 */
function demoKeywordSearch(store, keyword) {
  const catalogue = Array.isArray(store.demoCatalog) ? store.demoCatalog : [];
  return catalogue
    .filter((product) => {
      const haystack = `${product.title} ${product.product_type ?? ""} ${(product.tags ?? []).join(" ")}`
        .toLowerCase()
        .split(/[^a-z0-9]+/);
      return haystack.some((word) => word.startsWith(keyword));
    })
    .slice(0, MAX_PRODUCT_RESULTS);
}

/**
 * Search once per keyword and merge, ranking products that matched several
 * keywords above single-keyword matches, with round-robin interleaving as the
 * tie-break so every keyword keeps representation in the final 5.
 *
 * A single combined OR query lets one dominant category flood the result cap:
 * "wax my snowboard" filled all 5 slots with snowboards and dropped the one
 * product the shopper actually wanted (the wax).
 *
 * Demo clients search their scraped catalogue in memory; live clients hit the
 * Admin API. Everything downstream (broadening, attribute checks, pricing,
 * grounding) is shared and cannot tell the difference.
 */
async function runProductSearch(store, keywords) {
  const lists = await Promise.all(
    keywords.slice(0, 6).map((keyword) =>
      store.mode === "demo"
        ? demoKeywordSearch(store, keyword)
        : runSingleKeywordSearch(store, keyword)
    )
  );

  const byTitle = new Map();
  for (let position = 0; position < MAX_PRODUCT_RESULTS; position += 1) {
    for (const list of lists) {
      const product = list[position];
      if (!product) continue;
      const existing = byTitle.get(product.title);
      if (existing) {
        existing.score += 1;
      } else {
        byTitle.set(product.title, { product, score: 1, order: byTitle.size });
      }
    }
  }

  return [...byTitle.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.product)
    .slice(0, MAX_PRODUCT_RESULTS);
}

// Fallback attribute detection for when Claude doesn't pass `attributes` explicitly.
// Deliberately small — it exists so an attribute question still gets checked against
// real variant data rather than silently answered from the model's assumptions.
const COLOR_WORDS = new Set([
  "beige", "black", "blue", "bronze", "brown", "cream", "gold", "gray", "green",
  "grey", "ivory", "khaki", "maroon", "navy", "olive", "orange", "pink", "purple",
  "red", "silver", "tan", "teal", "turquoise", "violet", "white", "yellow",
]);

const SIZE_WORDS = new Set([
  "large", "medium", "small", "xl", "xxl", "xs", "extralarge", "oversized", "petite",
]);

function inferAttributes(query) {
  const words = stripQuotes(query).toLowerCase().split(/[^a-z0-9]+/);
  return words.filter((word) => COLOR_WORDS.has(word) || SIZE_WORDS.has(word));
}

function variantMatchesAttribute(variant, attribute) {
  const needle = attribute.toLowerCase();
  if (variant.title?.toLowerCase().includes(needle)) return true;
  return Object.values(variant.options).some((value) =>
    String(value).toLowerCase().includes(needle)
  );
}

/**
 * Check each attribute the shopper asked for against real variant data.
 *
 * The point is to hand Claude an explicit `available: false` rather than leaving it
 * to infer absence from the variant list, which is where colours and sizes get
 * invented. Also collects what the store *does* offer, so the reply can pivot to
 * real options instead of a close-sounding guess.
 */
function checkRequestedAttributes(products, attributes) {
  if (!attributes.length) return {};

  const checks = attributes.map((attribute) => {
    const matches = [];
    for (const product of products) {
      for (const variant of product.variants) {
        if (variantMatchesAttribute(variant, attribute)) {
          matches.push(`${product.title} — ${variant.title}`);
        }
      }
    }
    return {
      requested: attribute,
      available: matches.length > 0,
      matching_variants: matches.slice(0, 5),
    };
  });

  // Everything the matched products actually offer, e.g. { Color: ["Ice", "Dawn"] }.
  const availableOptions = {};
  for (const product of products) {
    for (const option of product.options) {
      availableOptions[option.name] ??= new Set();
      for (const value of option.values) availableOptions[option.name].add(value);
    }
  }

  return {
    requested_attributes: checks,
    all_requested_attributes_available: checks.every((check) => check.available),
    available_options: Object.fromEntries(
      Object.entries(availableOptions).map(([name, values]) => [name, [...values]])
    ),
  };
}

/**
 * Whether the results are spread widely enough in price that a budget question is
 * worth asking. Ratio-based rather than absolute so it works in any currency.
 */
function pricingSummary(products) {
  const amounts = products.map((p) => p._amount).filter((n) => Number.isFinite(n) && n > 0);
  if (amounts.length < 2) return { wide_price_range: false };

  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  return {
    price_low: `${min.toFixed(2)} ${products[0]._currency ?? ""}`.trim(),
    price_high: `${max.toFixed(2)} ${products[0]._currency ?? ""}`.trim(),
    wide_price_range: max >= min * WIDE_PRICE_RATIO,
  };
}

/**
 * Search the store's products from a natural-language description.
 *
 * Runs up to two passes: the shopper's own words first, then — if that comes back
 * with fewer than MIN_RESULTS matches — a broader pass that drops recipient words
 * and reduces agent nouns to their root ("skier" -> "ski"), so occasion and gift
 * phrasing still lands on a real category.
 *
 * Returns `{ products: [] }` when both passes miss — an empty list, not an error,
 * so Claude can say so honestly instead of inventing a product.
 *
 * `requestedAttributes` are colours/sizes the shopper named. Each is checked against
 * real variant data and reported as available true/false, so an attribute that does
 * not exist comes back as an explicit fact rather than something to be inferred.
 */
export async function searchProducts(store, queryInput, requestedAttributes) {
  const keywords = keywordsFrom(queryInput);

  const attributes = [
    ...new Set(
      [
        ...(Array.isArray(requestedAttributes) ? requestedAttributes : []),
        ...inferAttributes(queryInput),
      ]
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim().toLowerCase())
    ),
  ].slice(0, 5);

  if (!keywords.length) {
    return { query: queryInput, products: [], result_count: 0, reason: "no_searchable_terms" };
  }

  let products = await runProductSearch(store, keywords);
  let broadened = false;

  if (products.length < MIN_RESULTS_BEFORE_BROADENING) {
    const broaderKeywords = broadenKeywords(keywords);
    const isDifferent =
      broaderKeywords.length > 0 &&
      broaderKeywords.some((word) => !keywords.includes(word));

    if (isDifferent) {
      broadened = true;
      const seen = new Set(products.map((p) => p.title));
      // First-pass hits stay in front — they matched the shopper's literal words.
      for (const product of await runProductSearch(store, broaderKeywords)) {
        if (!seen.has(product.title)) {
          products.push(product);
          seen.add(product.title);
        }
      }
      products = products.slice(0, MAX_PRODUCT_RESULTS);
    }
  }

  const pricing = pricingSummary(products);
  const attributeChecks = checkRequestedAttributes(products, attributes);

  return {
    query: queryInput,
    result_count: products.length,
    broadened_search: broadened,
    ...pricing,
    ...attributeChecks,
    products: products.map(({ _amount, _currency, ...product }) => product),
    ...(products.length ? {} : { reason: "no_matching_products" }),
  };
}
