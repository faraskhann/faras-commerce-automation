#!/usr/bin/env node
/**
 * Register a DEMO client from a prospect's public catalogue — no Shopify
 * credentials needed. Scrapes {domain}/products.json (public product feed),
 * normalizes it into the same shape search_products returns internally, and
 * stores the snapshot in the client row's demo_catalog.
 *
 *   node scripts/add-demo-client.js --domain prospect-store.com \
 *     [--origin https://prospect-store.com,...]   (default: https://<domain>)
 *     [--client-id <id>]                          (default: generated)
 *
 * Order lookups stay honestly disabled for demo clients until
 * `npm run upgrade-client` flips them to live.
 */
import crypto from "node:crypto";

import { getPool } from "../src/db.js";

const PAGE_LIMIT = 250;
const MAX_PRODUCTS = 500;
const PAGE_DELAY_MS = 400;
const EXCERPT_LENGTH = 180;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const domain = (arg("domain") || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
if (!domain) {
  console.error("Usage: node scripts/add-demo-client.js --domain <store-domain> [--origin ...] [--client-id ...]");
  process.exit(1);
}
const origin = (arg("origin") || `https://${domain}`)
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean)
  .join(",");
const clientId = arg("client-id") || `cl_${crypto.randomBytes(8).toString("hex")}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(text) {
  if (!text) return null;
  if (text.length <= EXCERPT_LENGTH) return text;
  const cut = text.slice(0, EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : cut.length)}…`;
}

/** Normalize one /products.json product into search_products' internal shape. */
function normalizeProduct(p) {
  const optionNames = (p.options ?? []).map((o) => o.name);

  const variants = (p.variants ?? []).map((v) => {
    const options = {};
    optionNames.forEach((name, i) => {
      const value = v[`option${i + 1}`];
      if (value && !(name === "Title" && value === "Default Title")) options[name] = value;
    });
    return {
      title: v.title,
      sku: v.sku || null,
      price: v.price,
      options,
      in_stock: typeof v.available === "boolean" ? v.available : null,
      inventory: null,
    };
  });

  const amounts = variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n));
  const min = amounts.length ? Math.min(...amounts) : null;
  const max = amounts.length ? Math.max(...amounts) : null;

  return {
    title: p.title,
    price:
      min == null ? null : min === max ? min.toFixed(2) : `${min.toFixed(2)}–${max.toFixed(2)}`,
    description: excerpt(stripHtml(p.body_html)),
    product_type: p.product_type || null,
    tags: Array.isArray(p.tags)
      ? p.tags
      : String(p.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    url: `https://${domain}/products/${p.handle}`,
    in_stock: variants.some((v) => v.in_stock) ? true : variants.length ? null : null,
    options: (p.options ?? [])
      .filter((o) => !(o.name === "Title" && (o.values ?? []).length === 1))
      .map((o) => ({ name: o.name, values: o.values ?? [] })),
    variants,
    _amount: min ?? NaN,
    _currency: null,
  };
}

async function fetchPage(page) {
  let url = `https://${domain}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
  let response;

  // Redirects handled manually: a password-protected storefront redirects
  // /products.json to /password (in a loop, with auto-follow), which is the
  // clearest signal that store isn't publicly reachable.
  for (let hop = 0; ; hop += 1) {
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "store-chatbot-demo-import/1.0" },
        redirect: "manual",
      });
    } catch (cause) {
      const detail = cause.cause?.message ?? cause.message;
      throw new Error(
        `Network error reaching ${domain}: ${detail}. Check the domain and your connection.`
      );
    }

    if (![301, 302, 307, 308].includes(response.status)) break;

    const location = response.headers.get("location") ?? "";
    if (location.includes("/password")) {
      throw new Error(
        `${domain} redirects to its password page — the storefront is password-protected ` +
          "(Shopify dev stores are, by default). Demo mode needs a live public store."
      );
    }
    if (hop >= 5) {
      throw new Error(`${domain} redirected more than 5 times without serving /products.json.`);
    }
    url = new URL(location, url).href;
  }

  if (response.status === 404) {
    throw new Error(
      `${domain} returned 404 for /products.json — either the domain is wrong or the ` +
        "store has disabled its public product feed."
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${domain} refused the request (HTTP ${response.status}) — the storefront appears ` +
        "to be password-protected. Demo mode needs a publicly reachable storefront."
    );
  }
  if (!response.ok) {
    throw new Error(`${domain} answered HTTP ${response.status} for /products.json.`);
  }

  const text = await response.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error(
      `${domain} served an HTML page instead of JSON — this usually means the storefront ` +
        "is password-protected (Shopify dev stores are, by default) or the domain is not " +
        "a Shopify storefront. Demo mode needs a live public store."
    );
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${domain} returned unparseable JSON from /products.json.`);
  }
  if (!Array.isArray(body.products)) {
    throw new Error(`${domain}'s /products.json response has no products array.`);
  }
  return body.products;
}

async function main() {
  console.log(
    `scraping https://${domain}/products.json (max ${MAX_PRODUCTS} products, ${PAGE_DELAY_MS}ms between pages)…`
  );

  const catalogue = [];
  try {
    for (let page = 1; catalogue.length < MAX_PRODUCTS; page += 1) {
      const products = await fetchPage(page);
      if (!products.length) break;
      for (const p of products) {
        if (catalogue.length >= MAX_PRODUCTS) break;
        catalogue.push(normalizeProduct(p));
      }
      console.log(`  page ${page}: ${products.length} products (total ${catalogue.length})`);
      if (products.length < PAGE_LIMIT) break;
      await sleep(PAGE_DELAY_MS);
    }
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (!catalogue.length) {
    console.error(`No products found at ${domain} — not creating a demo client.`);
    process.exitCode = 1;
    return;
  }

  const pool = getPool();
  await pool.query(
    `insert into clients (client_id, store_domain, allowed_origin, mode, demo_catalog)
     values ($1, $2, $3, 'demo', $4)`,
    [clientId, domain, origin, JSON.stringify(catalogue)]
  );
  await pool.end();

  console.log(`\nDEMO client registered: ${clientId} -> ${domain}`);
  console.log(`catalogue snapshot:     ${catalogue.length} products`);
  console.log(`allowed origins:        ${origin}`);
  console.log("\nOrder tracking stays off until `npm run upgrade-client` — the bot says so honestly.");
  console.log("\nWidget snippet for the prospect's site:\n");
  console.log(`  <script`);
  console.log(`    src="https://YOUR-BACKEND-HOST/widget.js"`);
  console.log(`    data-api-url="https://YOUR-BACKEND-HOST"`);
  console.log(`    data-client-id="${clientId}"`);
  console.log(`  ></script>`);
}

await main();
