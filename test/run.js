'use strict';
// End-to-end smoke test with a fake Shopify store and a fake myPOS callback.
// Runs the real server on a random port with generated RSA keys and a temp database.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const myposPriv = privateKey.export({ type: 'pkcs1', format: 'pem' });
const myposPub = publicKey.export({ type: 'spki', format: 'pem' });

Object.assign(process.env, {
  PORT: '0', APP_URL: 'http://localhost:0', DB_PATH: path.join(tmp, 'db.sqlite'),
  ADMIN_USER: 'a', ADMIN_PASSWORD: 'b',
  SHOPIFY_API_KEY: 'key', SHOPIFY_API_SECRET: 'secret',
  MYPOS_SID: '000000000000010', MYPOS_WALLET: '61938166610', MYPOS_KEY_INDEX: '1',
  MYPOS_PRIVATE_KEY: myposPriv, MYPOS_PUBLIC_CERT: myposPub, MYPOS_SANDBOX: '1',
});

const config = require('../src/config');
const { shops, orders } = require('../src/db');
const shopify = require('../src/shopify');
const mypos = require('../src/mypos');

// Stub the Admin API calls so no network is needed.
shopify.priceCart = async (_shop, items) => items.map((i) => ({ variantId: `gid://shopify/ProductVariant/${i.variantId}`, title: `Product ${i.variantId}`, quantity: Number(i.quantity), price: 12.5, sku: '' }));
let createdOrders = [];
shopify.createPaidOrder = async (_shop, args) => { createdOrders.push(args); return { id: 'gid://shopify/Order/999', name: '#1001' }; };

const server = require('../src/server');

function proxyQuery(params) {
  const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  const signature = crypto.createHmac('sha256', 'secret').update(msg).digest('hex');
  return new URLSearchParams({ ...params, signature }).toString();
}

