'use strict';
// PayPal hosted checkout + donation module, mounted under /paypal by src/server.js.
//
//   create order  → POST /paypal/api/orders             clock 1 starts when PayPal returns an id
//   buyer lands on PayPal's page                         clock 1 ends, clock 2 starts (page reports PAYER_LANDED)
//   buyer taps Pay Now                                   APPROVED (page reports APPROVED)
//   capture       → POST /paypal/api/orders/:id/capture  must land inside clock 2
//   webhook       → POST /paypal/api/webhooks/paypal     PayPal's independent confirmation
//   monitor       → GET  /paypal/monitor?token=…         live clocks, errors, risk/account flags
//
// Fully independent of the myPOS code: own env vars (all PAYPAL_*), own files on disk, own log.
// If PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set the module answers 503 on /paypal/*
// and nothing else in the service is affected.
//
//   PAYPAL_ENV                  sandbox | live (default sandbox)
//   PAYPAL_CLIENT_ID            REST app client id of the RECEIVING account
//   PAYPAL_CLIENT_SECRET        its secret
//   PAYPAL_WEBHOOK_ID           webhook id from the PayPal dashboard (enables signature verification)
//   PAYPAL_MONITOR_TOKEN        password for /paypal/monitor and /paypal/api/monitor|live
//   PAYPAL_BRAND_NAME           shown on PayPal's page for /paypal/checkout (default "Store")
//   PAYPAL_CHARITY_NAME         exact charity name on the PayPal account; setting it enables /paypal/donate
//   PAYPAL_DONATION_PRESETS     "10,25,50"
//   PAYPAL_DONATION_MIN         1
//   PAYPAL_DEFAULT_CURRENCY     GBP
//   PAYPAL_ORDER_WINDOW_HOURS   6 (3 on older accounts, 24/48/72 if raised by PayPal)
//   PAYPAL_DATA_DIR             where orders + event log persist (default: dir of DB_PATH, else ./data)
//   PAYPAL_PUBLIC_URL           public origin incl. prefix; default APP_URL + /paypal
//   PAYPAL_API_BASE             test hook only: point at a local mock

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PREFIX = '/paypal';
const PUBLIC_DIR = path.join(__dirname, 'public');

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

