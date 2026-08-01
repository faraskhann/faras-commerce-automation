#!/usr/bin/env node
/**
 * Create 2-3 test orders in a Shopify dev store so there is real data to test
 * get_order_status against.
 *
 * Each order is created as a draft order and then completed with
 * paymentPending: true, which produces a real order with a "Payment pending"
 * financial status. One order is also fulfilled with a fake tracking number so
 * you can exercise the shipping/tracking path.
 *
 * Run:  npm run seed:orders
 *
 * Requires SHOPIFY_ADMIN_TOKEN to have write_draft_orders, write_orders and
 * write_merchant_managed_fulfillment_orders scopes (read_orders alone is not enough).
 *
 * For a test order that goes through a real *payment* flow, use the Bogus Gateway
 * from the storefront instead — see the README section "Bogus Gateway checkout".
 */

import { shopifyGraphQL, ShopifyError } from "../src/shopify.js";
import { config } from "../src/config.js";

const CURRENCY = (process.env.SHOPIFY_CURRENCY || "USD").toUpperCase();

const TEST_ORDERS = [
  {
    label: "shipped order with tracking",
    email: "ada.tester@example.com",
    fulfill: {
      company: "Other",
      number: "TESTTRACK0001",
      url: "https://example.com/track/TESTTRACK0001",
    },
    shippingAddress: {
      firstName: "Ada",
      lastName: "Tester",
      address1: "123 Test Street",
      city: "Austin",
      provinceCode: "TX",
      countryCode: "US",
      zip: "78701",
    },
    lineItems: [{ title: "Test Widget — Blue", quantity: 1, price: "24.00" }],
  },
  {
    label: "paid-pending order, not yet fulfilled",
    email: "grace.tester@example.com",
    fulfill: null,
    shippingAddress: {
      firstName: "Grace",
      lastName: "Tester",
      address1: "456 Sample Ave",
      city: "Portland",
      provinceCode: "OR",
      countryCode: "US",
      zip: "97201",
    },
    lineItems: [{ title: "Test Gadget — Small", quantity: 2, price: "15.50" }],
  },
  {
    label: "multi-item order, not yet fulfilled",
    email: "alan.tester@example.com",
    fulfill: null,
    shippingAddress: {
      firstName: "Alan",
      lastName: "Tester",
      address1: "789 Example Rd",
      city: "Seattle",
      provinceCode: "WA",
      countryCode: "US",
      zip: "98101",
    },
    lineItems: [
      { title: "Test Widget — Red", quantity: 1, price: "24.00" },
      { title: "Test Accessory Pack", quantity: 3, price: "8.25" },
      { title: "Gift Wrap", quantity: 1, price: "3.00" },
    ],
  },
];

const DRAFT_ORDER_CREATE = /* GraphQL */ `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DRAFT_ORDER_COMPLETE = /* GraphQL */ `
  mutation DraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id, paymentPending: true) {
      draftOrder {
        id
        order {
          id
          name
          displayFinancialStatus
          displayFulfillmentStatus
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FULFILLMENT_ORDERS = /* GraphQL */ `
  query FulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 10) {
        edges {
          node {
            id
            status
          }
        }
      }
    }
  }
`;

function assertNoUserErrors(step, payload) {
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    const detail = errors.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join("; ");
    throw new Error(`${step} failed — ${detail}`);
  }
}

async function createOrder(spec) {
  const created = await shopifyGraphQL(DRAFT_ORDER_CREATE, {
    input: {
      email: spec.email,
      shippingAddress: spec.shippingAddress,
      lineItems: spec.lineItems.map((item) => ({
        title: item.title,
        quantity: item.quantity,
        originalUnitPriceWithCurrency: { amount: item.price, currencyCode: CURRENCY },
        requiresShipping: true,
      })),
    },
  });
  assertNoUserErrors("draftOrderCreate", created.draftOrderCreate);

  const draftId = created.draftOrderCreate.draftOrder.id;

  const completed = await shopifyGraphQL(DRAFT_ORDER_COMPLETE, { id: draftId });
  assertNoUserErrors("draftOrderComplete", completed.draftOrderComplete);

  return completed.draftOrderComplete.draftOrder.order;
}

async function fulfillOrder(orderId, tracking) {
  const data = await shopifyGraphQL(FULFILLMENT_ORDERS, { id: orderId });
  const fulfillmentOrders = (data?.order?.fulfillmentOrders?.edges ?? [])
    .map(({ node }) => node)
    .filter((node) => node.status === "OPEN" || node.status === "IN_PROGRESS");

  if (!fulfillmentOrders.length) {
    throw new Error("no open fulfillment orders (is the store's location set up?)");
  }

  // Inlined rather than passed as a typed variable: the input type for this
  // mutation has been renamed across API versions, the field shape has not.
  const mutation = /* GraphQL */ `
    mutation {
      fulfillmentCreate(fulfillment: {
        notifyCustomer: false
        lineItemsByFulfillmentOrder: [
          ${fulfillmentOrders.map((fo) => `{ fulfillmentOrderId: "${fo.id}" }`).join("\n          ")}
        ]
        trackingInfo: {
          company: ${JSON.stringify(tracking.company)}
          number: ${JSON.stringify(tracking.number)}
          url: ${JSON.stringify(tracking.url)}
        }
      }) {
        fulfillment {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyGraphQL(mutation);
  assertNoUserErrors("fulfillmentCreate", result.fulfillmentCreate);
  return result.fulfillmentCreate.fulfillment;
}

async function main() {
  console.log(`Store:    ${config.shopify.domain}`);
  console.log(`API:      ${config.shopify.apiVersion}`);
  console.log(`Currency: ${CURRENCY} (override with SHOPIFY_CURRENCY)\n`);

  const created = [];

  for (const spec of TEST_ORDERS) {
    try {
      const order = await createOrder(spec);
      let fulfillmentNote = "unfulfilled";

      if (spec.fulfill) {
        try {
          await fulfillOrder(order.id, spec.fulfill);
          fulfillmentNote = `fulfilled, tracking ${spec.fulfill.number}`;
        } catch (error) {
          fulfillmentNote = `fulfillment skipped — ${error.message}`;
        }
      }

      created.push(order.name);
      console.log(`✓ ${order.name}  (${spec.label}) — ${fulfillmentNote}`);
    } catch (error) {
      const detail = error instanceof ShopifyError ? `${error.message}` : error.message;
      console.error(`✗ ${spec.label} — ${detail}`);
    }
  }

  if (!created.length) {
    console.error("\nNo orders were created. Check your token's scopes and store domain.");
    process.exitCode = 1;
    return;
  }

  console.log(`\nCreated ${created.length} order(s): ${created.join(", ")}`);
  console.log("Try one against the chatbot:\n");
  console.log(
    `  curl -X POST http://localhost:${config.port}/chat ` +
      `-H "Content-Type: application/json" ` +
      `-d '{"message":"Where is my order ${created[0]}?","sessionId":"test-1"}'`
  );
}

main().catch((error) => {
  console.error(error instanceof ShopifyError ? `Shopify error: ${error.message}` : error);
  process.exitCode = 1;
});
