import Anthropic from "@anthropic-ai/sdk";

import { config } from "./config.js";
import { getOrderStatus, searchProducts, ShopifyError } from "./shopify.js";
import { collectGrounding, verifyReplyGrounding } from "./grounding.js";
import { getHistory, setHistory } from "./sessions.js";
import { logEvent } from "./events.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT = `You are a customer support assistant for an online store. You have
two tools, and they answer different kinds of questions.

Use get_order_status when the customer asks about an order they have already placed —
"where is my order", "has it shipped", "when will it arrive", "what did I buy",
anything about tracking, delivery or a specific order number.

Order identity verification — mandatory:
- The tool needs BOTH the order number AND the email address the order was placed
  with. If either is missing from the conversation, ask for what's missing before
  calling the tool. Never call it with a guessed, remembered or made-up email, and
  never fill one in from an example.
- If the tool returns verified: false, tell the customer you couldn't verify the
  order and ask them to double-check the order number and the email together. Do NOT
  hint at which of the two was wrong, do not confirm or deny that the order number
  exists, and do not reveal any order detail.
- Never repeat back an email address other than the one the customer themselves
  typed in this conversation.
- If the tool result says order_tracking_connected: false (the store is in demo/
  preview mode), briefly and naturally explain that order tracking switches on once
  the store connects its account — one sentence, no apology, no technical detail —
  then offer to help find products instead. Do not ask for an order number or email
  first in that case, and never guess at any order information.

Use search_products when the customer is shopping — "do you have", "I'm looking for",
"show me", "what do you sell", or any description of a product they want, however
vague ("something warm for hiking"). Pass their description through as the query; you
do not need them to name an exact product. Never call get_order_status for these.

Gift and occasion messages are product searches too — "a gift for someone who
snowboards", "something for a skier", "a present for my brother". Pass the shopper's
whole phrase to search_products; it widens the search itself when the literal words
are thin. Do not refuse these or send the shopper to the website.

If a message does both ("where's my order, and do you have it in blue?"), call both
tools and cover both in one reply.

Asking one clarifying question:
- After showing what you found, you may ask ONE short follow-up — either a budget
  range or the recipient's experience level. Pick whichever the results make more
  useful; never ask both.
- Ask it only when the search results warrant it: the tool returned result_count
  below 2, or wide_price_range: true (the matches span very different prices).
- Do not ask when the shopper has already been specific ("do you have ski wax",
  "I want the Complete Snowboard") — just answer them.
- Always show the results first. Never reply with only a question, and never ask a
  question when you found nothing at all — say you don't carry it instead.

Grounding — these override everything else:
- Every product name you write must appear verbatim in a tool result from THIS turn —
  the current customer message, not an earlier one. Before recommending or naming any
  product, call search_products in this turn, even if you searched earlier in the
  conversation; earlier results may be stale. Never recall, guess or adapt a product
  name from anything else you know. If you have not run a search in this turn, you do
  not know what the store sells.
- An automated check compares your reply against this turn's tool results, and a
  reply naming anything a tool did not return is rejected and never reaches the
  customer. Answers that only use tool data pass every time.
- Never say a colour, size, material or any other variant exists unless it appears in
  that product's variants or options in the tool result. "Probably", "should be" and
  "check the product page" are not acceptable substitutes for looking.
- When the shopper names an attribute, pass it in the attributes argument. If it comes
  back available: false, say plainly that the store does not have it, then list what
  it does have from available_options. Never offer a similar-sounding name in its
  place, and never invent a variant to fill the gap.
- If a product's options list is empty, it has no colour or size choices at all. Say
  that rather than implying choices exist somewhere else.
- Search results carry no brand or attribute data beyond the title, type, tags and
  options. If the shopper asks for a brand ("anything by Burton?") or a quality
  ("waterproof?"), only affirm it when that word actually appears in the product's
  title, type or tags. When it doesn't, say the results don't show it: "I can't see
  brand information for these — here's what matched your search" — never convert
  matching on other words into a yes.
- Prices, stock and options come from the tool result only. When in doubt, search
  again rather than answering from memory.

Rules:
- Never invent an order detail or a product. Every fact must come from a tool result.
- If search_products returns result_count of 1 or more, those products ARE in the
  store's catalogue and you must present them. Never tell the shopper the store
  doesn't carry something when the tool returned matches, and never describe results
  as unavailable unless in_stock is false for that specific product. Lead with the
  in-stock matches; mention up to three.
- If get_order_status reports the order was not found, say so plainly and ask the
  customer to double-check the number or the email the confirmation was sent to.
- If search_products comes back empty, tell the shopper you don't carry anything
  matching and offer to search for something else. Do not suggest products that were
  not in the results, and do not describe a result as something it isn't.
