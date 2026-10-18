'use strict';
// myPOS Checkout (IPC) client.
// Signing follows the official SDK: join all param VALUES with '-', base64 it,
// RSA-SHA256 sign that base64 string, base64 the signature. Verification is the mirror.
const crypto = require('node:crypto');
const config = require('./config');

const LIVE_URL = 'https://www.mypos.com/vmp/checkout/';
const SANDBOX_URL = 'https://www.mypos.com/vmp/checkout-test/';

// ---------- credentials ----------

function pick(obj, ...names) {
  const keys = Object.keys(obj);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === n);
    if (k && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return String(obj[k]);
  }
  return '';
}

// The myPOS "Configuration Pack" is a base64 blob containing the store settings.
// We decode it defensively: JSON after base64, or URL-encoded pairs.
function parseConfigPack(pack) {
  if (!pack) return null;
  let text;
  try { text = Buffer.from(pack.trim(), 'base64').toString('utf8'); } catch { return null; }
  let obj = null;
  try { obj = JSON.parse(text); } catch { /* not json */ }
  if (!obj) {
    try { obj = Object.fromEntries(new URLSearchParams(text)); } catch { /* not form */ }
  }
  if (!obj || typeof obj !== 'object') return null;
  // flatten one level of nesting
  const flat = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) flat[`${k}_${k2}`] = v2, flat[k2] = flat[k2] ?? v2;
    else flat[k] = v;
  }
  const out = {
    sid: pick(flat, 'sid', 'storeid', 'store'),
    wallet: pick(flat, 'walletnumber', 'wallet', 'clientnumber', 'client', 'cn', 'accountnumber'),
    keyIndex: pick(flat, 'keyindex', 'idx', 'key'),
    privateKey: pick(flat, 'privatekey', 'private', 'pk', 'privkey', 'merchantprivatekey'),
    publicCert: pick(flat, 'publiccertificate', 'publiccert', 'certificate', 'cert', 'pc', 'myposcertificate', 'myposcert', 'apipubliccertificate'),
    sandbox: /test|sandbox|demo/i.test(pick(flat, 'ipcurl', 'url', 'environment', 'env', 'mode')),
    _keys: Object.keys(flat),
  };
  return out;
}

let creds = null;
function credentials() {
  if (creds) return creds;
  const packed = parseConfigPack(config.mypos.configPack) || {};
  const sid = config.mypos.sid || packed.sid;
  const wallet = config.mypos.wallet || packed.wallet;
  const keyIndex = config.mypos.keyIndex || packed.keyIndex || '1';
  const privateKey = config.mypos.privateKey || (packed.privateKey || '').replace(/\\n/g, '\n');
  const publicCert = config.mypos.publicCert || (packed.publicCert || '').replace(/\\n/g, '\n');
  const missing = [];
  if (!sid) missing.push('MYPOS_SID');
  if (!wallet) missing.push('MYPOS_WALLET');
  if (!privateKey) missing.push('MYPOS_PRIVATE_KEY');
  if (!publicCert) missing.push('MYPOS_PUBLIC_CERT');
  creds = {
    sid, wallet, keyIndex, privateKey, publicCert, missing,
    sandbox: config.mypos.sandbox,
    ipcUrl: config.mypos.sandbox ? SANDBOX_URL : LIVE_URL,
    packKeys: packed._keys || [],
  };
  return creds;
}

function isConfigured() { return credentials().missing.length === 0; }

// ---------- signing ----------

