'use strict';
// Shopify: OAuth install, request signature checks (OAuth + app proxy), Admin GraphQL helpers.
const crypto = require('node:crypto');
const config = require('./config');

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const isValidShop = (s) => typeof s === 'string' && SHOP_RE.test(s);

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// ---------- OAuth ----------

function oauthStartUrl(shop, state) {
  const u = new URL(`https://${shop}/admin/oauth/authorize`);
  u.searchParams.set('client_id', config.shopify.apiKey);
  u.searchParams.set('scope', config.shopify.scopes);
  u.searchParams.set('redirect_uri', `${config.appUrl}/auth/callback`);
  u.searchParams.set('state', state);
  return u.toString();
}

// Verify the hmac on an OAuth callback / embedded-app request.
function verifyOauthHmac(query) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const keys = Object.keys(rest).sort();
  // Shopify documents an escaped form (& % = in keys/values → %26 %25 %3D); accept plain or escaped.
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D');
  const variants = [
    keys.map((k) => `${k}=${rest[k]}`).join('&'),
    keys.map((k) => `${esc(k)}=${esc(rest[k])}`).join('&'),
  ];
  return variants.some((msg) => safeEqual(crypto.createHmac('sha256', config.shopify.apiSecret).update(msg).digest('hex'), hmac));
}

async function exchangeToken(shop, code) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: config.shopify.apiKey, client_secret: config.shopify.apiSecret, code }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json(); // { access_token, scope }
}

// ---------- App proxy ----------
// Shopify signs proxied requests: sort query params, concatenate "key=value" (arrays joined
// by ","), no separators, HMAC-SHA256 with the app secret, hex, compared to `signature`.
function verifyProxySignature(query) {
  const { signature, ...rest } = query;
  if (!signature) return false;
  const msg = Object.keys(rest).sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('');
  const digest = crypto.createHmac('sha256', config.shopify.apiSecret).update(msg).digest('hex');
  return safeEqual(digest, signature);
}

// ---------- Admin GraphQL ----------

async function graphql(shopRow, query, variables = {}) {
  const res = await fetch(`https://${shopRow.shop}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': shopRow.access_token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
  if (body.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(body.errors).slice(0, 500)}`);
  return body.data;
}

async function fetchShopInfo(shopRow) {
  const d = await graphql(shopRow, `{ shop { name currencyCode primaryDomain { url } } }`);
  return { name: d.shop.name, currency: d.shop.currencyCode, primary_domain: d.shop.primaryDomain.url.replace(/\/+$/, '') };
}

const toVariantGid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/ProductVariant/${id}`);

// Re-price the cart from the store itself so the browser can never set prices.
// items: [{variantId, quantity}] -> [{variantId(gid), title, quantity, price, sku}]
async function priceCart(shopRow, items) {
  const ids = [...new Set(items.map((i) => toVariantGid(i.variantId)))];
  const d = await graphql(shopRow, `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant { id title sku price availableForSale product { title } } } }`, { ids });
  const byId = new Map();
  for (const n of d.nodes || []) if (n && n.id) byId.set(n.id, n);
  const out = [];
  for (const it of items) {
    const gid = toVariantGid(it.variantId);
    const v = byId.get(gid);
    if (!v) throw new Error(`Variant not found: ${it.variantId}`);
    const qty = Math.max(1, Math.min(999, parseInt(it.quantity, 10) || 1));
    const title = v.title && v.title !== 'Default Title' ? `${v.product.title} - ${v.title}` : v.product.title;
    out.push({ variantId: gid, title, quantity: qty, price: Number(v.price), sku: v.sku || '' });
  }
  return out;
}

// Cross-store carts: map items described by SKU (or product handle + variant title) to THIS store's variant IDs.
// specs: [{sku, handle, variant, q}] -> [{id (numeric variant id), quantity, unresolved?}]
async function resolveItems(shopRow, specs) {
  const out = [];
  for (const s of specs.slice(0, 50)) {
    const quantity = Math.max(1, Math.min(999, parseInt(s.q, 10) || 1));
    let id = null;
    if (s.id && /^\d+$/.test(String(s.id))) id = String(s.id); // variant id from a same-catalogue store (redirect app)
    if (!id && s.sku) {
      const d = await graphql(shopRow, `query($q:String!){ productVariants(first:1, query:$q){ nodes { id legacyResourceId } } }`, { q: `sku:"${String(s.sku).replace(/"/g, '')}"` });
      id = d.productVariants.nodes[0]?.legacyResourceId || null;
    }
    if (!id && s.handle) {
      const d = await graphql(shopRow, `query($h:String!){ productByHandle(handle:$h){ variants(first:100){ nodes { id legacyResourceId title } } } }`, { h: String(s.handle) });
      const vs = d.productByHandle?.variants?.nodes || [];
      const want = String(s.variant || '').trim().toLowerCase();
      const v = vs.find((x) => x.title.toLowerCase() === want) || (vs.length === 1 ? vs[0] : null) || (!want ? vs[0] : null);
      id = v?.legacyResourceId || null;
    }
    out.push(id ? { id: Number(id), quantity } : { unresolved: s, quantity });
  }
  return out;
}