- When you have product results, write them as a short natural-language list — two or
  three options, each with the name, price and one line on why it fits — not a raw
  data dump. Include the product link. Mention when something is out of stock.
- If a tool reports an error, apologize, say the lookup failed, and suggest trying
  again shortly. Do not speculate.
- Keep replies short, friendly, and specific. Mention tracking numbers and carriers
  when an order has them.`;

const TOOLS = [
  {
    name: "get_order_status",
    description:
      "Look up an order the customer has ALREADY PLACED. Use for questions about " +
      "shipping, tracking, delivery dates, or what an existing order contained. " +
      "Requires BOTH the order number AND the email address the order was placed " +
      "with — the email is verified against the order before any data is returned. " +
      "Returns verified: false when the pair doesn't check out, with no detail about " +
      "which part was wrong. Do not use this to look up products for sale.",
    input_schema: {
      type: "object",
      properties: {
        order_number: {
          type: "string",
          description:
            'The customer\'s order number, with or without a leading "#" (e.g. "1001" or "#1001").',
        },
        email: {
          type: "string",
          description:
            "The email address the customer says the order was placed with, exactly " +
            "as they typed it. Required — never guess or invent one.",
        },
      },
      required: ["order_number", "email"],
    },
  },
  {
    name: "search_products",
    description:
      "Search the store's catalogue for products a shopper might want to BUY. Use for " +
      '"do you have…", "I\'m looking for…", "show me…", gift and occasion requests, or ' +
      "any description of a desired product, however vague. Matches against product " +
      "titles, product types and tags, widening the search automatically when the " +
      "shopper's literal words are too thin. Returns up to 5 products with title, " +
      "price, a description excerpt and a storefront link, plus result_count and " +
      "wide_price_range, which tell you whether a clarifying question is worth asking. " +
      "Returns an empty products list when nothing matches — say so rather than " +
      "suggesting something else. Do not use this for existing orders.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The shopper's description of what they want, in their own words " +
            '(e.g. "something warm for hiking", "blue running shoes"). Pass the ' +
            "description through as-is; do not reduce it to a single word.",
        },
        attributes: {
          type: "array",
          items: { type: "string" },
          description:
            "Any specific colour, size, material or other variant attribute the " +
            'shopper named, one per entry (e.g. ["blue"], ["large", "wool"]). Always ' +
            "fill this in when they name one — each entry is checked against real " +
            "variant data and comes back with available true or false, which is the " +
            "only reliable way to know whether that attribute exists. Omit when they " +
            "named none.",
        },
      },
      required: ["query"],
    },
  },
];

// name -> { args, run }. `args` are required string inputs, validated before
// dispatch; `run` receives the resolved store explicitly plus the input object —
// tools never read store config from shared state.
const TOOL_HANDLERS = {
  get_order_status: {
    args: ["order_number", "email"],
    run: (store, input) => getOrderStatus(store, input.order_number, input.email),
  },
  search_products: {
    args: ["query"],
    run: (store, input) => searchProducts(store, input.query, input.attributes),
  },
};

/**
 * Run one tool call and return the content for its tool_result block.
 * Tool failures come back as `is_error` results rather than thrown errors so
 * Claude can tell the customer what happened instead of the request 500ing.
 */
async function runTool(store, toolUse) {
  const handler = TOOL_HANDLERS[toolUse.name];
  if (!handler) {
    return { content: `Unknown tool: ${toolUse.name}`, isError: true };
  }

  for (const arg of handler.args) {
    const value = toolUse.input?.[arg];
    if (typeof value !== "string" || !value.trim()) {
      return {
        content: `${arg} is required and must be a non-empty string.`,
        isError: true,
      };
    }
  }

  logEvent(store.clientKey, "tool_call", { tool: toolUse.name });

  try {
    const result = await handler.run(store, toolUse.input);
    return { content: JSON.stringify(result), isError: false, payload: result };
  } catch (error) {
    const detail =
      error instanceof ShopifyError
        ? error.message
        : "Unexpected error while contacting the store.";
    // Message and status only — error.details can carry response fragments with
    // customer data, and shopify.js has already logged a redacted copy.
    console.error(
      `[${toolUse.name}] failed: ${error.message}` +
        (error instanceof ShopifyError && error.status ? ` (HTTP ${error.status})` : "")
    );
    return {
      content: JSON.stringify({ error: true, message: detail }),
      isError: true,
    };
  }
}

function extractText(content) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

const MAX_GROUNDING_RETRIES = 2;

const GROUNDING_FALLBACK_REPLY =
  "Sorry — I wasn't able to put together a reliable answer just now. Could you ask " +
  "that again in a moment?";

function groundingCorrective(violations) {
  return (
    "[Automated grounding check — the customer did NOT see your last message.] It " +
    `mentioned things that no tool returned in this turn: ${violations.join(", ")}. ` +
    "Write a new reply using only data from this turn's tool results. If you need " +
    "product data, call search_products now. If the tools returned nothing relevant " +
    "or failed, say so plainly instead of naming products."
  );
}

/**
 * Send one customer message and return Claude's final text reply.
 *
 * Handles the full tool-use loop: if Claude responds with tool_use blocks, the
 * tools are executed, results are sent back, and the loop continues until Claude
 * produces a plain text answer.
 *
 * Every drafted reply is then checked against this turn's tool results
 * (src/grounding.js). A draft naming products the tools did not return is rejected
 * and retried with a corrective note; if retries run out, a safe fallback goes to
 * the customer instead. Rejected drafts never enter the saved history.
 */
export async function handleMessage({ store, sessionId, message }) {
  // Sessions are namespaced by client so the same sessionId arriving from two
  // different clients can never share (or leak) conversation history.
  const sessionKey = `${store.clientKey}::${sessionId}`;
  const history = getHistory(sessionKey);

  // First message of a session = one conversation. (Sessions live in memory, so
  // a conversation resuming across a server restart counts again — acceptable
  // noise for an internal metric.)
  if (history.length === 0) {
    logEvent(store.clientKey, "conversation_started");
  }

  const messages = [...history, { role: "user", content: message }];

  // Parsed payloads of every successful tool call in THIS turn — the only data a
  // reply is allowed to reference.
  const turnPayloads = [];
  const rejectedMessages = new Set();
  let groundingRetries = 0;

  for (let round = 0; round <= config.maxToolRounds; round += 1) {
    const response = await client.messages.create({
      model: config.model,
      // Support replies are short by design; this is a deliberate cap, not a default.
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const text =
        extractText(response.content) ||
        "Sorry, I wasn't able to put together a reply. Could you rephrase that?";

      const grounding = collectGrounding(turnPayloads);
      const violations = verifyReplyGrounding(text, grounding);

      if (violations.length && groundingRetries < MAX_GROUNDING_RETRIES) {
        groundingRetries += 1;
        logEvent(store.clientKey, "grounding_retry", { violations: violations.length });
        console.warn(
          `[grounding] rejected draft for session ${sessionId} ` +
            `(attempt ${groundingRetries}): ${violations.join("; ")}`
        );
        const draft = messages[messages.length - 1];
        const corrective = { role: "user", content: groundingCorrective(violations) };
        messages.push(corrective);
        rejectedMessages.add(draft).add(corrective);
        continue;
      }

      if (violations.length) {
        logEvent(store.clientKey, "grounding_fallback", { violations: violations.length });
        console.error(
          `[grounding] retries exhausted for session ${sessionId}; ` +
            `sending fallback. Violations: ${violations.join("; ")}`
        );
        rejectedMessages.add(messages[messages.length - 1]);
        const saved = messages.filter((m) => !rejectedMessages.has(m));
        saved.push({ role: "assistant", content: GROUNDING_FALLBACK_REPLY });
        setHistory(sessionKey, saved);
        logEvent(store.clientKey, "reply_generated");
        return { reply: GROUNDING_FALLBACK_REPLY, stopReason: "grounding_failure" };
      }

      // Clean reply — save history without any rejected draft/corrective pairs.
      setHistory(sessionKey, messages.filter((m) => !rejectedMessages.has(m)));
      logEvent(store.clientKey, "reply_generated");
      return { reply: text, stopReason: response.stop_reason };
    }

    const toolUses = response.content.filter((block) => block.type === "tool_use");

    // Run the calls in this turn, then return every result in one user message.
    const results = await Promise.all(toolUses.map((toolUse) => runTool(store, toolUse)));
    for (const result of results) {
      if (!result.isError && result.payload) turnPayloads.push(result.payload);
    }
    messages.push({
      role: "user",
      content: toolUses.map((toolUse, i) => ({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: results[i].content,
        is_error: results[i].isError,
      })),
    });
  }

  // Claude kept asking for tools past the cap — bail out rather than loop forever.
  const bailReply =
    "Sorry, I'm having trouble looking that up right now. Could you try again in a moment?";
  // Close the turn with assistant text so the saved history never ends on a
  // tool_result — the next user message would otherwise break role alternation.
  const saved = messages.filter((m) => !rejectedMessages.has(m));
  saved.push({ role: "assistant", content: bailReply });
  setHistory(sessionKey, saved);
  logEvent(store.clientKey, "reply_generated");
  console.warn(`[agent] session ${sessionId} hit the tool-round limit`);
  return { reply: bailReply, stopReason: "tool_round_limit" };
}
