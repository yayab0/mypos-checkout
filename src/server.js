'use strict';
// myPOS checkout for Shopify — zero-dependency Node server.
const http = require('node:http');
const crypto = require('node:crypto');
const config = require('./config');
const { shops, orders, oauthStates } = require('./db');
const mypos = require('./mypos');
const shopify = require('./shopify');
const views = require('./views');
const countries = require('./countries');

// ---------- small helpers ----------

const log = (...a) => console.log(new Date().toISOString(), ...a);

function send(res, status, body, headers = {}) {
  const h = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers };
  res.writeHead(status, h);
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj, null, 2), { 'content-type': 'application/json' });
const sendLiquid = (res, body) => send(res, 200, body, { 'content-type': 'application/liquid; charset=utf-8' });
const redirect = (res, url) => send(res, 302, `Redirecting to ${url}`, { location: url, 'content-type': 'text/plain' });

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function parseForm(req) {
  const raw = (await readBody(req)).toString('utf8');
  const sp = new URLSearchParams(raw);
  return { pairs: [...sp.entries()], fields: Object.fromEntries(sp.entries()), raw };
}
function queryObject(url) {
  const o = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (o[k] === undefined) o[k] = v; else o[k] = [].concat(o[k], v);
  }
  return o;
}
const newOrderId = () => `MP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

function basicAuthOk(req) {
  if (!config.admin.password) return false;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return u === config.admin.user && p === config.admin.password;
}

// ---------- the checkout flow ----------

// GET /proxy  (store.com/apps/pay)
function handleCheckoutPage(res, shopRow, error) {
  sendLiquid(res, views.checkoutLiquid({ shopRow, error }));
}

// POST /proxy/create  (store.com/apps/pay/create)
async function handleCreate(req, res, shopRow) {
  const { fields } = await parseForm(req);
  let items;
  try { items = JSON.parse(fields.cart || '[]'); } catch { items = []; }
  if (!Array.isArray(items) || !items.length) return handleCheckoutPage(res, shopRow, 'Your cart looks empty. Please add a product and try again.');
  if (!mypos.isConfigured()) return handleCheckoutPage(res, shopRow, 'Payments are not configured yet. Please try again later.');

  const customer = {
    email: String(fields.email || '').trim().slice(0, 120),
    phone: String(fields.phone || '').trim().slice(0, 40),
    firstName: String(fields.firstName || '').trim().slice(0, 60),
    lastName: String(fields.lastName || '').trim().slice(0, 60),
    address: String(fields.address || '').trim().slice(0, 160),
    city: String(fields.city || '').trim().slice(0, 80),
    zip: String(fields.zip || '').trim().slice(0, 20),
    countryCode: countries.isKnown(fields.country) ? String(fields.country).toUpperCase() : 'GB',
  };
  if (!customer.email || !customer.firstName || !customer.lastName || !customer.address || !customer.city || !customer.zip) {
    return handleCheckoutPage(res, shopRow, 'Please fill in all required fields.');
  }

  let cart;
  try { cart = await shopify.priceCart(shopRow, items); }
  catch (e) { log('priceCart failed', shopRow.shop, e.message); return handleCheckoutPage(res, shopRow, 'We could not verify your cart. Please try again.'); }

  const currency = shopRow.currency || 'GBP';
  const lines = cart.map((c) => ({ title: c.title, quantity: c.quantity, price: c.price }));
  const shipAmount = Number(shopRow.shipping_amount || 0);
  if (shipAmount > 0) lines.push({ title: shopRow.shipping_label || 'Shipping', quantity: 1, price: shipAmount });

  const orderId = newOrderId();
  const total = mypos.money(lines.reduce((s, l) => s + Number(l.price) * Number(l.quantity), 0));
  orders.create({ order_id: orderId, shop: shopRow.shop, amount: Number(total), currency, cart, customer });
  log('order created', orderId, shopRow.shop, total, currency, config.mypos.mode);

  if (config.mypos.mode === 'embedded') {
    // Hand the browser to the on-site payment page (GET through the proxy so Shopify renders it in the theme).
    const next = `${config.proxyPath}/pay?order=${orderId}`;
    return send(res, 200, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${next}"><script>location.replace(${JSON.stringify(next)})</script><a href="${next}">Continue to payment</a>`);
  }
  send(res, 200, hostedPaymentForm(orderId, shopRow));
}