function normalisePrivateKey(pemText) {
  // Accept PKCS#1 ("RSA PRIVATE KEY") and PKCS#8 ("PRIVATE KEY"); also bare base64.
  let t = pemText.trim();
  if (!t.includes('-----BEGIN')) {
    t = `-----BEGIN PRIVATE KEY-----\n${t.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
  }
  return crypto.createPrivateKey({ key: t, format: 'pem' });
}

function normalisePublicCert(pemText) {
  let t = pemText.trim();
  if (!t.includes('-----BEGIN')) {
    t = `-----BEGIN CERTIFICATE-----\n${t.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
  }
  // crypto accepts an X.509 certificate PEM or a public key PEM
  try { return crypto.createPublicKey({ key: t, format: 'pem' }); }
  catch { return new crypto.X509Certificate(t).publicKey; }
}

function signatureBase(params) {
  // params: ordered array of [name, value] (Signature excluded)
  const values = params.map(([, v]) => (v === undefined || v === null ? '' : String(v)));
  return Buffer.from(values.join('-'), 'utf8').toString('base64');
}

function sign(params, privateKeyPem) {
  const key = normalisePrivateKey(privateKeyPem);
  const data = Buffer.from(signatureBase(params), 'utf8');
  return crypto.sign('sha256', data, key).toString('base64');
}

function verify(params, signatureB64, publicCertPem) {
  if (!signatureB64) return false;
  const key = normalisePublicCert(publicCertPem);
  const data = Buffer.from(signatureBase(params), 'utf8');
  try { return crypto.verify('sha256', data, key, Buffer.from(signatureB64, 'base64')); }
  catch { return false; }
}

// Verify an incoming myPOS callback (IPCPurchaseNotify / IPCPurchaseOK). `body` is the
// parsed POST body in the order it arrived (URLSearchParams preserves order).
function verifyCallback(orderedPairs) {
  const sigPair = orderedPairs.find(([k]) => k === 'Signature');
  const rest = orderedPairs.filter(([k]) => k !== 'Signature');
  return verify(rest, sigPair ? sigPair[1] : '', credentials().publicCert);
}

// ---------- amounts ----------

const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

// ---------- IPCPurchase (hosted payment page) ----------

/**
 * Build the ordered parameter list for IPCPurchase — same order as the official SDK's Purchase::process().
 * cart: [{title, quantity, price}], customer: {email, phone, firstName, lastName, country(alpha3), city, zip, address}
 */
function buildPurchaseParams({ orderId, currency, cart, customer, note, urls, paymentParametersRequired = 1 }) {
  const c = credentials();
  const total = cart.reduce((s, it) => s + Number(it.price) * Number(it.quantity), 0);
  const p = [];
  p.push(['IPCmethod', 'IPCPurchase']);
  p.push(['IPCVersion', config.mypos.version]);
  p.push(['IPCLanguage', config.mypos.lang]);
  p.push(['SID', c.sid]);
  p.push(['WalletNumber', c.wallet]);
  p.push(['KeyIndex', c.keyIndex]);
  p.push(['Source', config.mypos.source]);
  p.push(['Currency', currency]);
  p.push(['Amount', money(total)]);
  p.push(['OrderID', orderId]);
  p.push(['URL_OK', urls.ok]);
  p.push(['URL_Cancel', urls.cancel]);
  p.push(['URL_Notify', urls.notify]);
  p.push(['Note', note || '']);
  if (paymentParametersRequired !== 3) {
    p.push(['customeremail', customer.email || '']);
    p.push(['customerphone', customer.phone || '']);
    p.push(['customerfirstnames', customer.firstName || '']);
    p.push(['customerfamilyname', customer.lastName || '']);
    p.push(['customercountry', customer.country || '']);
    p.push(['customercity', customer.city || '']);
    p.push(['customerzipcode', customer.zip || '']);
    p.push(['customeraddress', customer.address || '']);
  }
  p.push(['CartItems', String(cart.length)]);
  cart.forEach((it, i) => {
    const n = i + 1;
    p.push([`Article_${n}`, String(it.title).slice(0, 120)]);
    p.push([`Quantity_${n}`, String(it.quantity)]);
    p.push([`Price_${n}`, money(it.price)]);
    p.push([`Amount_${n}`, money(Number(it.price) * Number(it.quantity))]);
    p.push([`Currency_${n}`, currency]);
  });
  p.push(['CardTokenRequest', '0']);
  p.push(['PaymentParametersRequired', String(paymentParametersRequired)]);
  p.push(['PaymentMethod', '']); // empty => myPOS page shows all enabled methods
  p.push(['Signature', sign(p, c.privateKey)]);
  return { params: p, total: money(total), action: c.ipcUrl };
}

// HTML page that auto-submits the signed form to myPOS from the customer's browser.
function purchaseFormHtml(params, action, { title = 'Redirecting to secure payment…' } = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const inputs = params.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#333}
.box{text-align:center}.spin{width:36px;height:36px;border:3px solid #ddd;border-top-color:#333;border-radius:50%;animation:s 1s linear infinite;margin:0 auto 16px}@keyframes s{to{transform:rotate(360deg)}}</style></head>
<body><div class="box"><div class="spin"></div><p>${esc(title)}</p>
<form id="ipcForm" action="${esc(action)}" method="post">${inputs}<noscript><button type="submit">Continue to payment</button></noscript></form></div>
<script>document.getElementById('ipcForm').submit();</script></body></html>`;
}

// ---------- server-to-server calls (refund, status) ----------

async function ipcPost(params) {
  const c = credentials();
  const body = new URLSearchParams();
  for (const [k, v] of params) body.append(k, v);
  const res = await fetch(c.ipcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, text, json };
}

function baseServerParams(method) {
  const c = credentials();
  return [
    ['IPCmethod', method],
    ['IPCVersion', config.mypos.version],
    ['IPCLanguage', config.mypos.lang],
    ['SID', c.sid],
    ['WalletNumber', c.wallet],
    ['KeyIndex', c.keyIndex],
    ['Source', config.mypos.source],
  ];
}

// Refund (full or partial) of a paid transaction. Needs the IPC_Trnref from the notify.
async function refund({ orderId, ipcTrnref, amount, currency }) {
  const c = credentials();
  const p = baseServerParams('IPCRefund');
  p.push(['Currency', currency]);
  p.push(['Amount', money(amount)]);
  p.push(['OrderID', orderId]);
  p.push(['IPC_Trnref', ipcTrnref]);
  p.push(['OutputFormat', 'json']);
  p.push(['Signature', sign(p, c.privateKey)]);
  const r = await ipcPost(p);
  const ok = r.json && (String(r.json.Status) === '0' || /^ok$/i.test(String(r.json.Status)));
  return { ok: !!ok, response: r.json || r.text };
}

// Returns { ok, paid, status, data } — paid is true only when myPOS says PaymentStatus 1 (successful).
async function paymentStatus({ orderId, includeDeclined = false }) {
  const c = credentials();
  const p = baseServerParams('IPCGetPaymentStatus');
  p.push(['OrderID', orderId]);
  p.push(['OutputFormat', 'json']);
  if (includeDeclined) p.push(['get_declined_payments', '1']);
  p.push(['Signature', sign(p, c.privateKey)]);
  const r = await ipcPost(p);
  const d = r.json || {};
  const ok = String(d.Status) === '0';
  const declined = Array.isArray(d.DeclinedPayments) ? d.DeclinedPayments.map((x) => `${x.responseCodeDescription || x.responseCode || 'declined'}${x.responseCode ? ` (${x.responseCode})` : ''}`) : [];
  return { ok, paid: ok && String(d.PaymentStatus) === '1', status: d.PaymentStatus, declined, statusMsg: d.StatusMsg, data: r.json || r.text };
}

// Payment session for the embedded Apple Pay / Google Pay buttons (IPCPaymentSessionCreate). Returns the SessionToken.
async function paymentSessionCreate({ orderId, currency, cart, note }) {
  const c = credentials();
  const total = cart.reduce((s, it) => s + Number(it.price) * Number(it.quantity), 0);
  const p = [
    ['IPCmethod', 'IPCPaymentSessionCreate'],
    ['IPCVersion', config.mypos.version],
    ['IPCLanguage', config.mypos.lang],
    ['OrderID', orderId],
    ['Amount', money(total)],
    ['Currency', currency],
    ['SID', c.sid],
    ['WalletNumber', c.wallet],
    ['KeyIndex', c.keyIndex],
    ['RequestToken', '0'],
    ['Note', note || ''],
    ['CartItems', String(cart.length)],
  ];
  cart.forEach((it, i) => {
    const n = i + 1;
    p.push([`Article_${n}`, String(it.title).slice(0, 120)]);
    p.push([`Quantity_${n}`, String(it.quantity)]);
    p.push([`Price_${n}`, money(it.price)]);
    p.push([`Amount_${n}`, money(Number(it.price) * Number(it.quantity))]);
    p.push([`Currency_${n}`, currency]);
  });
  p.push(['OutputFormat', 'json']);
  p.push(['Signature', sign(p, c.privateKey)]);
  const r = await ipcPost(p);
  const d = r.json || {};
  if (String(d.Status) !== '0' || !d.SessionToken) throw new Error(`Payment session failed: ${d.StatusMsg || r.text.slice(0, 200)}`);
  return { sessionToken: d.SessionToken, expires: d.ExpDate };
}

module.exports = {
  credentials, isConfigured, parseConfigPack,
  sign, verify, verifyCallback, signatureBase,
  buildPurchaseParams, purchaseFormHtml, refund, paymentStatus, paymentSessionCreate, money,
  LIVE_URL, SANDBOX_URL,
};
