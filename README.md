# Shopify Support Chatbot — Backend

An Express backend that connects Claude to a Shopify store's Admin API. Customers ask a
question in plain language; Claude picks a tool, the backend queries Shopify's GraphQL
Admin API, and Claude turns the result into an answer.

Two tools:

- **`get_order_status`** — order, shipping and tracking questions about an order the
  customer has already placed.
- **`search_products`** — catalogue search for shoppers ("do you have…", "I'm looking
  for something warm for hiking").

One endpoint, in-memory sessions, no database and no frontend widget yet.

---

## Setup

### 1. Install dependencies

```powershell
npm install
```

Requires Node 20+ (built and tested on Node 24).

### 2. Create your `.env`

Copy the example and fill it in:

```powershell
Copy-Item .env.example .env
```

| Variable | Where it comes from |
| --- | --- |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |
| `SHOPIFY_STORE_DOMAIN` | Your dev store host, e.g. `my-dev-store.myshopify.com` (no `https://`) |
| `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | Your app's client credentials in the Shopify Dev Dashboard — **the production setup** |
| `SHOPIFY_ADMIN_TOKEN` | Fallback only: a manually minted access token. **Expires ~24h after creation** — fine for a quick test, never for production |
| `PORT` | Optional, defaults to `3000` |

`.env` and `node_modules/` are gitignored.

**Why client credentials:** access tokens obtained through the client credentials
grant expire after about 24 hours (`expires_in` ≈ 86399 in the token response). A
token pasted into `.env` therefore dies silently within a day — which looks like the
bot suddenly answering "the lookup failed" for everything. With the client ID and
secret configured, the backend requests its own token at startup, refreshes it
automatically 5 minutes before expiry, and re-fetches once if Shopify ever answers
401 anyway. Refreshes are logged (`[shopify] access token refreshed…`) without the
secret or token values.

**Getting the credentials:** open your app in the Shopify Dev Dashboard, grant the
scopes below, install it on the store, and copy the **Client ID** and **Client
secret** from the app's settings into `.env`.

Scopes needed:

- `read_orders` — for `get_order_status`.
- `read_products` — for `search_products`.
- `write_draft_orders`, `write_orders`, `write_merchant_managed_fulfillment_orders` —
  only needed to run the test-order script below.

> Reading customer names and shipping addresses on live stores requires Shopify's
> protected customer data approval. Development stores are exempt, so this works
> out of the box on a dev store.

### 3. Run the server

```powershell
npm start      # or: npm run dev  (restarts on file changes)
```

You should see:

```
Listening on http://localhost:3000
Model: claude-haiku-4-5-20251001
Store: my-dev-store.myshopify.com (Admin API 2026-07)
```

---

## Testing the endpoint

### PowerShell

```powershell
$body = @{ message = "Where's my order #1001?"; sessionId = "test-1" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/chat -Method Post -ContentType application/json -Body $body
```

### curl (Git Bash, WSL, macOS, Linux)

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Where'\''s my order #1001? It was placed with ada.tester@example.com","sessionId":"test-1"}'
```

Response:

```json
{
  "sessionId": "test-1",
  "reply": "Order #1001 shipped on July 24 via Other, tracking TESTTRACK0001. It contains 1 × Test Widget — Blue and is on its way to Austin, TX.",
  "stopReason": "end_turn"
}
```

Reuse the same `sessionId` to continue a conversation — Claude remembers the earlier
turns, so a follow-up like `"What was in it again?"` works without repeating the order
number.

### Test cases

The response envelope is always `{ sessionId, reply, stopReason }`; only the wording of
`reply` varies. These four cover both tools and both failure paths.

**1. Product search — `search_products` should fire, not `get_order_status`**

```powershell
$body = @{ message = "Do you have anything warm for snowboarding?"; sessionId = "t-products" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/chat -Method Post -ContentType application/json -Body $body
```

Expect a short natural-language list — two or three products, each with name, price, a
reason it fits, and a link. Not a JSON dump:

```json
{
  "sessionId": "t-products",
  "reply": "We have several snowboards in stock for you! Here are the best options:\n\n- **The Complete Snowboard** – $699.95 USD – A premium board described as awesome for snowboarding. …\n- **The Hidden Snowboard** – $749.95 USD – A premium option tagged for winter sport. …\n\nWould you like more details on any of these?",
  "stopReason": "end_turn"
}
```

**2. Order lookup — verification, then data**

```powershell
$body = @{ message = "Where's my order #1001? It was placed with ada.tester@example.com"; sessionId = "t-orders" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/chat -Method Post -ContentType application/json -Body $body
```

Order lookups require the order number **and** the email the order was placed with,
matched against the order before any data is returned. With the correct pair, expect
the fulfillment status, carrier and tracking number. Ask without an email ("Where's my
order #1001?") and Claude must request it before looking anything up.

**2b. Wrong email — no data, no hints**

```powershell
$body = @{ message = "Where's order #1001? My email is someone.else@example.com"; sessionId = "t-orders-bad" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/chat -Method Post -ContentType application/json -Body $body
```

Expect a generic "I couldn't verify that order — please double-check the order number
and email" with **no order details and no hint about which of the two was wrong**. The
tool returns the same `verified: false` shape whether the order doesn't exist, the
email doesn't match, or the order has no email on file, so a stolen order number can't
be confirmed by probing.

**3. Nothing matches — the honest-answer path**

```powershell
$body = @{ message = "Do you sell purple dinosaur saddles?"; sessionId = "t-empty" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/chat -Method Post -ContentType application/json -Body $body
```

The tool returns `{ products: [] }`, so Claude should say the store doesn't carry
anything matching and offer to search for something else. It must **not** substitute a
product that wasn't in the results — if it suggests one, that's a bug worth reporting.

**4. Gift / occasion query — the broadened search**

```powershell
$body = @{ message = "I need a gift for someone who snowboards"; sessionId = "t-gift" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/chat -Method Post -ContentType application/json -Body $body
```

Expect the **actual snowboards** alongside the Gift Card — not the Gift Card alone:

```json
{
  "sessionId": "t-gift",
  "reply": "Great! I found some snowboarding gifts. Here are the best options in stock:\n\n- **The Complete Snowboard** – $699.95 — A premium board, \"SUPERDUPER awesome\". …\n- **The Minimal Snowboard** – $885.95 — …\n\nWhat kind of budget did you have in mind?",
  "stopReason": "end_turn"
}
```

Because those results span $10 to $949.95, the tool flags `wide_price_range` and Claude
closes with **one** question about budget or experience level. Compare with
`"something for a skier"`, where the literal words match nothing and the broadened pass
recovers Ski Wax, and with `"do you have ski wax"` — already specific, so Claude should
answer without a follow-up question.

**5. A variant that DOES exist — grounded answer**

```powershell
$body = @{ message = "Do you have the Complete Snowboard in Powder?"; sessionId = "t-variant-yes" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/chat -Method Post -ContentType application/json -Body $body
```

`Powder` is a real colour on that product, so expect a straight confirmation with the
variant's own price and stock:

```json
{
  "sessionId": "t-variant-yes",
  "reply": "Yes! We have **The Complete Snowboard** in Powder for **$699.95 USD**. It's in stock and ready to ship. …",
  "stopReason": "end_turn"
}
```

**6. A variant that does NOT exist — the no-invention path**

```powershell
$body = @{ message = "Do you have the Complete Snowboard in blue?"; sessionId = "t-variant-no" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/chat -Method Post -ContentType application/json -Body $body
```

There is no blue variant. Expect a plain denial followed by the real options — never an
invented colour, and never "check the product page":

```json
{
  "sessionId": "t-variant-no",
  "reply": "We have **The Complete Snowboard** in stock at $699.95, but not in blue. The available colors are Ice, Dawn, Powder, Electric, and Sunset — all in stock. Would any of those colors work for you?",
  "stopReason": "end_turn"
}
```

Under the hood the tool returned:

```json
"requested_attributes": [{ "requested": "blue", "available": false, "matching_variants": [] }],
"all_requested_attributes_available": false,
"available_options": { "Color": ["Ice", "Dawn", "Powder", "Electric", "Sunset"] }
```

Try `"I want a snowboard in a large size"` too — none of these products have a size
option at all, so the answer should say so rather than claiming they come in large.

**7. Hidden/draft products — storefront visibility filter**

```powershell
$body = @{ message = "Do you sell the Hidden Snowboard?"; sessionId = "t-hidden" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/chat -Method Post -ContentType application/json -Body $body
```

Shopify's sample data includes products a shopper can't see on the live site: The
Hidden Snowboard (active but not published to the Online Store channel), The Minimal
Snowboard (same), The Draft Snowboard, and The Archived Snowboard. None of them may
ever appear in a reply. Expect the bot to say it doesn't carry a "Hidden" snowboard
and offer genuinely published boards instead — The Complete Snowboard and the
Collection boards should still show up for any snowboard query.

**8. Follow-up in the same session — history plus tool switching**

Send these in order with the same `sessionId`:

1. `"I'm looking for a snowboard"` → product results
2. `"and where's my order #1001?"` → order status

The second call should switch tools cleanly rather than searching the catalogue for
"1001".

### Other endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/chat` | `{ message, sessionId }` → `{ reply }` |
| `GET` | `/health` | Liveness plus active session count |
| `DELETE` | `/chat/:sessionId` | Wipe one session's history (handy while testing) |

---

## Multi-tenant mode: serving multiple client stores

One deployment can serve many independent Shopify stores. Set `DATABASE_URL`
(Supabase Postgres, Session-pooler connection string) and the backend switches to
multi-tenant mode: every `/chat` request must carry a `client_id`, which is resolved
against the `clients` table **on every request** — there is no default store, and the
env-var store config is ignored entirely.

### Onboarding a new client

1. Create a Shopify app for the client's store (or have them install yours), grant
   `read_orders` + `read_products`, and note the app's **Client ID** and **Client
   secret**.
2. Run the migration once per database: `npm run migrate`
3. Register the client (this verifies the credentials with a live token grant before
   inserting — a typo fails here, not in production):

   ```powershell
   npm run add-client -- `
     --domain acme.myshopify.com `
     --shopify-client-id <id> `
     --shopify-client-secret <secret> `
     --origin https://acme.myshopify.com,https://www.acme.com
   ```

   It prints the generated `client_id` and the exact widget snippet for the client's
   theme:

   ```html
   <script
     src="https://YOUR-BACKEND-HOST/widget.js"
     data-api-url="https://YOUR-BACKEND-HOST"
     data-client-id="cl_xxxxxxxxxxxxxxxx"
   ></script>
   ```

There is deliberately no HTTP endpoint for adding clients — the script runs where the
`DATABASE_URL` lives, by the operator only.

### How isolation works

- **Per-request resolution.** The client row is fetched from the database on every
  request and passed down the entire call chain (`handleMessage` → tools → GraphQL)
  as an explicit parameter. No module-level variable anywhere holds "the current
  store", so concurrent requests from different clients cannot race into each
  other's config.
- **Origin ↔ client binding.** CORS preflights are answered for any *registered*
  origin (preflights carry no body, so the client is unknown at that point), but the
  actual request is checked against the specific client's `allowed_origin` — a
  request claiming client A from client B's origin gets a 403, with the same body as
  an unknown `client_id` so probing can't tell the two apart.
- **Per-client token cache.** Shopify access tokens are cached in a Map keyed by
  `client_id`, each refreshing independently — one client's expiry or credential
  failure never touches another's.
- **Namespaced sessions.** Conversation history is keyed by `client_id::sessionId`,
  so identical sessionIds from different clients can never share history.
- **No client fallback.** A missing `client_id` is a 400; an unknown one is a 403.
  Nothing ever falls back to a default store in multi-tenant mode.

### Demo mode: prospecting before Shopify access

A prospect who hasn't granted API access yet can still get a working widget, running
on a one-time snapshot of their **public** product catalogue:

```powershell
npm run add-demo-client -- --domain prospect-store.com
```

This scrapes `https://prospect-store.com/products.json` (paginated, 400 ms between
pages, capped at 500 products — a polite scraper), normalizes it into the exact shape
the live search produces, stores it in the client row's `demo_catalog`, and prints the
widget snippet. Failure cases are reported distinctly: a password-protected storefront
(detected by the redirect to `/password` — all Shopify dev stores are protected, so
test against a real public store), a 404 (feed disabled or wrong domain), and network
errors each get their own message.

What a demo client can and can't do — the bot is honest about the difference:

- **Product questions work** — same search, ranking, stemming, broadening, and
  variant-attribute checking as live mode, just against the snapshot in memory.
  (Storefront-visibility filtering doesn't apply; everything scraped was public.)
- **Order tracking doesn't** — that data was never public. The tool returns a
  structured `order_tracking_connected: false`, and the bot says in one natural
  sentence that order tracking activates once the store connects its account, then
  offers product help. It never invents order data and never plays out an error.

### Upgrading a won prospect to live

```powershell
npm run upgrade-client -- --client-id cl_xxx --shopify-client-id <id> --shopify-client-secret <secret>
```

(Or pass the credentials via `UPGRADE_SHOPIFY_CLIENT_ID` / `UPGRADE_SHOPIFY_CLIENT_SECRET`
env vars — npm echoes the command line, so flags land secrets in terminal history.)

The command live-verifies the new credentials against the store's domain (a typo fails
here, changing nothing), then sets the credentials, flips `mode` to `live`, and clears
`demo_catalog`. **The `client_id` never changes** — a widget the prospect installed
during evaluation keeps working with zero changes on their end, and starts answering
real order questions the moment the command completes.

### Dev-only single-store fallback

With `DATABASE_URL` **unset**, the server runs the old single-store mode from the
`SHOPIFY_*` env vars, and the widget may omit `data-client-id`. This mode is for
local development only — never deploy it for real clients, and never set both a
production `DATABASE_URL` and dev store vars expecting the env vars to win (they
are ignored the moment `DATABASE_URL` is set).

---

## Installing the widget on a Shopify store

[public/widget.js](public/widget.js) is a self-contained chat widget — vanilla JS,
inline CSS, no build step. It renders a floating bubble bottom-right that expands into
a chat window and talks to `POST /chat`.

### Try it locally first

With the server running, open **http://localhost:3000/demo.html**. That page is served
by the backend itself, so requests are same-origin and nothing is blocked. Use it to
check the widget before touching a theme.

The widget generates a fresh random `sessionId` on every page load and persists
nothing in the browser — no stored transcript, no stored session. Refreshing the page
always starts an empty conversation (deliberate: a shared or public computer never
replays a previous visitor's chat). Conversation memory lives server-side for the
duration of the session only.

### Add it to a theme

**Online Store → Themes → … → Edit code → `layout/theme.liquid`**, and paste this just
before the closing `</body>` tag:

```html
<script
  src="https://your-backend.example.com/widget.js"
  data-api-url="https://your-backend.example.com"
></script>
```

The backend URL is read from `data-api-url` on the script tag, never hardcoded — so the
same file serves every client, pointed at a different deployment per store. Optional
attributes: `data-title`, `data-greeting`, `data-accent` (any CSS colour).

Then allow the storefront's origin on the backend:

```
ALLOWED_ORIGIN=https://your-store.myshopify.com,https://www.yourbrand.com
```

Include every origin shoppers actually browse from — the `.myshopify.com` domain *and*
the custom domain, if the store has one. Unset, `ALLOWED_ORIGIN` defaults to
`https://<SHOPIFY_STORE_DOMAIN>` plus localhost, which covers local development only.

**Production deployments must set `ALLOWED_ORIGIN` to the exact client domain(s) —
never `*`.** The wildcard exists for local experimentation only; on a public backend
it lets any website embed the widget and burn your Anthropic credits from its
visitors' browsers.

### localhost will not work from a real storefront

This trips people up, and it applies to your own testing too, not just to clients:

Shopify storefronts are served over HTTPS. A page loaded over HTTPS cannot load a
script from `http://localhost:3000`, and cannot `fetch` it either — browsers block both
as mixed content, silently apart from a console warning. Putting the widget on a real
storefront therefore needs the backend reachable over **HTTPS**, even while developing.

Two ways forward:

- **While developing** — expose your local server through an HTTPS tunnel
  (`cloudflared tunnel --url http://localhost:3000`, or ngrok) and use the tunnel's
  HTTPS address for both `src` and `data-api-url`. Add that address to
  `ALLOWED_ORIGIN` too.
- **For a live client store** — deploy the backend somewhere public with HTTPS
  (Railway, Render, Fly.io, a VPS behind Caddy or nginx) and point `data-api-url` at
  it. A tunnel is not a production answer; it disappears when your laptop sleeps.

Before a real store goes live, also read *Known limits* below — `/chat` currently has
no authentication or rate limiting, and once the widget is on a public storefront the
endpoint is reachable by anyone who views source.

---

## Creating test orders

You need real orders in the store before `get_order_status` returns anything useful.
There are two ways.

### Option A — the script (fast)

```powershell
npm run seed:orders
```

This creates three orders via draft orders (completed with payment pending), and
fulfills the first one with a fake tracking number so you can test the shipping path:

- a **shipped** single-item order with tracking
- a **payment-pending, unfulfilled** two-quantity order
- a **multi-item, unfulfilled** order

It prints each order number as it goes, then a ready-to-paste curl command. If your
store isn't in USD, set `SHOPIFY_CURRENCY` to the store's currency first.

Failures are reported per order rather than aborting the run — a scope error on one
order won't stop the others.

### Option B — Bogus Gateway checkout (realistic payment flow)

The script's orders are marked *payment pending*, since the Admin API can't push a
card through a gateway. To get an order that is genuinely **Paid**, check out on the
storefront with Shopify's test gateway:

1. **Settings → Payments → Add payment methods → search "Bogus Gateway"** (listed under
   *Manual payment methods* / *Test provider*), activate it. If you already use
   Shopify Payments, enable **test mode** on it instead.
2. Add a product to the cart on the storefront and go to checkout.
3. Enter these card details:
   - **Card number** `1` for a successful charge (`2` = failed charge, `3` = gateway
     error)
   - **Name** any name
   - **Expiry** any future date
   - **CVV** any 3 digits
4. Complete the order. It appears in **Orders** as Paid, with a real order number you
   can ask the chatbot about.
5. To test tracking, open the order → **Fulfill item** → add a tracking number.

Turn the Bogus Gateway off before the store ever handles real money.

---

## How it works

```
public/widget.js        storefront chat widget (vanilla JS, no build step)
public/demo.html        local test page for the widget
        │
        ▼  POST /chat
src/server.js           CORS, static files, rate limiting, validation, error -> status
  ├─ src/ratelimit.js   in-memory sliding-window limiter (per IP + per session)
  └─ src/agent.js       tool definitions, system prompt, Claude tool-use loop
      ├─ src/grounding.js   reply-vs-tool-results verification
      ├─ src/sessions.js    in-memory history, keyed by sessionId
      └─ src/shopify.js     GraphQL Admin API client, order lookup, product search
```

**Order identity verification.** `get_order_status` requires the order number *and*
the email the order was placed with; the email is compared (case-insensitive) against
the order's email on file before anything is returned. All failures — wrong number,
wrong email, no email on file — return one identical `verified: false` result, so
responses can't be used to confirm that an order number exists. The system prompt
makes Claude collect the email before calling the tool and forbids hinting at which
half of the pair failed. The on-file email is never included in tool results.

**Log hygiene.** Failed Shopify calls log status and response *structure* with PII
redacted — email, name, address, phone values are masked by key, plus a regex sweep
for emails in error strings ([src/shopify.js](src/shopify.js), `redactPII`). Success
paths log nothing about response contents. Rate limiting rejects with `429` at
`RATE_LIMIT_PER_IP` (default 20/min) and `RATE_LIMIT_PER_SESSION` (default 12/min).

**Tool routing.** The two tools are told apart by the system prompt and their
descriptions: order numbers, shipping and delivery go to `get_order_status`; "do you
have", "looking for", "show me" and any product description go to `search_products`. A
message that does both gets both tools in one turn, and the loop returns their results
together.

**Product search.** `search_products` takes the shopper's own phrasing, drops stop
words, strips inflected suffixes, then matches each remaining keyword as a prefix
against `title`, `product_type` and `tag`, OR'd together and filtered to active
products. So "something warm for snowboarding" becomes:

```
status:active AND ((title:warm* OR product_type:warm* OR tag:warm*) OR (title:snowboard* OR product_type:snowboard* OR tag:snowboard*))
```

The suffix stripping matters more than it looks: Shopify's `field:term*` is a prefix
match, so without it a shopper asking about "snowboarding" gets zero results from a
catalogue full of products named "…Snowboard". Stemming is deliberately crude
(`-ing`, `-ed`, `-es`, `-s`) — over-stemming only widens the search, and Claude picks
the relevant products out of what returns.

**Storefront visibility.** The search runs against the Admin API, which sees
everything — including products a shopper cannot. Results are therefore restricted to
products that are genuinely live: `status:active AND published_status:published` in
the search itself, plus a post-filter dropping anything whose `publishedAt` is null
(the reliable marker for "not published to the Online Store channel" — note that
`onlineStoreUrl` is *not* usable for this, since it's null for every product on
password-protected development stores).

This matters most when onboarding a real client's store: many merchants keep
seasonal or discontinued products as Draft — or active but unpublished — rather than
deleting them, precisely so they can bring them back later. This filter is what keeps
the bot from recommending a discontinued item a shopper can't buy. If a client says
"the bot can't find product X" and X looks fine in their admin, check its channel
publication first.

**The second pass.** Gift and occasion phrasing often contains no product word at all.
When the first search returns fewer than 2 matches, `search_products` retries with
broadened keywords: recipient and occasion words are dropped (`gift`, `brother`,
`birthday`…) and agent nouns are reduced to their root (`skier` → `ski`,
`snowboarder` → `snowboard`). First-pass hits keep their position ahead of second-pass
ones, since they matched the shopper's literal words. `"something for a skier"` finds
nothing literally and recovers Ski Wax this way.

The tool also returns `result_count` and `wide_price_range` (true when the priciest
match is 3× the cheapest). The system prompt uses these to decide whether one
clarifying question — budget, or the recipient's experience level — is worth asking.
Narrow queries like "do you have ski wax" get a straight answer instead.

**Variant grounding.** Each result carries its full option list and variants — option
values, per-variant price, and stock — so colour and size answers come from data
rather than from what a snowboard "probably" comes in. Shopify's synthetic
`Title / Default Title` option on single-variant products is stripped out, so an empty
`options` array genuinely means "no choices to make".

When the shopper names an attribute, Claude passes it in the tool's `attributes`
argument and gets back an explicit verdict:

```json
"requested_attributes": [{ "requested": "blue", "available": false, "matching_variants": [] }],
"all_requested_attributes_available": false,
"available_options": { "Color": ["Ice", "Dawn", "Powder", "Electric", "Sunset"] }
```

That `available: false` is the whole point — absence becomes a fact in the tool result
instead of something Claude has to infer from a list, which is where invented colours
came from. As a backstop, the tool also scans the query itself for common colour and
size words, so the check still runs even if Claude forgets to pass `attributes`.

The system prompt's grounding rules then require that every product name and every
variant appear verbatim in a tool result, and that an unavailable attribute be denied
plainly and answered with the real options — never a close-sounding substitute, and
never deflected to "check the product page".

**Structural grounding enforcement.** Prompt rules alone don't guarantee anything, so
[src/grounding.js](src/grounding.js) checks every drafted reply before it reaches the
shopper. It collects everything this turn's tool calls actually returned (titles,
variants, options, handles, order data) and scans the draft for product-like mentions:
bold spans, link labels, URLs, and Title Case phrases. A mention with no basis in this
turn's tool data — including a `/products/` link to a handle no tool returned — rejects
the draft. The agent then retries with a corrective note telling Claude to answer from
tool data or search first (max 2 retries), and falls back to a safe "please ask again"
reply if the model won't comply. Rejected drafts and correctives never enter the saved
conversation history, and rejections are logged with the specific violations.

The check is turn-scoped on purpose: a reply may only cite what a tool returned for
the *current* message, so recommending "from memory" of an earlier turn's results also
fails and forces a fresh search.

What the structural check cannot catch is a false claim *about* a grounded product —
"yes, these are Burton products" names only real items, and lexically an honest denial
uses the same words. That layer is handled by prompt rules (brands and qualities may
only be affirmed when the word appears in the product's title, type or tags) and
verified by reading live replies, not by the checker.

Up to 5 products come back with title, price (a range when variants differ), a ~180
character description excerpt, stock flag, and a storefront URL. On password-protected
development stores `onlineStoreUrl` is null even for published products, so the
handle URL (`/products/<handle>`) is used as the fallback.

**The tool-use loop.** Claude's first response may be a `tool_use` block rather than a
final answer. `agent.js` detects `stop_reason === "tool_use"`, runs every tool call in
that turn, appends all results as one `tool_result` user message, and calls the API
again. It repeats until Claude returns plain text — usually two calls, but multi-step
questions ("compare orders #1001 and #1002") work too. Only the final text reaches the
client. The loop is capped at 5 rounds so it can never spin forever.

**Error handling.** Shopify failures and unknown order numbers are converted into tool
results rather than exceptions, so Claude explains the problem to the customer instead
of the request failing:

| Situation | What happens |
| --- | --- |
| Reply names a product no tool returned | Draft rejected by the grounding check; retried with a corrective, then a safe fallback |
| Wrong order number, wrong email, or no email on file | One identical `verified: false` result; Claude asks the customer to re-check both, hinting at neither |
| No products match | Tool returns `{ products: [] }`; Claude says so instead of inventing one |
| Requested colour/size doesn't exist | Tool returns `available: false` plus the real `available_options`; Claude denies it and offers those |
| Shopify down / bad token / GraphQL error | Tool returns `is_error: true` with a message; Claude apologizes and suggests retrying |
| Claude API rate-limited or 5xx | `503` from `/chat`, server stays up |
| Claude API 4xx (e.g. bad key) | `502` from `/chat`, details in the server log only |
| Malformed JSON or missing fields | `400` with a specific message |

**Order number matching.** Shopify stores order names with the store prefix (usually
`#1001`). The lookup tries the number both with and without a leading `#`, so `1001`
and `#1001` both resolve.

---

## Known limits (deliberate, for this version)

- **Sessions are in-memory.** History is lost on restart and isn't shared across
  processes. Swap `src/sessions.js` for Redis or Postgres before running more than one
  instance.
- **Rate limiting is in-memory and per-process.** Restarting resets the counters, and
  multiple instances don't share them — move the limiter to Redis when scaling out.
  `ALLOWED_ORIGIN` is not a defence against curl; the limiter is the backstop.
- **Email verification is knowledge-based.** Anyone who knows both the order number
  and the email can read the order — fine for order-status data, but don't extend
  this pattern to refunds or address changes without stronger auth.
- **Product search is keyword matching, not semantic.** It only finds products whose
  title, type or tags literally contain one of the shopper's words (after stemming).
  "Something warm for snowboarding" works because "snowboard" is in every title —
  but a genuinely semantic query like "a gift for my brother who skis" will only match
  on "ski". A well-tagged catalogue papers over a lot of this; a sparsely-tagged one
  will miss obvious matches. Vector search over descriptions is the upgrade path.
- **Visibility filtering assumes the Online Store channel.** Results are limited to
  active products published to the Online Store. A store selling through other
  channels (POS-only products, headless storefronts) would need the filter adjusted.
- **Variant data makes tool results bigger.** Up to 25 variants per product across 5
  products goes into the conversation and is re-sent on every subsequent turn in that
  session. Fine for this catalogue; if you add products with dozens of size/colour
  combinations, trim the variant list or summarise it before it starts costing real
  tokens.
- **Two tools.** Returns, refunds, and per-location stock questions aren't handled yet.

---

## Before going live with a real client

Work through this list for every deployment — none of it is optional once real
customer data is involved.

**Credentials**

- [ ] **Use client credentials** (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`), not
      a pasted `SHOPIFY_ADMIN_TOKEN` — manual tokens expire after ~24h and take the
      bot down silently. Token refresh is automatic; expiry is no longer a reason to
      touch credentials.
- [ ] **Rotate the client secret** (and the Anthropic key) after any security
      incident: pasted into a chat log, visible in a screenshot, sitting in terminal
      history, sent in a DM. Rotation is cheap; assume anything that left the `.env`
      file is burned. Automatic refresh does not protect against a leaked *secret* —
      it protects against expiry.
- [ ] `.env` exists only on the server, is not in git (`git status` should never show
      it), and file permissions restrict who can read it.
- [ ] The Shopify custom app has **only** the scopes this backend needs
      (`read_orders`, `read_products`). Remove the write scopes once test orders are
      seeded — the chatbot never needs them.

**Identity & data**

- [ ] Order lookups verified: correct number + correct email returns data; correct
      number + wrong email returns the generic failure with no hints (test cases 2
      and 2b above).
- [ ] Server logs checked after a test conversation: no customer email, name,
      address, or phone anywhere in them.
- [ ] `/chat` responses contain only `sessionId`, `reply`, `stopReason` — no tokens,
      no keys, no raw Shopify payloads. (The widget receives nothing else; it never
      sees an API credential.)

**Abuse resistance**

- [ ] `ALLOWED_ORIGIN` set to the exact client storefront domain(s). Never `*` in
      production.
- [ ] Rate limits tuned for the client's expected traffic (`RATE_LIMIT_PER_IP`,
      `RATE_LIMIT_PER_SESSION`) and confirmed working: a burst of requests gets 429s.
- [ ] Behind a proxy or load balancer (Railway and Render always are), set
      `TRUST_PROXY=1` so `req.ip` is the real client IP from `X-Forwarded-For`, not
      the proxy's — otherwise the per-IP limit throttles all shoppers collectively.
      Leave it unset when the server is hit directly, or clients could spoof the
      header to evade the limit.

**Deployment**

- [ ] Backend served over HTTPS on a public host; `data-api-url` on the script tag
      points at it.
- [ ] Server restarted after any `.env` change — dotenv reads once at startup, and a
      long-lived process keeps using old credentials from memory.
- [ ] Session store and rate limiter still in-memory? Then run exactly one instance,
      and accept that restarts drop conversations. Redis both before scaling out.