// Build the signed IPCPurchase for a stored order and return the auto-submit page (myPOS hosted payment page).
function hostedPaymentForm(orderId, shopRow) {
  const order = orders.get(orderId);
  const cart = JSON.parse(order.cart_json);
  const customer = JSON.parse(order.customer_json);
  const lines = cart.map((c) => ({ title: c.title, quantity: c.quantity, price: c.price }));
  const shipAmount = Number(shopRow.shipping_amount || 0);
  if (shipAmount > 0) lines.push({ title: shopRow.shipping_label || 'Shipping', quantity: 1, price: shipAmount });
  const built = mypos.buildPurchaseParams({
    orderId, currency: order.currency, cart: lines,
    customer: { ...customer, country: countries.alpha3(customer.countryCode) },
    note: `${shopRow.name || shopRow.shop} order`,
    urls: {
      ok: `${config.appUrl}/mypos/ok?order=${orderId}`,
      cancel: `${config.appUrl}/mypos/cancel?order=${orderId}`,
      notify: `${config.appUrl}/mypos/notify`,
    },
  });
  log('hosted purchase', orderId, built.total, order.currency);
  return mypos.purchaseFormHtml(built.params, built.action);
}

// GET /proxy/pay?order=  — embedded card form, rendered in the theme.
function handleEmbeddedPay(res, shopRow, orderId) {
  const order = orders.get(orderId);
  if (!order || order.shop !== shopRow.shop) return sendLiquid(res, '<p>Order not found.</p>');
  if (order.status === 'paid') return redirect(res, `${config.proxyPath}/thanks?order=${orderId}`);
  if (order.status !== 'created') return sendLiquid(res, views.cancelLiquid());
  sendLiquid(res, views.embeddedPayLiquid({ order, shopRow, creds: mypos.credentials() }));
}

// GET /proxy/hosted?order=  — fallback: same order, myPOS hosted page (Apple Pay / Google Pay).
function handleHosted(res, shopRow, orderId) {
  const order = orders.get(orderId);
  if (!order || order.shop !== shopRow.shop || order.status !== 'created') return sendLiquid(res, '<p>Order not found.</p>');
  send(res, 200, hostedPaymentForm(orderId, shopRow));
}

// POST /mypos/notify — server-to-server confirmation from myPOS. Must answer "OK".
async function handleNotify(req, res) {
  const { pairs, fields } = req.method === 'POST' ? await parseForm(req) : { pairs: [...new URL(req.url, 'http://x').searchParams.entries()], fields: queryObject(new URL(req.url, 'http://x')) };
  const method = fields.IPCmethod || '';
  if (!mypos.verifyCallback(pairs)) { log('notify: BAD SIGNATURE', fields.OrderID); return send(res, 400, 'Invalid signature', { 'content-type': 'text/plain' }); }
  if (method !== 'IPCPurchaseNotify') { log('notify: unexpected method', method); return send(res, 200, 'OK', { 'content-type': 'text/plain' }); }

  const order = orders.get(fields.OrderID);
  if (!order) { log('notify: unknown order', fields.OrderID); return send(res, 404, 'Unknown order', { 'content-type': 'text/plain' }); }
  if (order.status === 'paid' || order.status === 'refunded') return send(res, 200, 'OK', { 'content-type': 'text/plain' }); // idempotent

  const amountOk = Math.abs(Number(fields.Amount) - Number(order.amount)) < 0.005 && String(fields.Currency || order.currency) === order.currency;
  if (!amountOk) { log('notify: AMOUNT MISMATCH', fields.OrderID, fields.Amount, order.amount); orders.setStatus(order.order_id, 'failed'); return send(res, 400, 'Amount mismatch', { 'content-type': 'text/plain' }); }

  orders.markPaid(order.order_id, { ipc_trnref: fields.IPC_Trnref, card_last4: fields.PAN });
  log('notify: PAID', order.order_id, fields.IPC_Trnref);
  // Answer myPOS first; create the Shopify order right after (retryable from /admin if it fails).
  send(res, 200, 'OK', { 'content-type': 'text/plain' });
  createShopifyOrder(order.order_id).catch((e) => log('createShopifyOrder error', order.order_id, e.message));
}

async function createShopifyOrder(orderId) {
  const order = orders.get(orderId);
  const shopRow = shops.get(order.shop);
  if (!shopRow) { orders.setShopifyError(orderId, 'Store not installed'); return; }
  try {
    const cart = JSON.parse(order.cart_json);
    const customer = JSON.parse(order.customer_json);
    const created = await shopify.createPaidOrder(shopRow, {
      order, cart, customer,
      shipping: { label: shopRow.shipping_label, amount: shopRow.shipping_amount },
      ipcTrnref: order.ipc_trnref, cardLast4: order.card_last4,
    });
    orders.setShopifyOrder(orderId, created.id, created.name);
    log('shopify order created', orderId, created.name);
  } catch (e) {
    orders.setShopifyError(orderId, e.message);
    throw e;
  }
}

