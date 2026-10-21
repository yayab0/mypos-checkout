'use strict';
// Smoke test for the PayPal module mounted inside the real server, against a local mock of PayPal's API.
// Proves: myPOS routes still answer, /paypal/* works under the prefix, both order kinds, clocks, failures, persistence.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// ---- mock PayPal ----
const mockOrders = new Map(); let n = 0;
const sendJ = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d ? JSON.parse(d) : {})); });
const mock = http.createServer(async (req, res) => {
  const u = req.url;
  if (u === '/v1/oauth2/token') return sendJ(res, 200, { access_token: 'mock', expires_in: 32000 });
  if (u === '/v2/checkout/orders' && req.method === 'POST') {
    const b = await body(req); const id = `MOCK${++n}`;
    const o = { id, status: 'PAYER_ACTION_REQUIRED', create_time: new Date().toISOString(), purchase_units: b.purchase_units, received: b, links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
    mockOrders.set(id, o); return sendJ(res, 201, o);
  }
  let m;
  if ((m = u.match(/^\/v2\/checkout\/orders\/([^/]+)\/approve$/))) { mockOrders.get(m[1]).status = 'APPROVED'; return sendJ(res, 200, {}); }
  if ((m = u.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/))) {
    const id = m[1];
    if (id === 'EXPIRED') return sendJ(res, 404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
    if (id === 'DECLINED') return sendJ(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
    if (id === 'RESTRICTED') return sendJ(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'PAYEE_ACCOUNT_RESTRICTED' }] });
    const o = mockOrders.get(id);
    if (!o) return sendJ(res, 404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
    if (o.status !== 'APPROVED') return sendJ(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
    o.status = 'COMPLETED'; const amt = o.purchase_units[0].amount;
    return sendJ(res, 201, { id, status: 'COMPLETED', payer: { email_address: 'b@x.com' }, purchase_units: [{ payments: { captures: [{ id: `CAP${id}`, status: 'COMPLETED', amount: amt }] } }] });
  }
  if ((m = u.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) { const o = mockOrders.get(m[1]); return o ? sendJ(res, 200, o) : sendJ(res, 404, {}); }
  sendJ(res, 404, { name: 'NOT_FOUND' });
});

(async () => {
  await new Promise((r) => mock.listen(0, r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-pp-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, {
    PORT: '0', APP_URL: 'http://localhost:0', DB_PATH: path.join(tmp, 'db.sqlite'),
    ADMIN_USER: 'a', ADMIN_PASSWORD: 'b', SHOPIFY_API_KEY: 'key', SHOPIFY_API_SECRET: 'secret',
    MYPOS_SID: '000000000000010', MYPOS_WALLET: '61938166610', MYPOS_KEY_INDEX: '1',
    MYPOS_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }), MYPOS_PUBLIC_CERT: publicKey.export({ type: 'spki', format: 'pem' }), MYPOS_SANDBOX: '1',
    PAYPAL_API_BASE: `http://127.0.0.1:${mock.address().port}`, PAYPAL_CLIENT_ID: 't', PAYPAL_CLIENT_SECRET: 't',
    PAYPAL_MONITOR_TOKEN: 'secret123', PAYPAL_CHARITY_NAME: 'Hope Foundation', PAYPAL_DATA_DIR: tmp,
  });
  const server = require('../src/server');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, data, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data), redirect: 'manual' });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };

  // myPOS routes still answer
  let r = await call('GET', '/health'); assert.equal(r.status, 200); assert.equal(r.json.service, 'mypos-checkout');
  r = await call('GET', '/admin'); assert.equal(r.status, 401);
  r = await call('GET', '/nope'); assert.equal(r.status, 404);

  // module health + config under prefix
  r = await call('GET', '/paypal/healthz'); assert.equal(r.status, 200); assert.equal(r.json.enabled, true); assert.equal(r.json.donations, true);
  r = await call('GET', '/paypal/api/config'); assert.equal(r.json.base, '/paypal'); assert.equal(r.json.donations.charity, 'Hope Foundation');

  // pages served with prefix substituted
  for (const pg of ['/paypal/checkout', '/paypal/donate', '/paypal/success', '/paypal/']) {
    r = await call('GET', pg); assert.equal(r.status, 200, pg); assert.ok(!r.text.includes('__BASE__'), `${pg} still has __BASE__`); assert.ok(r.text.includes('/paypal/api/') || r.text.includes('/paypal/checkout'), pg);
  }
  r = await call('GET', '/paypal/monitor'); assert.equal(r.status, 401);
  r = await call('GET', '/paypal/monitor?token=secret123'); assert.equal(r.status, 200);

  // checkout order → PHYSICAL_GOODS, shipping, brand
  r = await call('POST', '/paypal/api/orders', { items: [{ name: 'Skillet', price: '39.00', quantity: 2 }], shipping: '4.99', reference: 'T-1' });
  assert.equal(r.status, 200); const cid = r.json.id;
  let got = mockOrders.get(cid).received;
  assert.equal(got.purchase_units[0].items[0].category, 'PHYSICAL_GOODS');
  assert.equal(got.purchase_units[0].amount.value, '82.99');
  assert.equal(got.payment_source.paypal.experience_context.shipping_preference, 'GET_FROM_FILE');
  assert.ok(got.payment_source.paypal.experience_context.return_url.endsWith('/paypal/return'));

  // donation order → DONATION, no shipping, charity brand
  r = await call('POST', '/paypal/api/orders', { kind: 'donation', amount: '25', message: 'hi' });
  assert.equal(r.status, 200); const did = r.json.id;
  got = mockOrders.get(did).received;
  assert.equal(got.purchase_units[0].items[0].category, 'DONATION');
  assert.equal(got.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');
  assert.equal(got.payment_source.paypal.experience_context.brand_name, 'Hope Foundation');
  assert.equal(got.purchase_units[0].amount.breakdown.shipping, undefined);

  // clocks: land → approve → capture
  r = await call('POST', `/paypal/api/orders/${cid}/events`, { type: 'PAYER_LANDED' }); assert.equal(r.json.clocks.phase, 'clock2');
  await fetch(`${process.env.PAYPAL_API_BASE}/v2/checkout/orders/${cid}/approve`, { method: 'POST' });
  r = await call('POST', `/paypal/api/orders/${cid}/capture`); assert.equal(r.json.status, 'COMPLETED'); assert.equal(r.json.captureId, `CAP${cid}`);
  r = await call('POST', `/paypal/api/orders/${cid}/capture`); assert.equal(r.json.status, 'COMPLETED'); // replay-safe

  // failure classification
  r = await call('POST', '/paypal/api/orders/EXPIRED/capture'); assert.equal(r.status, 410); assert.equal(r.json.category, 'expired');
  r = await call('POST', '/paypal/api/orders/DECLINED/capture'); assert.equal(r.status, 422); assert.equal(r.json.instrumentDeclined, true);
  r = await call('POST', '/paypal/api/orders/RESTRICTED/capture'); assert.equal(r.status, 400); assert.equal(r.json.category, 'merchant_account');
  r = await call('POST', '/paypal/api/orders', { kind: 'donation', amount: '0.5' }); assert.equal(r.status, 400);

  // monitor + live
  r = await call('GET', '/paypal/api/monitor?token=secret123');
  assert.equal(r.json.counts.created, 5); /* 2 real + 3 capture-only stubs */ assert.equal(r.json.counts.donations, 1); assert.equal(r.json.counts.completed, 1); assert.equal(r.json.counts.failed_merchant, 1);
  r = await call('GET', '/paypal/api/live?token=secret123'); assert.equal(r.json.running, 1); assert.equal(r.json.checkouts[0].id, did);

  // redirect-flow landing
  r = await call('GET', '/paypal/return?token=ABC'); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/paypal/success?order=ABC&capture=1');

  // webhook accepted (unverified mode)
  r = await call('POST', '/paypal/api/webhooks/paypal', { id: 'WH', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: `CAP${cid}`, supplementary_data: { related_ids: { order_id: cid } } } }); assert.equal(r.status, 200);

  // persistence files written on the data dir
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(fs.existsSync(path.join(tmp, 'paypal-orders.json')), 'orders file');
  assert.ok(fs.existsSync(path.join(tmp, 'paypal-events.jsonl')), 'events file');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'paypal-orders.json'), 'utf8')).length, 5);

  console.log('paypal module: all checks passed');
  server.close(); mock.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