// Create the paid order after myPOS confirms payment.
async function createPaidOrder(shopRow, { order, cart, customer, shipping, ipcTrnref, cardLast4, attrs }) {
  const money = (n) => ({ shopMoney: { amount: (Math.round(Number(n) * 100) / 100).toFixed(2), currencyCode: order.currency } });
  const addr = {
    firstName: customer.firstName || '', lastName: customer.lastName || '',
    address1: customer.address || '', city: customer.city || '', zip: customer.zip || '',
    countryCode: customer.countryCode || 'GB', phone: customer.phone || '',
  };
  const input = {
    email: customer.email || null,
    phone: null,
    currency: order.currency,
    financialStatus: 'PAID',
    sourceName: 'myPOS checkout',
    sourceIdentifier: order.order_id,
    note: `Paid via myPOS. OrderID ${order.order_id}${ipcTrnref ? `, IPC_Trnref ${ipcTrnref}` : ''}${cardLast4 ? `, card •••• ${cardLast4}` : ''}`,
    tags: ['myPOS'],
    lineItems: cart.map((c) => ({ variantId: c.variantId, quantity: c.quantity, priceSet: money(c.price) })),
    shippingAddress: addr,
    billingAddress: addr,
    transactions: [{
      kind: 'SALE', status: 'SUCCESS', gateway: 'myPOS',
      amountSet: money(order.amount), authorizationCode: ipcTrnref || null,
      processedAt: new Date().toISOString(),
    }],
    customAttributes: [{ key: 'myPOS OrderID', value: order.order_id }].concat(
      Object.entries(attrs || {}).filter(([k, v]) => v && ['ref', 'gclid', 'source'].includes(k)).map(([k, v]) => ({ key: k, value: String(v).slice(0, 250) }))
    ),
  };
  if (shipping && Number(shipping.amount) > 0) {
    input.shippingLines = [{ title: shipping.label || 'Shipping', code: 'MYPOS_FLAT', priceSet: money(shipping.amount) }];
  }
  const d = await graphql(shopRow, `
    mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order { id name }
        userErrors { field message }
      }
    }`, { order: input, options: { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: true } });
  const r = d.orderCreate;
  if (r.userErrors && r.userErrors.length) throw new Error(`orderCreate: ${r.userErrors.map((e) => e.message).join('; ')}`);
  return r.order; // { id, name }
}

// Record a refund on the Shopify order (money already returned through myPOS).
async function refundShopifyOrder(shopRow, orderGid, amount, currency, note) {
  const d = await graphql(shopRow, `query($id:ID!){ order(id:$id){ transactions(first:10){ id kind status } } }`, { id: orderGid });
  const sale = (d.order?.transactions || []).find((t) => t.kind === 'SALE' && t.status === 'SUCCESS') || {};
  const r = await graphql(shopRow, `
    mutation($input: RefundInput!) {
      refundCreate(input: $input) { refund { id } userErrors { field message } }
    }`, {
    input: {
      orderId: orderGid, note: note || 'Refunded via myPOS', notify: true,
      transactions: [{ orderId: orderGid, kind: 'REFUND', gateway: 'myPOS', amount: (Math.round(Number(amount) * 100) / 100).toFixed(2), parentId: sale.id || null }],
    },
  });
  const errs = r.refundCreate.userErrors || [];
  if (errs.length) throw new Error(`refundCreate: ${errs.map((e) => e.message).join('; ')}`);
  return r.refundCreate.refund;
}

module.exports = {
  isValidShop, oauthStartUrl, verifyOauthHmac, exchangeToken, verifyProxySignature,
  graphql, fetchShopInfo, priceCart, resolveItems, createPaidOrder, refundShopifyOrder, toVariantGid,
};