// GET|POST /mypos/ok and /mypos/cancel — browser comes back here, then to the store's themed page.
function storeUrl(shopRow, path) { return `${shopRow.primary_domain || `https://${shopRow.shop}`}${config.proxyPath}${path}`; }
async function handleReturn(req, res, kind) {
  if (req.method === 'POST') await readBody(req).catch(() => {});
  const url = new URL(req.url, 'http://x');
  const order = orders.get(url.searchParams.get('order') || '');
  if (!order) return send(res, 404, views.page('Not found', '<h1>Order not found</h1>'));
  const shopRow = shops.get(order.shop);
  if (kind === 'cancel' && order.status === 'created') orders.setStatus(order.order_id, 'cancelled');
  if (!shopRow) return send(res, 200, views.page('Thank you', kind === 'ok' ? '<h1>Thank you — payment received</h1>' : '<h1>Payment cancelled</h1>'));
  redirect(res, storeUrl(shopRow, kind === 'ok' ? `/thanks?order=${order.order_id}` : `/cancel?order=${order.order_id}`));
}

// ---------- OAuth ----------

async function handleAuth(req, res, url) {
  const shop = String(url.searchParams.get('shop') || '').trim().toLowerCase();
  if (!shopify.isValidShop(shop)) return send(res, 400, views.page('Install', '<h1>Enter a valid store</h1><p>Use <code>/auth?shop=your-store.myshopify.com</code></p>'));
  if (!config.shopify.apiKey || !config.shopify.apiSecret) return send(res, 500, views.page('Install', '<h1>SHOPIFY_API_KEY / SHOPIFY_API_SECRET not set</h1>'));
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.put(state, shop);
  redirect(res, shopify.oauthStartUrl(shop, state));
}

async function handleAuthCallback(req, res, url) {
  const q = queryObject(url);
  const st = oauthStates.take(q.state || '');
  const reason = !q.state ? 'no state in callback' : !st ? 'state not found (expired, already used, or issued by a previous deploy)'
    : st.shop !== q.shop ? `shop mismatch (${st.shop} vs ${q.shop})` : !shopify.isValidShop(q.shop) ? 'invalid shop'
    : !shopify.verifyOauthHmac(q) ? 'hmac mismatch (check SHOPIFY_API_SECRET)' : null;
  if (reason) {
    log('oauth callback rejected:', reason, 'params:', Object.keys(q).join(','));
    return send(res, 400, views.page('Install', `<h1>Invalid install request</h1><p>${views.esc(reason)}.</p><p>Start again from <code>/auth?shop=${views.esc(q.shop || '…')}</code></p>`));
  }
  try {
    const tok = await shopify.exchangeToken(q.shop, q.code);
    let row = shops.upsert({ shop: q.shop, access_token: tok.access_token, scopes: tok.scope });
    const info = await shopify.fetchShopInfo(row);
    row = shops.upsert({ ...row, ...info });
    log('installed', q.shop, info.primary_domain);
    send(res, 200, views.page('Installed', `<h1>Installed on ${views.esc(info.name)} ✅</h1>
      <p>Checkout page: <a href="${views.esc(info.primary_domain)}${config.proxyPath}">${views.esc(info.primary_domain)}${config.proxyPath}</a></p>
      <p>Make sure the app proxy in your Shopify app settings is: subpath prefix <code>${config.shopify.proxyPrefix}</code>, subpath <code>${config.shopify.proxySubpath}</code>, proxy URL <code>${config.appUrl}/proxy</code>.</p>
      <p><a href="/admin">Go to admin</a></p>`));
  } catch (e) {
    log('install failed', q.shop, e.message);
    send(res, 500, views.page('Install failed', `<h1>Install failed</h1><p>${views.esc(e.message)}</p>`));
  }
}

// ---------- admin ----------

async function handleAdmin(req, res, url) {
  if (!basicAuthOk(req)) {
    if (!config.admin.password) return send(res, 503, views.page('Admin', '<h1>Admin disabled</h1><p>Set ADMIN_PASSWORD to enable.</p>'));
    return send(res, 401, 'Auth required', { 'www-authenticate': 'Basic realm="mypos-checkout"', 'content-type': 'text/plain' });
  }
  let flash = null;
  if (req.method === 'POST') {
    const { fields } = await parseForm(req);
    try {
      if (url.pathname === '/admin/shipping') {
        shops.setShipping(fields.shop, String(fields.label || 'Shipping').slice(0, 40), Math.max(0, Number(fields.amount) || 0));
        flash = { ok: true, msg: `Shipping updated for ${fields.shop}` };
      } else if (url.pathname === '/admin/retry') {
        await createShopifyOrder(fields.order_id);
        flash = { ok: true, msg: `Shopify order created for ${fields.order_id}` };
      } else if (url.pathname === '/admin/refund') {
        const o = orders.get(fields.order_id);
        const amount = Number(fields.amount);
        if (!o || !o.ipc_trnref) throw new Error('Order not refundable');
        if (!(amount > 0) || amount > Number(o.amount) - Number(o.refunded_amount || 0)) throw new Error('Invalid refund amount');
        const r = await mypos.refund({ orderId: o.order_id, ipcTrnref: o.ipc_trnref, amount, currency: o.currency });
        if (!r.ok) throw new Error(`myPOS refund failed: ${JSON.stringify(r.response).slice(0, 300)}`);
        orders.addRefund(o.order_id, amount);
        let note = `Refunded ${amount.toFixed(2)} ${o.currency} via myPOS`;
        if (o.shopify_order_gid) {
          try { await shopify.refundShopifyOrder(shops.get(o.shop), o.shopify_order_gid, amount, o.currency, note); }
          catch (e) { note += ` (Shopify refund record failed: ${e.message})`; }
        }
        flash = { ok: true, msg: note };
      }
    } catch (e) { flash = { ok: false, msg: e.message }; }
  }
  send(res, 200, views.adminHtml({ shops: shops.all(), orders: orders.recent(100), myposStatus: mypos.credentials(), flash }));
}

// ---------- router ----------

async function route(req, res) {
  const url = new URL(req.url, config.appUrl);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/' || p === '/health') {
    const c = mypos.credentials();
    return sendJson(res, 200, { ok: true, service: 'mypos-checkout', mypos: c.missing.length ? `missing ${c.missing.join(',')}` : (c.sandbox ? 'sandbox' : 'live'), mode: config.mypos.mode, stores: shops.all().length, proxy: `${config.proxyPath} -> ${config.appUrl}/proxy` });
  }
  if (p === '/auth') return handleAuth(req, res, url);
  if (p === '/auth/callback') return handleAuthCallback(req, res, url);

  if (p === '/proxy' || p.startsWith('/proxy/')) {
    const q = queryObject(url);
    if (!shopify.verifyProxySignature(q)) return send(res, 403, 'Bad proxy signature', { 'content-type': 'text/plain' });
    const shopRow = shops.get(String(q.shop || '').toLowerCase());
    if (!shopRow) return sendLiquid(res, '<p>This store has not installed the checkout app yet.</p>');
    const sub = p.slice('/proxy'.length) || '/';
    if (sub === '/' && req.method === 'GET') return handleCheckoutPage(res, shopRow);
    if (sub === '/create' && req.method === 'POST') return handleCreate(req, res, shopRow);
    if (sub === '/pay') return handleEmbeddedPay(res, shopRow, url.searchParams.get('order') || '');
    if (sub === '/hosted') return handleHosted(res, shopRow, url.searchParams.get('order') || '');
    if (sub === '/thanks') return sendLiquid(res, views.thanksLiquid({ order: orders.get(url.searchParams.get('order') || '') }));
    if (sub === '/cancel') return sendLiquid(res, views.cancelLiquid());
    return sendLiquid(res, '<p>Not found.</p>');
  }

  if (p === '/mypos/notify') return handleNotify(req, res);
  if (p === '/mypos/ok') return handleReturn(req, res, 'ok');
  if (p === '/mypos/cancel') return handleReturn(req, res, 'cancel');

  if (p === '/admin' || p.startsWith('/admin/')) return handleAdmin(req, res, url);

  // Shopify compliance webhooks (customers/data_request etc.): verify HMAC and acknowledge.
  if (p.startsWith('/webhooks/')) {
    const raw = await readBody(req);
    const digest = crypto.createHmac('sha256', config.shopify.apiSecret).update(raw).digest('base64');
    const ok = digest.length === String(req.headers['x-shopify-hmac-sha256'] || '').length && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(req.headers['x-shopify-hmac-sha256'] || '')));
    return send(res, ok ? 200 : 401, ok ? 'OK' : 'Unauthorized', { 'content-type': 'text/plain' });
  }

  send(res, 404, views.page('Not found', '<h1>Not found</h1>'));
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    log('unhandled', req.method, req.url, e.stack || e.message);
    if (!res.headersSent) send(res, 500, views.page('Error', '<h1>Something went wrong</h1>'));
  });
});

server.listen(config.port, () => {
  const c = mypos.credentials();
  log(`mypos-checkout listening on :${config.port}`);
  log(`APP_URL=${config.appUrl}  proxy ${config.proxyPath} -> ${config.appUrl}/proxy`);
  log(`myPOS: ${c.missing.length ? `NOT CONFIGURED (missing ${c.missing.join(', ')})` : `${c.sandbox ? 'SANDBOX' : 'LIVE'} sid=${c.sid}`}`);
  if (!config.shopify.apiKey) log('Shopify: SHOPIFY_API_KEY not set — installs will not work yet');
});

module.exports = server;
