#!/usr/bin/env node
/**
 * Set (or clear) a client's stage-3 abandoned-cart discount code, and validate
 * it against that client's own Shopify store immediately so a typo surfaces now
 * rather than in a customer's inbox.
 *
 *   npm run set-discount-code -- --client-id cl_xxx --code COMEBACK10
 *   npm run set-discount-code -- --client-id cl_xxx --clear
 */
import { getPool, getClientById, recordDiscountValidation } from "../src/db.js";
import { validateDiscountCode } from "../src/abandoned-cart.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const clientId = arg("client-id");
const clear = process.argv.includes("--clear");
const code = clear ? null : arg("code");

if (!clientId || (!code && !clear)) {
  console.error(
    "Usage: npm run set-discount-code -- --client-id <id> --code <CODE>\n" +
      "       npm run set-discount-code -- --client-id <id> --clear"
  );
  process.exit(1);
}

const pool = getPool();
const existing = await pool.query(
  "select client_id, store_domain, discount_code from clients where client_id = $1",
  [clientId]
);
if (!existing.rows[0]) {
  console.error(`No client with client_id ${clientId}.`);
  process.exit(1);
}

await pool.query("update clients set discount_code = $2, discount_code_status = null, discount_code_checked_at = null where client_id = $1", [
  clientId,
  code,
]);

console.log(`${clientId} (${existing.rows[0].store_domain})`);
console.log(`  discount code: ${existing.rows[0].discount_code ?? "(none)"}  ->  ${code ?? "(none)"}`);

if (code) {
  const store = await getClientById(clientId);
  const status = await validateDiscountCode(store, code);
  await recordDiscountValidation(clientId, status);
  if (status === "valid") {
    console.log("  validation:    valid — active in Shopify and usable now");
  } else {
    console.log(`  validation:    NOT USABLE (${status})`);
    console.log(
      "  Stage-3 emails will go out without a discount until this is fixed.\n" +
        (status === "no_read_discounts_scope"
          ? "  Grant this client's Shopify app the read_discounts scope, then re-run."
          : "  Check the code exists, is active, in-window and not fully used.")
    );
  }
}

await pool.end();
