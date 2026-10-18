'use strict';
// SQLite storage using Node's built-in node:sqlite (no native build needed).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS shops (
  shop            TEXT PRIMARY KEY,          -- xxx.myshopify.com
  access_token    TEXT NOT NULL,
  scopes          TEXT,
  name            TEXT,
  primary_domain  TEXT,                      -- https://www.example.com
  currency        TEXT,
  shipping_label  TEXT DEFAULT 'Shipping',
  shipping_amount REAL DEFAULT 0,
  installed_at    TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  order_id          TEXT PRIMARY KEY,        -- our OrderID sent to myPOS
  shop              TEXT NOT NULL,
  status            TEXT NOT NULL,           -- created | paid | failed | cancelled | refunded
  amount            REAL NOT NULL,
  currency          TEXT NOT NULL,
  cart_json         TEXT NOT NULL,           -- [{variantId, title, quantity, price}]
  customer_json     TEXT NOT NULL,
  ipc_trnref        TEXT,
  card_last4        TEXT,
  shopify_order_gid TEXT,
  shopify_order_name TEXT,
  shopify_error     TEXT,
  refunded_amount   REAL DEFAULT 0,
  attrs_json        TEXT DEFAULT '{}',          -- {ref, gclid, source} from the referring store
  created_at        TEXT NOT NULL,
  paid_at           TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_shop_created ON orders(shop, created_at DESC);
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  shop       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

try { db.exec("ALTER TABLE orders ADD COLUMN attrs_json TEXT DEFAULT '{}'"); } catch { /* already there */ }

const now = () => new Date().toISOString();

const shops = {
  get: (shop) => db.prepare('SELECT * FROM shops WHERE shop = ?').get(shop) || null,
  all: () => db.prepare('SELECT * FROM shops ORDER BY installed_at').all(),
  upsert(s) {
    const existing = shops.get(s.shop);
    if (existing) {
      db.prepare(`UPDATE shops SET access_token=?, scopes=?, name=?, primary_domain=?, currency=?, updated_at=? WHERE shop=?`)
        .run(s.access_token, s.scopes || '', s.name || existing.name, s.primary_domain || existing.primary_domain, s.currency || existing.currency, now(), s.shop);
    } else {
      db.prepare(`INSERT INTO shops (shop, access_token, scopes, name, primary_domain, currency, installed_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(s.shop, s.access_token, s.scopes || '', s.name || '', s.primary_domain || '', s.currency || '', now(), now());
    }
    return shops.get(s.shop);
  },
  setShipping(shop, label, amount) {
    db.prepare('UPDATE shops SET shipping_label=?, shipping_amount=?, updated_at=? WHERE shop=?').run(label, amount, now(), shop);
  },
  remove: (shop) => db.prepare('DELETE FROM shops WHERE shop = ?').run(shop),
};

const orders = {
  get: (id) => db.prepare('SELECT * FROM orders WHERE order_id = ?').get(id) || null,
  recent: (limit = 100) => db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit),
  // Started but never paid, with an email captured — for abandoned-checkout follow-up.
  abandoned: (limit = 200) => db.prepare(`SELECT * FROM orders WHERE status IN ('created','cancelled') AND customer_json LIKE '%"email":"_%' AND created_at < ? ORDER BY created_at DESC LIMIT ?`)
    .all(new Date(Date.now() - 30 * 60e3).toISOString(), limit),
  create(o) {
    db.prepare(`INSERT INTO orders (order_id, shop, status, amount, currency, cart_json, customer_json, attrs_json, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(o.order_id, o.shop, 'created', o.amount, o.currency, JSON.stringify(o.cart), JSON.stringify(o.customer), JSON.stringify(o.attrs || {}), now(), now());
    return orders.get(o.order_id);
  },
  setCustomer(id, customer) {
    db.prepare('UPDATE orders SET customer_json=?, updated_at=? WHERE order_id=?').run(JSON.stringify(customer), now(), id);
  },
  markPaid(id, { ipc_trnref, card_last4 }) {
    db.prepare(`UPDATE orders SET status='paid', ipc_trnref=?, card_last4=?, paid_at=?, updated_at=? WHERE order_id=?`)
      .run(ipc_trnref || null, card_last4 || null, now(), now(), id);
  },
  setStatus(id, status) {
    db.prepare('UPDATE orders SET status=?, updated_at=? WHERE order_id=?').run(status, now(), id);
  },
  setShopifyOrder(id, gid, name) {
    db.prepare(`UPDATE orders SET shopify_order_gid=?, shopify_order_name=?, shopify_error=NULL, updated_at=? WHERE order_id=?`).run(gid, name, now(), id);
  },
  setShopifyError(id, err) {
    db.prepare('UPDATE orders SET shopify_error=?, updated_at=? WHERE order_id=?').run(String(err).slice(0, 2000), now(), id);
  },
  addRefund(id, amount) {
    db.prepare(`UPDATE orders SET refunded_amount = refunded_amount + ?, status = CASE WHEN refunded_amount + ? >= amount THEN 'refunded' ELSE status END, updated_at=? WHERE order_id=?`)
      .run(amount, amount, now(), id);
  },
};

const oauthStates = {
  put(state, shop) {
    db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(new Date(Date.now() - 15 * 60e3).toISOString());
    db.prepare('INSERT OR REPLACE INTO oauth_states (state, shop, created_at) VALUES (?,?,?)').run(state, shop, now());
  },
  take(state) {
    const row = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
    if (row) db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    return row || null;
  },
};

module.exports = { db, shops, orders, oauthStates };
