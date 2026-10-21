# myPOS checkout for Shopify

A store-branded checkout that takes payment through **myPOS** (hosted payment page) and creates the paid
order in **Shopify**. One service serves all your stores; it installs on each store as a Shopify app and
appears at `https://your-store.com/apps/pay`, rendered inside the store's own theme.

Zero npm dependencies — Node 22 built-ins only (HTTP, crypto, SQLite).

## How an order flows

1. Customer opens `store.com/apps/pay`. Shopify proxies it to this service, which returns a Liquid page →
   Shopify renders it in the theme with the customer's cart.
2. Customer enters email + address and presses **Pay**. The form posts (through the proxy) to this service.
3. The service re-prices every cart line from the Shopify Admin API (browser can't set prices), builds and
   signs a myPOS `IPCPurchase`, and the browser auto-submits it to myPOS's secure page.
4. Customer pays on myPOS (cards, Apple Pay, Google Pay…). Money is in your myPOS account instantly.
5. myPOS calls `/mypos/notify` server-to-server. The service verifies the signature and the amount, marks
   the order paid, answers `OK`, and creates the paid Shopify order (`orderCreate`, inventory decremented,
   receipt emailed).
6. The browser returns via `/mypos/ok` → redirected to `store.com/apps/pay/thanks` (themed), cart cleared.
7. Refunds: `/admin` → Refund → money returned by myPOS (`IPCRefund`) and recorded on the Shopify order.

## One-time setup

### 1. myPOS (do once, works for every store)
1. In your myPOS account: **Online → Online Stores → Create** a Checkout store. Integration method: **API**.
   Website URL: the store's domain. Currency: GBP (add more later).
2. On the review step copy the **Configuration Pack** string → env var `MYPOS_CONFIG_PACK`.
   (Alternative: set `MYPOS_SID`, `MYPOS_WALLET`, `MYPOS_KEY_INDEX`, `MYPOS_PRIVATE_KEY`, `MYPOS_PUBLIC_CERT` yourself.)
3. myPOS verifies new/changed stores (up to 5 business days). Meanwhile keep `MYPOS_SANDBOX=1` and use the
   test credentials from <https://developers.mypos.com/en/doc/online_payments/v1_4/422-configuration>.
4. Go live: `MYPOS_SANDBOX=0`.

### 2. Shopify app (do once)
Create an app in the Shopify dev dashboard (or Partners) with these settings (see `shopify.app.toml`):
- App URL: `https://<service>/admin`
- Redirect URL: `https://<service>/auth/callback`
- Scopes: `write_orders,read_products`
- **App proxy**: prefix `apps`, subpath `pay`, proxy URL `https://<service>/proxy`
- Distribution: custom (your own stores)
Copy the Client ID / Client secret → `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`.

### 3. Render
Create a Node web service from this repo (or use `render.yaml`): start command `npm start`, a 1 GB disk at
`/var/data`, and the env vars from `.env.example`. Set `APP_URL` to the service URL.

### 4. Install on each store
Open `https://<service>/auth?shop=the-store.myshopify.com` (or use the form in `/admin`), approve the app.
Done — the checkout is live at `https://the-store.com/apps/pay`. Point your "Checkout" button / redirect
app there. Flat shipping per store can be set in `/admin`.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /health` | status JSON |
| `GET /auth?shop=` → `/auth/callback` | Shopify OAuth install |
| `GET /proxy` | checkout page (Liquid) — served at `store.com/apps/pay` |
| `POST /proxy/create` | builds the signed myPOS purchase, redirects browser to myPOS |
| `GET /proxy/thanks`, `/proxy/cancel` | themed result pages |
| `POST /mypos/notify` | myPOS server-to-server confirmation (must stay public HTTPS) |
| `GET/POST /mypos/ok`, `/mypos/cancel` | browser return from myPOS → bounce to themed page |
| `GET /admin` | stores, orders, refunds, retry (HTTP basic auth) |

## Local run
```
cp .env.example .env   # fill in
npm start              # http://localhost:10000
npm test               # offline end-to-end test with a fake store + fake myPOS callback
```

## Checkout modes (`CHECKOUT_MODE`)
- `embedded` (default): the card form (myPOS Embedded SDK iframe) is shown on `store.com/apps/pay/pay` — the customer
  pays without leaving the store. A link offers the myPOS hosted page for Apple Pay / Google Pay.
- `redirect`: the customer is sent to myPOS's hosted payment page (all payment methods).
Both modes share the same order flow, notify handling, Shopify order creation and refunds.

## PayPal module (`/paypal`)

An independent PayPal checkout + donations module lives in `src/paypal/` and is mounted at
`/paypal` by one line in `src/server.js`. It shares nothing with the myPOS flow except the
process and the `/var/data` disk; its env vars are all `PAYPAL_*`. With no
`PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` set, `/paypal/*` answers 503 and the rest of the
service is unaffected.

| URL | What |
|---|---|
| `/paypal/checkout?amount=49.99&currency=GBP` | checkout with a fixed amount |
| `/paypal/checkout?name=…&price=…&qty=…&shipping=…&ref=…` | checkout with line items (`PHYSICAL_GOODS`) |
| `/paypal/donate` | donation page (`DONATION`, no shipping) — only when `PAYPAL_CHARITY_NAME` is set |
| `/paypal/monitor?token=…` | live monitor: clock 1 / clock 2 per order, running checkouts, failures classified (buyer / your account / risk / expired), held captures, webhooks |
| `/paypal/api/live?token=…` | JSON list of in-flight checkouts with clock start/end/remaining |
| `/paypal/api/webhooks/paypal` | register this in the PayPal dashboard, then set `PAYPAL_WEBHOOK_ID` |
| `/paypal/healthz` | module health |

Flow: the buyer clicks the PayPal button → `POST /paypal/api/orders` creates the PayPal order
(clock 1 starts) → the PayPal popup opens (clock 2 starts) → buyer taps Pay Now →
`POST /paypal/api/orders/:id/capture` (must land inside clock 2). Both clocks default to 6 h.
Orders and the event log persist to `PAYPAL_DATA_DIR` (`paypal-orders.json`,
`paypal-events.jsonl`) and are reloaded on boot.

Test: `node test/paypal.js` runs the module inside the real server against a mock PayPal.