(async () => {
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;
  shops.upsert({ shop: 'test-store.myshopify.com', access_token: 'tok', name: 'Test Store', primary_domain: 'https://www.test-store.com', currency: 'GBP' });
  shops.setShipping('test-store.myshopify.com', 'Delivery', 3.45);

  // 1. health
  const h = await (await fetch(`${base}/health`)).json();
  assert.equal(h.ok, true); assert.equal(h.mypos, 'sandbox');

  // 2. proxy signature rejected when wrong
  const bad = await fetch(`${base}/proxy?shop=test-store.myshopify.com&signature=deadbeef`);
  assert.equal(bad.status, 403);

  // 3. checkout page renders as liquid
  const q = proxyQuery({ shop: 'test-store.myshopify.com', path_prefix: '/apps/pay', timestamp: String(Math.floor(Date.now() / 1000)) });
  const page = await fetch(`${base}/proxy?${q}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /application\/liquid/);
  const html = await page.text();
  assert.match(html, /cart\.items/); assert.match(html, /Delivery/);

  // 4. create purchase -> auto-submit form to myPOS sandbox with correct totals + valid signature (redirect mode)
  const form = new URLSearchParams({ cart: JSON.stringify([{ variantId: 111, quantity: 2 }, { variantId: 222, quantity: 1 }]), email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe', address: '1 High St', city: 'London', zip: 'E1 6AN', country: 'GB', phone: '' });
  config.mypos.mode = 'redirect';
  const create = await fetch(`${base}/proxy/create?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  assert.equal(create.status, 200);
  const chtml = await create.text();
  assert.match(chtml, /action="https:\/\/www\.mypos\.com\/vmp\/checkout-test\/"/);
  const vals = Object.fromEntries([...chtml.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<')]));
  assert.equal(vals.Amount, '40.95'); // 2*12.50 + 12.50 + 3.45
  assert.equal(vals.CartItems, '3'); assert.equal(vals.Currency_1, 'GBP'); assert.equal(vals.customercountry, 'GBR');
  const orderId = vals.OrderID; assert.ok(orderId.startsWith('MP'));
  const ordered = [...chtml.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<')]);
  assert.ok(mypos.verify(ordered.filter(([k]) => k !== 'Signature'), vals.Signature, myposPub), 'purchase signature must verify');
  assert.equal(orders.get(orderId).status, 'created');

  // 5. notify with bad signature -> 400, order untouched
  const notifyPairs = [['IPCmethod', 'IPCPurchaseNotify'], ['IPCVersion', '1.4'], ['Amount', '40.95'], ['Currency', 'GBP'], ['OrderID', orderId], ['IPC_Trnref', '12345678923'], ['RequestDateTime', '2026-10-18 00:00:00'], ['RequestSTAN', '000123'], ['PAN', '4885'], ['Status', '0']];
  let body = new URLSearchParams([...notifyPairs, ['Signature', 'bogus']]);
  let n = await fetch(`${base}/mypos/notify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  assert.equal(n.status, 400); assert.equal(orders.get(orderId).status, 'created');

  // 6. notify with wrong amount -> 400
  const tampered = notifyPairs.map(([k, v]) => [k, k === 'Amount' ? '1.00' : v]);
  body = new URLSearchParams([...tampered, ['Signature', mypos.sign(tampered, myposPriv)]]);
  n = await fetch(`${base}/mypos/notify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  assert.equal(n.status, 400);
  orders.setStatus(orderId, 'created');

  // 7. valid notify -> "OK", order paid, Shopify order created
  body = new URLSearchParams([...notifyPairs, ['Signature', mypos.sign(notifyPairs, myposPriv)]]);
  n = await fetch(`${base}/mypos/notify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  assert.equal(n.status, 200); assert.equal(await n.text(), 'OK');
  await new Promise((r) => setTimeout(r, 50));
  const o = orders.get(orderId);
  assert.equal(o.status, 'paid'); assert.equal(o.ipc_trnref, '12345678923'); assert.equal(o.shopify_order_name, '#1001');
  assert.equal(createdOrders.length, 1); assert.equal(createdOrders[0].cart.length, 2); assert.equal(createdOrders[0].shipping.amount, 3.45);

  // 8. replay notify is idempotent
  n = await fetch(`${base}/mypos/notify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  assert.equal(n.status, 200); assert.equal(createdOrders.length, 1);

  // 9. return URL bounces to the store's themed thank-you page
  const ok = await fetch(`${base}/mypos/ok?order=${orderId}`, { redirect: 'manual' });
  assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), `https://www.test-store.com/apps/pay/thanks?order=${orderId}`);
  const q2 = proxyQuery({ shop: 'test-store.myshopify.com', path_prefix: '/apps/pay', timestamp: String(Math.floor(Date.now() / 1000)), order: orderId });
  const thanks = await fetch(`${base}/proxy/thanks?${q2}`);
  assert.match(await thanks.text(), /payment received/);

  // 10. embedded mode: create -> bounce to /pay -> themed page with the myPOS SDK call, correct amount, no signature needed
  config.mypos.mode = 'embedded';
  const c2 = await fetch(`${base}/proxy/create?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const c2html = await c2.text();
  const m = c2html.match(/\/apps\/pay\/pay\?order=([A-Z0-9]+)/); assert.ok(m, 'create must bounce to the embedded pay page');
  const q3 = proxyQuery({ shop: 'test-store.myshopify.com', path_prefix: '/apps/pay', timestamp: String(Math.floor(Date.now() / 1000)), order: m[1] });
  const payPage = await fetch(`${base}/proxy/pay?${q3}`);
  assert.match(payPage.headers.get('content-type'), /application\/liquid/);
  const payHtml = await payPage.text();
  assert.match(payHtml, /MyPOSEmbedded\.createPayment\('myPOSEmbeddedCheckout'/);
  assert.match(payHtml, /"amount":40\.95/); assert.match(payHtml, /"sid":"000000000000010"/); assert.match(payHtml, /"isSandbox"|isSandbox: true/);
  assert.match(payHtml, /"cartItems":\[.*"article":"Delivery","quantity":1,"price":3\.45/);
  const hosted = await fetch(`${base}/proxy/hosted?${q3}`);
  assert.match(await hosted.text(), /name="IPCmethod" value="IPCPurchase"/);

  // 11. single-page checkout: page has the form + pay button; /start creates the order and returns SDK params; /details saves the address
  const sp = await fetch(`${base}/proxy?${q}`); const spHtml = await sp.text();
  assert.match(spHtml, /MyPOSEmbedded\.createPaymentForm/); assert.match(spHtml, /id="btn-pay"/); assert.match(spHtml, /\/start/);
  const st = await fetch(`${base}/proxy/start?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ cart: JSON.stringify([{ variantId: 111, quantity: 2 }, { variantId: 222, quantity: 1 }]) }).toString() });
  assert.equal(st.status, 200); const sj = await st.json();
  assert.ok(sj.orderId.startsWith('MP')); assert.equal(sj.params.amount, 40.95); assert.equal(sj.params.orderID, sj.orderId); assert.equal(sj.params.cartItems.length, 3); assert.equal(sj.isSandbox, true);
  const d1 = await fetch(`${base}/proxy/details?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ orderId: sj.orderId, email: 'x' }).toString() });
  assert.equal(d1.status, 400);
  const d2 = await fetch(`${base}/proxy/details?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ orderId: sj.orderId, email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe', address: '1 High St', city: 'London', zip: 'E1', country: 'GB' }).toString() });
  assert.equal(d2.status, 200); assert.equal(JSON.parse(orders.get(sj.orderId).customer_json).city, 'London');
  const emptyStart = await fetch(`${base}/proxy/start?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'cart=[]' });
  assert.equal(emptyStart.status, 400);

  // 12. wallet session + confirm (myPOS calls stubbed): session token returned; confirm marks paid only when myPOS says so
  mypos.paymentSessionCreate = async () => ({ sessionToken: 'tok123' });
  const ws = await fetch(`${base}/proxy/wallet-session?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ orderId: sj.orderId }).toString() });
  assert.deepEqual(await ws.json(), { sessionToken: 'tok123' });
  mypos.paymentStatus = async () => ({ ok: true, paid: false, status: '2', data: {} });
  let cf = await fetch(`${base}/proxy/confirm?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ orderId: sj.orderId }).toString() });
  assert.equal((await cf.json()).paid, false); assert.equal(orders.get(sj.orderId).status, 'created');
  mypos.paymentStatus = async () => ({ ok: true, paid: true, status: '1', data: { Amount: '40.95', Currency: 'GBP', IPC_Trnref: '555' } });
  cf = await fetch(`${base}/proxy/confirm?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ orderId: sj.orderId }).toString() });
  assert.equal((await cf.json()).paid, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(orders.get(sj.orderId).status, 'paid'); assert.equal(orders.get(sj.orderId).ipc_trnref, '555'); assert.equal(createdOrders.length, 2);

  // 13. cross-store cart: landing page with items param, and /resolve mapping SKU/handle -> this store's variants
  shopify.resolveItems = async (_shop, specs) => specs.map((s) => (s.sku === 'GEN-10KW' ? { id: 777, quantity: Number(s.q) } : s.handle === 'shed' ? { id: 888, quantity: Number(s.q) } : { unresolved: s, quantity: Number(s.q) }));
  const specs = encodeURIComponent(JSON.stringify([{ sku: 'GEN-10KW', q: 1 }, { handle: 'shed', variant: 'Grey', q: 2 }, { sku: 'NOPE', q: 1 }]));
  const q4 = proxyQuery({ shop: 'test-store.myshopify.com', path_prefix: '/apps/pay', timestamp: String(Math.floor(Date.now() / 1000)), items: decodeURIComponent(specs) });
  const land = await fetch(`${base}/proxy?${q4}`); const landHtml = await land.text();
  assert.match(land.headers.get('content-type'), /application\/liquid/); assert.match(landHtml, /Preparing your secure checkout/); assert.match(landHtml, /\/resolve/);
  const rs = await fetch(`${base}/proxy/resolve?${q}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ items: decodeURIComponent(specs) }).toString() });
  const rj = await rs.json();
  assert.deepEqual(rj.items, [{ id: 777, quantity: 1 }, { id: 888, quantity: 2 }]); assert.equal(rj.missing.length, 1);

  // 14. admin auth + page
  assert.equal((await fetch(`${base}/admin`)).status, 401);
  const adm = await fetch(`${base}/admin`, { headers: { authorization: 'Basic ' + Buffer.from('a:b').toString('base64') } });
  assert.equal(adm.status, 200); assert.match(await adm.text(), /#1001/);

  console.log('ALL TESTS PASSED');
  server.close(); process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