function buildConfig() {
  const ENV = env('PAYPAL_ENV') === 'live' ? 'live' : 'sandbox';
  const dataDir = env('PAYPAL_DATA_DIR') || (env('DB_PATH') ? path.dirname(env('DB_PATH')) : path.join(process.cwd(), 'data'));
  const appUrl = env('APP_URL', 'http://localhost:10000').replace(/\/+$/, '');
  return {
    ENV,
    BASE: env('PAYPAL_API_BASE') || (ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'),
    CLIENT_ID: env('PAYPAL_CLIENT_ID'),
    CLIENT_SECRET: env('PAYPAL_CLIENT_SECRET'),
    WEBHOOK_ID: env('PAYPAL_WEBHOOK_ID'),
    MONITOR_TOKEN: env('PAYPAL_MONITOR_TOKEN'),
    BRAND_NAME: env('PAYPAL_BRAND_NAME', 'Store'),
    CHARITY_NAME: env('PAYPAL_CHARITY_NAME'),
    DONATION_PRESETS: env('PAYPAL_DONATION_PRESETS', '10,25,50').split(',').map(Number).filter((n) => n > 0),
    DONATION_MIN: Number(env('PAYPAL_DONATION_MIN', '1')) || 1,
    DEFAULT_CURRENCY: env('PAYPAL_DEFAULT_CURRENCY', 'GBP').toUpperCase(),
    WINDOW_MS: (Number(env('PAYPAL_ORDER_WINDOW_HOURS', '6')) || 6) * 3600_000,
    PUBLIC_URL: (env('PAYPAL_PUBLIC_URL') || `${appUrl}${PREFIX}`).replace(/\/+$/, ''),
    DATA_DIR: dataDir,
    LOG_FILE: path.join(dataDir, 'paypal-events.jsonl'),
    ORDERS_FILE: path.join(dataDir, 'paypal-orders.json'),
  };
}

// Classification of PayPal "issue" codes → who/what caused it.
const ISSUE_CATEGORY = {
  INSTRUMENT_DECLINED: 'buyer_funding', PAYER_CANNOT_PAY: 'buyer_funding',
  PAYER_ACCOUNT_RESTRICTED: 'buyer_account', PAYER_ACCOUNT_LOCKED_OR_CLOSED: 'buyer_account', PAYER_ACTION_REQUIRED: 'buyer_action',
  PAYEE_ACCOUNT_RESTRICTED: 'merchant_account', PAYEE_ACCOUNT_LOCKED_OR_CLOSED: 'merchant_account', PAYEE_ACCOUNT_INVALID: 'merchant_account',
  PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING: 'merchant_account', PAYEE_BLOCKED_TRANSACTION: 'merchant_account', PAYEE_FX_RATE_ID_EXPIRED: 'merchant_account',
  TRANSACTION_BLOCKED_BY_PAYEE: 'merchant_account', AUTH_CAPTURE_NOT_ENABLED: 'merchant_account', PERMISSION_DENIED: 'merchant_account',
  CURRENCY_NOT_SUPPORTED_FOR_COUNTRY: 'merchant_account',
  TRANSACTION_REFUSED: 'risk', COMPLIANCE_VIOLATION: 'risk', RISK_DECLINE: 'risk', TRANSACTION_LIMIT_EXCEEDED: 'risk',
  RESOURCE_NOT_FOUND: 'expired', INVALID_RESOURCE_ID: 'expired', ORDER_EXPIRED: 'expired',
  ORDER_NOT_APPROVED: 'not_approved', ORDER_ALREADY_CAPTURED: 'duplicate',
};
const RECOVERABLE = new Set(['expired', 'not_approved']);
const CATEGORY_WHY = {
  buyer_funding: "buyer's funding source declined — they can pick another on the same order",
  buyer_account: "buyer's PayPal account is restricted/locked — buyer-side problem",
  merchant_account: 'YOUR receiving account refused it — check PayPal account limitations / email from PayPal',
  risk: 'PayPal risk/compliance blocked this transaction',
  expired: 'the order expired (clock ran out) — page will create a fresh one',
  not_approved: 'buyer never tapped Pay Now (or clock 2 ran out before capture)',
  duplicate: 'already captured — ignore',
};

function create() {
  const C = buildConfig();
  const enabled = !!(C.CLIENT_ID && C.CLIENT_SECRET);
  const DONATIONS_ENABLED = !!C.CHARITY_NAME;

  // =========================================================================
  // State: orders (persisted as JSON on the data disk) + event ring buffer
  // =========================================================================
  const orders = new Map();
  const events = [];
  const MAX_EVENTS = 2000;
  const MAX_ORDERS = 5000;

  try { fs.mkdirSync(C.DATA_DIR, { recursive: true }); } catch {}

  function loadOrders() {
    try {
      const arr = JSON.parse(fs.readFileSync(C.ORDERS_FILE, 'utf8'));
      for (const r of arr) orders.set(r.id, r);
    } catch {}
  }
  let saveTimer = null;
  function saveOrders() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const arr = [...orders.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_ORDERS);
      const tmp = `${C.ORDERS_FILE}.tmp`;
      fs.writeFile(tmp, JSON.stringify(arr), (err) => { if (!err) fs.rename(tmp, C.ORDERS_FILE, () => {}); });
    }, 500);
  }
  function loadRecentEvents() {
    try {
      const lines = fs.readFileSync(C.LOG_FILE, 'utf8').trim().split('\n').slice(-500);
      for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }
    } catch {}
  }
  loadOrders();
  loadRecentEvents();

  function newRecord(id, cart, createdAt) {
    return { id, cart, status: 'CREATED', createdAt, landedAt: null, approvedAt: null, capturedAt: null, cancelledAt: null, failedAt: null, failure: null, capture: null, fundingSource: null, events: [] };
  }

  function log(level, type, orderId, msg, data) {
    const ev = { t: new Date().toISOString(), level, type, orderId: orderId || null, msg, data: data ?? null };
    events.push(ev);
    if (events.length > MAX_EVENTS) events.shift();
    const rec = orderId && orders.get(orderId);
    if (rec) { rec.events.push({ t: ev.t, type, level, msg }); if (rec.events.length > 50) rec.events.shift(); saveOrders(); }
    const line = `${ev.t} [paypal ${level.toUpperCase()}] ${type}${orderId ? ` ${orderId}` : ''} — ${msg}`;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    fs.appendFile(C.LOG_FILE, JSON.stringify(ev) + '\n', () => {});
  }

  function clocks(rec, now = Date.now()) {
    const c1Start = Date.parse(rec.createdAt);
    const c1Deadline = c1Start + C.WINDOW_MS;
    const c2Start = rec.landedAt ? Date.parse(rec.landedAt) : null;
    const c2Deadline = c2Start ? c2Start + C.WINDOW_MS : null;
    const done = rec.capturedAt || rec.failedAt || rec.cancelledAt;
    let phase;
    if (rec.status === 'PENDING') phase = 'held';
    else if (rec.capturedAt) phase = 'completed';
    else if (rec.failedAt) phase = 'failed';
    else if (rec.cancelledAt) phase = 'cancelled';
    else if (!c2Start) phase = now > c1Deadline ? 'clock1_expired' : 'clock1';
    else phase = now > c2Deadline ? 'clock2_expired' : rec.approvedAt ? 'approved_awaiting_capture' : 'clock2';
    return {
      phase,
      clock1: { startedAt: rec.createdAt, deadline: new Date(c1Deadline).toISOString(), endedAt: rec.landedAt, remainingMs: c2Start || done ? 0 : Math.max(0, c1Deadline - now) },
      clock2: c2Start ? { startedAt: rec.landedAt, deadline: new Date(c2Deadline).toISOString(), endedAt: rec.capturedAt, remainingMs: done ? 0 : Math.max(0, c2Deadline - now) } : null,
    };
  }

  // =========================================================================
  // PayPal REST
  // =========================================================================
  let tokenCache = { value: null, expiresAt: 0 };
  async function accessToken() {
    if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.value;
    const auth = Buffer.from(`${C.CLIENT_ID}:${C.CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${C.BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      log('error', 'AUTH_FAILED', null, `PayPal rejected the client id/secret (${r.status}) — check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV`, j);
      throw new Error('paypal_auth_failed');
    }
    tokenCache = { value: j.access_token, expiresAt: Date.now() + (j.expires_in || 3000) * 1000 };
    return j.access_token;
  }
  async function paypal(method, url, body, extraHeaders = {}) {
    const token = await accessToken();
    const r = await fetch(`${C.BASE}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { ok: r.ok, status: r.status, json, debugId: r.headers.get('paypal-debug-id') };
  }

  // =========================================================================
  // Cart → order payload
  // =========================================================================
  const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

  function parseCart(input) {
    const currency = String(input.currency || C.DEFAULT_CURRENCY).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid currency');

    if (input.kind === 'donation') {
      if (!DONATIONS_ENABLED) throw new Error('Donations are not enabled on this server');
      const total = Number(money(input.amount));
      if (!(total >= C.DONATION_MIN) || total > 100_000) throw new Error(`Invalid amount (minimum ${C.DONATION_MIN})`);
      const note = input.message ? String(input.message).slice(0, 127) : undefined;
      return {
        kind: 'donation', currency, shipping: '0.00', itemTotal: money(total), total: money(total),
        items: [{ name: `Donation to ${C.CHARITY_NAME}`, quantity: 1, unit_amount: money(total) }],
        reference: input.reference ? String(input.reference).slice(0, 127) : undefined,
        description: note || `Donation to ${C.CHARITY_NAME}`,
        donor: { anonymous: !!input.anonymous, message: note },
      };
    }

    const items = (Array.isArray(input.items) ? input.items : [])
      .map((it) => ({
        name: String(it.name || 'Item').slice(0, 127),
        quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
        unit_amount: money(it.price),
        sku: it.sku ? String(it.sku).slice(0, 127) : undefined,
      }))
      .filter((it) => Number(it.unit_amount) > 0);
    const shipping = money(input.shipping || 0);
    const itemTotal = items.reduce((s, it) => s + Number(it.unit_amount) * it.quantity, 0);
    const total = items.length ? itemTotal + Number(shipping) : Number(money(input.amount));
    if (!(total > 0) || total > 100_000) throw new Error('Invalid amount');
    return {
      kind: 'checkout', currency, items, shipping, itemTotal: money(itemTotal), total: money(total),
      reference: input.reference ? String(input.reference).slice(0, 127) : undefined,
      description: input.description ? String(input.description).slice(0, 127) : undefined,
    };
  }

  function orderPayload(cart) {
    const donation = cart.kind === 'donation';
    const amount = { currency_code: cart.currency, value: cart.total };
    if (cart.items.length) {
      amount.breakdown = { item_total: { currency_code: cart.currency, value: cart.itemTotal } };
      if (!donation) amount.breakdown.shipping = { currency_code: cart.currency, value: cart.shipping };
    }
    const pu = { reference_id: 'default', custom_id: cart.reference, description: cart.description, amount };
    if (cart.items.length) {
      pu.items = cart.items.map((it) => ({
        name: it.name, quantity: String(it.quantity), sku: it.sku,
        unit_amount: { currency_code: cart.currency, value: it.unit_amount },
        category: donation ? 'DONATION' : 'PHYSICAL_GOODS',
      }));
    }
    return {
      intent: 'CAPTURE',
      purchase_units: [pu],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: donation ? C.CHARITY_NAME : C.BRAND_NAME,
            user_action: 'PAY_NOW',
            shipping_preference: donation ? 'NO_SHIPPING' : 'GET_FROM_FILE',
            return_url: `${C.PUBLIC_URL}/return`,
            cancel_url: `${C.PUBLIC_URL}/${donation ? 'donate' : 'checkout'}`,
          },
        },
      },
    };
  }

  // =========================================================================
  // HTTP helpers (self-contained so the module never depends on server.js internals)
  // =========================================================================
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
  }
  function readBody(req, limit = 1_000_000) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req, limit) {
    const raw = (await readBody(req, limit)).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }
  function servePage(res, name) {
    const full = path.join(PUBLIC_DIR, `${name}.html`);
    fs.readFile(full, 'utf8', (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      const html = data.replaceAll('__BASE__', PREFIX);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(html);
    });
  }
  function monitorAuthorised(req, url) {
    if (!C.MONITOR_TOKEN) return true;
    const given = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return given.length === C.MONITOR_TOKEN.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(C.MONITOR_TOKEN));
  }

  // =========================================================================
  // Handlers
  // =========================================================================
  async function createOrder(req, res) {
    let cart;
    try { cart = parseCart(await readJson(req, 100_000)); }
    catch (e) { log('warn', 'BAD_CART', null, `rejected cart: ${e.message}`); return send(res, 400, { error: e.message || 'bad request' }); }

    let out;
    try {
      out = await paypal('POST', '/v2/checkout/orders', orderPayload(cart), { 'PayPal-Request-Id': req.headers['x-idempotency-key'] || crypto.randomUUID() });
    } catch { return send(res, 502, { error: 'paypal_unreachable' }); }

    const { ok, status, json, debugId } = out;
    if (!ok) {
      const issue = json.details?.[0]?.issue || json.name || `HTTP_${status}`;
      const category = ISSUE_CATEGORY[issue] || 'create_error';
      log('error', 'CREATE_FAILED', null, `PayPal refused to create the order: ${issue} (${category}) debug=${debugId}`, { cart, detail: json });
      return send(res, 502, { error: 'paypal_create_failed', issue, category, detail: json });
    }

    const rec = newRecord(json.id, cart, json.create_time || new Date().toISOString());
    orders.set(json.id, rec);
    saveOrders();
    log('info', 'CLOCK1_START', json.id, `${cart.kind === 'donation' ? 'DONATION' : 'order'} created — ${cart.currency} ${cart.total} — clock 1 running, link must be opened by ${clocks(rec).clock1.deadline}`, { status: json.status, kind: cart.kind });

    const approve = (json.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
    send(res, 200, { id: json.id, status: json.status, createTime: json.create_time, approveUrl: approve?.href });
  }

  async function orderEvent(req, res, id) {
    let body;
    try { body = await readJson(req, 20_000); } catch { return send(res, 400, { error: 'bad json' }); }
    const rec = orders.get(id);
    if (!rec) return send(res, 404, { error: 'unknown order' });
    const now = new Date().toISOString();
    switch (body.type) {
      case 'PAYER_LANDED':
        if (!rec.landedAt) {
          rec.landedAt = now;
          log('info', 'CLOCK2_START', id, `buyer landed on PayPal's page — clock 1 satisfied, clock 2 running, must pay + capture by ${clocks(rec).clock2.deadline}`);
        }
        break;
      case 'APPROVED':
        rec.approvedAt = rec.approvedAt || now; rec.status = 'APPROVED';
        if (body.fundingSource) rec.fundingSource = String(body.fundingSource).slice(0, 40);
        log('info', 'APPROVED', id, `buyer tapped Pay Now${rec.fundingSource ? ` via ${rec.fundingSource}` : ''} — capturing`);
        break;
      case 'CANCELLED':
        rec.cancelledAt = now; rec.status = 'CANCELLED';
        log('warn', 'CANCELLED', id, 'buyer closed the PayPal window without paying (order still valid until clock ends)');
        break;
      case 'SDK_ERROR':
        log('error', 'SDK_ERROR', id, `PayPal button error in the browser: ${String(body.message || '').slice(0, 300)}`);
        break;
      case 'INSTRUMENT_RESTART':
        log('warn', 'FUNDING_RETRY', id, 'funding source declined — PayPal reopened the funding screen for another attempt');
        break;
      default:
        return send(res, 400, { error: 'unknown event type' });
    }
    saveOrders();
    send(res, 200, { ok: true, clocks: clocks(rec) });
  }

  async function captureOrder(req, res, id) {
    const rec = orders.get(id) || orders.set(id, newRecord(id, null, new Date().toISOString())).get(id);
    if (!rec.approvedAt) rec.approvedAt = new Date().toISOString();

    if (rec.capture && (rec.status === 'COMPLETED' || rec.status === 'PENDING')) {
      log('info', 'CAPTURE_REPLAY', id, `capture requested again — returning the original ${rec.status} result`);
      return send(res, 200, { status: rec.status, orderId: id, captureId: rec.capture.id, amount: rec.capture.amount, reason: rec.capture.pendingReason });
    }

    let out;
    try { out = await paypal('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, undefined, { 'PayPal-Request-Id': `capture-${id}` }); }
    catch { return send(res, 502, { error: 'paypal_unreachable' }); }
    const { ok, status, json, debugId } = out;

    if (ok && json.status === 'COMPLETED') {
      const cap = json.purchase_units?.[0]?.payments?.captures?.[0] || {};
      rec.capture = { id: cap.id, status: cap.status, amount: cap.amount, payer: json.payer?.email_address, payerId: json.payer?.payer_id, shipping: json.purchase_units?.[0]?.shipping, pendingReason: cap.status_details?.reason };
      if (cap.status === 'COMPLETED') {
        rec.status = 'COMPLETED'; rec.capturedAt = new Date().toISOString();
        const took = rec.landedAt ? Math.round((Date.parse(rec.capturedAt) - Date.parse(rec.landedAt)) / 1000) : null;
        log('info', 'CLOCK2_END', id, `captured ${cap.amount?.currency_code} ${cap.amount?.value} (capture ${cap.id})${took !== null ? ` — ${took}s after landing` : ''} — money moved`);
        return send(res, 200, { status: 'COMPLETED', orderId: id, captureId: cap.id, amount: cap.amount });
      }
      if (cap.status === 'PENDING') {
        rec.status = 'PENDING'; rec.capturedAt = new Date().toISOString();
        log('warn', 'CAPTURE_PENDING', id, `capture ${cap.id} is PENDING — reason ${cap.status_details?.reason || 'unknown'} (held by PayPal / account action needed)`, cap.status_details);
        return send(res, 200, { status: 'PENDING', orderId: id, captureId: cap.id, amount: cap.amount, reason: cap.status_details?.reason });
      }
      rec.status = 'DECLINED'; rec.failedAt = new Date().toISOString();
      rec.failure = { issue: cap.status, category: 'risk', recoverable: false };
      log('error', 'CAPTURE_DECLINED', id, `capture ${cap.id} came back ${cap.status} — PayPal declined at capture time`, cap.status_details);
      return send(res, 400, { status: 'FAILED', issue: cap.status, category: 'risk', recoverable: false, instrumentDeclined: false });
    }

    const issue = json.details?.[0]?.issue || json.name || `HTTP_${status}`;
    const category = ISSUE_CATEGORY[issue] || 'other';
    const recoverable = RECOVERABLE.has(category);
    const instrumentDeclined = issue === 'INSTRUMENT_DECLINED';
    rec.status = 'FAILED'; rec.failedAt = new Date().toISOString();
    rec.failure = { issue, category, recoverable };
    const level = category === 'merchant_account' || category === 'risk' ? 'error' : 'warn';
    log(level, 'CAPTURE_FAILED', id, `${issue} → ${CATEGORY_WHY[category] || 'unclassified PayPal error'} debug=${debugId}`, json);
    send(res, instrumentDeclined ? 422 : recoverable ? 410 : 400, { status: 'FAILED', issue, category, recoverable, instrumentDeclined, detail: json });
  }

  async function getOrder(_req, res, id) {
    let out;
    try { out = await paypal('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`); }
    catch { return send(res, 502, { error: 'paypal_unreachable' }); }
    const rec = orders.get(id);
    send(res, out.status, { paypal: out.json, local: rec ? { ...rec, clocks: clocks(rec) } : null });
  }

  async function webhook(req, res) {
    let event;
    try { event = await readJson(req); } catch { res.writeHead(400); return res.end(); }

    if (C.WEBHOOK_ID) {
      let verify;
      try {
        verify = await paypal('POST', '/v1/notifications/verify-webhook-signature', {
          auth_algo: req.headers['paypal-auth-algo'], cert_url: req.headers['paypal-cert-url'],
          transmission_id: req.headers['paypal-transmission-id'], transmission_sig: req.headers['paypal-transmission-sig'],
          transmission_time: req.headers['paypal-transmission-time'], webhook_id: C.WEBHOOK_ID, webhook_event: event,
        });
      } catch { res.writeHead(502); return res.end(); }
      if (!verify.ok || verify.json.verification_status !== 'SUCCESS') {
        log('error', 'WEBHOOK_BAD_SIGNATURE', null, `rejected a webhook whose signature did not verify (event ${event.event_type})`);
        res.writeHead(400); return res.end();
      }
    } else {
      log('warn', 'WEBHOOK_UNVERIFIED', null, 'PAYPAL_WEBHOOK_ID not set — accepting webhook without signature check (dev only)');
    }

    const resource = event.resource || {};
    const orderId = resource.supplementary_data?.related_ids?.order_id || resource.id || null;
    const t = event.event_type || 'UNKNOWN';
    const m = {
      'PAYMENT.CAPTURE.COMPLETED': ['info', `PayPal confirms capture ${resource.id} completed`],
      'PAYMENT.CAPTURE.PENDING': ['warn', `PayPal reports capture ${resource.id} PENDING: ${resource.status_details?.reason || ''}`],
      'PAYMENT.CAPTURE.DENIED': ['error', `PayPal DENIED capture ${resource.id} after the fact — money will not settle`],
      'PAYMENT.CAPTURE.DECLINED': ['error', `PayPal declined capture ${resource.id}`],
      'PAYMENT.CAPTURE.REVERSED': ['error', `capture ${resource.id} REVERSED (chargeback/unauthorised)`],
      'PAYMENT.CAPTURE.REFUNDED': ['warn', `capture ${resource.id} refunded`],
      'CUSTOMER.DISPUTE.CREATED': ['error', `DISPUTE opened ${resource.dispute_id || ''} — reply in the Resolution Center`],
      'CUSTOMER.DISPUTE.UPDATED': ['warn', `dispute ${resource.dispute_id || ''} updated`],
      'CUSTOMER.DISPUTE.RESOLVED': ['info', `dispute ${resource.dispute_id || ''} resolved`],
      'RISK.DISPUTE.CREATED': ['error', `risk dispute created on ${resource.id || ''}`],
    }[t] || ['info', t];
    log(m[0], `WEBHOOK_${t}`, orderId, m[1], { id: event.id });
    res.writeHead(200); res.end();
  }

  function liveList(now) {
    return [...orders.values()].map((r) => ({ r, c: clocks(r, now) }))
      .filter(({ c }) => ['clock1', 'clock2', 'approved_awaiting_capture'].includes(c.phase))
      .map(({ r, c }) => ({
        id: r.id, kind: r.cart?.kind || 'checkout', amount: r.cart ? `${r.cart.currency} ${r.cart.total}` : null, reference: r.cart?.reference || null,
        phase: c.phase,
        clock1: { startedAt: c.clock1.startedAt, endsAt: c.clock1.deadline, endedAt: c.clock1.endedAt, remainingSeconds: Math.round(c.clock1.remainingMs / 1000) },
        clock2: c.clock2 ? { startedAt: c.clock2.startedAt, endsAt: c.clock2.deadline, remainingSeconds: Math.round(c.clock2.remainingMs / 1000) } : null,
        approvedAt: r.approvedAt,
      }));
  }

  function monitor(_req, res, url) {
    const since = url.searchParams.get('since');
    const now = Date.now();
    const list = [...orders.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 200)
      .map((r) => ({ id: r.id, kind: r.cart?.kind || 'checkout', amount: r.cart ? `${r.cart.currency} ${r.cart.total}` : '', reference: r.cart?.reference || null, status: r.status, fundingSource: r.fundingSource, failure: r.failure, capture: r.capture && { id: r.capture.id, status: r.capture.status, pendingReason: r.capture.pendingReason }, createdAt: r.createdAt, landedAt: r.landedAt, approvedAt: r.approvedAt, capturedAt: r.capturedAt, clocks: clocks(r, now) }));
    const counts = { created: 0, donations: 0, landed: 0, approved: 0, completed: 0, pending: 0, cancelled: 0, expired: 0, failed_buyer: 0, failed_merchant: 0, failed_risk: 0, failed_other: 0 };
    for (const r of orders.values()) {
      counts.created++;
      if (r.cart?.kind === 'donation') counts.donations++;
      if (r.landedAt) counts.landed++;
      if (r.approvedAt) counts.approved++;
      if (r.status === 'COMPLETED') counts.completed++;
      else if (r.status === 'PENDING') counts.pending++;
      else if (r.status === 'CANCELLED') counts.cancelled++;
      else if (r.failure) {
        const c = r.failure.category;
        if (c === 'expired' || c === 'not_approved') counts.expired++;
        else if (c.startsWith('buyer')) counts.failed_buyer++;
        else if (c === 'merchant_account') counts.failed_merchant++;
        else if (c === 'risk') counts.failed_risk++;
        else counts.failed_other++;
      } else if (clocks(r, now).phase.endsWith('_expired')) counts.expired++;
    }
    const evs = since ? events.filter((e) => e.t > since) : events.slice(-300);
    send(res, 200, { now: new Date(now).toISOString(), env: C.ENV, windowHours: C.WINDOW_MS / 3600_000, webhookVerified: !!C.WEBHOOK_ID, counts, orders: list, events: evs.map((e) => ({ t: e.t, level: e.level, type: e.type, orderId: e.orderId, msg: e.msg })) });
  }

  // =========================================================================
  // Router — called by src/server.js for any path under /paypal
  // =========================================================================
  async function handle(req, res, url) {
    const p = (url.pathname.replace(/\/+$/, '').slice(PREFIX.length)) || '/';
    try {
      if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true, module: 'paypal', enabled, env: C.ENV, donations: DONATIONS_ENABLED });
      if (!enabled) return send(res, 503, { error: 'paypal_not_configured', hint: 'set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET' });

      if (req.method === 'GET' && p === '/api/config') return send(res, 200, {
        clientId: C.CLIENT_ID, env: C.ENV, brand: C.BRAND_NAME, currency: C.DEFAULT_CURRENCY, base: PREFIX,
        donations: DONATIONS_ENABLED ? { charity: C.CHARITY_NAME, presets: C.DONATION_PRESETS, min: C.DONATION_MIN } : null,
      });
      if (req.method === 'POST' && p === '/api/orders') return await createOrder(req, res);
      let m;
      if (req.method === 'POST' && (m = p.match(/^\/api\/orders\/([^/]+)\/capture$/))) return await captureOrder(req, res, decodeURIComponent(m[1]));
      if (req.method === 'POST' && (m = p.match(/^\/api\/orders\/([^/]+)\/events$/))) return await orderEvent(req, res, decodeURIComponent(m[1]));
      if (req.method === 'GET' && (m = p.match(/^\/api\/orders\/([^/]+)$/))) return await getOrder(req, res, decodeURIComponent(m[1]));
      if (req.method === 'POST' && p === '/api/webhooks/paypal') return await webhook(req, res);
      if (p === '/api/live' || p === '/api/monitor' || p === '/monitor') {
        if (!monitorAuthorised(req, url)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end(`monitor token required: ${PREFIX}/monitor?token=...`); }
        if (p === '/api/live') { const now = Date.now(); const live = liveList(now); return send(res, 200, { now: new Date(now).toISOString(), running: live.length, checkouts: live }); }
        if (p === '/api/monitor') return monitor(req, res, url);
        return servePage(res, 'monitor');
      }
      if (req.method === 'GET' && p === '/return') {
        res.writeHead(302, { Location: `${PREFIX}/success?order=${encodeURIComponent(url.searchParams.get('token') || '')}&capture=1` });
        return res.end();
      }
      if (req.method === 'GET' && (p === '/' || p === '/index')) return servePage(res, 'index');
      if (req.method === 'GET' && ['/checkout', '/donate', '/success'].includes(p)) return servePage(res, p.slice(1));
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
    } catch (e) {
      log('error', 'SERVER_ERROR', null, `${req.method} ${PREFIX}${p}: ${e.message}`);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    }
  }

  log('info', 'BOOT', null, enabled
    ? `PayPal module (${C.ENV}) mounted at ${PREFIX} — window ${C.WINDOW_MS / 3600_000}h — webhook ${C.WEBHOOK_ID ? 'verified' : 'UNVERIFIED (set PAYPAL_WEBHOOK_ID)'} — monitor ${C.MONITOR_TOKEN ? 'protected' : 'OPEN (set PAYPAL_MONITOR_TOKEN)'} — donations ${DONATIONS_ENABLED ? 'on' : 'off'} — data ${C.DATA_DIR} — ${orders.size} order(s) reloaded`
    : `PayPal module NOT configured (no PAYPAL_CLIENT_ID/SECRET) — ${PREFIX}/* answers 503, rest of the service unaffected`);

  return { handle, enabled, prefix: PREFIX };
}

module.exports = { create, PREFIX };
