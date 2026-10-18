'use strict';
// Central configuration: reads env vars (and an optional .env file for local runs).
const fs = require('node:fs');
const path = require('node:path');

function loadDotEnv() {
  const p = path.join(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
// PEM values pasted into a single-line env var often arrive with literal "\n".
const pem = (v) => (v || '').replace(/\\n/g, '\n').trim();

const config = {
  port: Number(env('PORT', '10000')),
  appUrl: env('APP_URL', 'http://localhost:10000').replace(/\/+$/, ''),
  dbPath: env('DB_PATH', path.join(process.cwd(), 'data', 'mypos-checkout.sqlite')),

  admin: { user: env('ADMIN_USER', 'admin'), password: env('ADMIN_PASSWORD', '') },

  shopify: {
    apiKey: env('SHOPIFY_API_KEY'),
    apiSecret: env('SHOPIFY_API_SECRET'),
    scopes: env('SHOPIFY_SCOPES', 'write_orders,read_products'),
    apiVersion: env('SHOPIFY_API_VERSION', '2025-07'),
    proxyPrefix: env('PROXY_PREFIX', 'apps'),
    proxySubpath: env('PROXY_SUBPATH', 'pay'),
  },

  mypos: {
    configPack: env('MYPOS_CONFIG_PACK'),
    sid: env('MYPOS_SID'),
    wallet: env('MYPOS_WALLET'),
    keyIndex: env('MYPOS_KEY_INDEX'),
    privateKey: pem(env('MYPOS_PRIVATE_KEY')),
    publicCert: pem(env('MYPOS_PUBLIC_CERT')),
    sandbox: env('MYPOS_SANDBOX', '1') !== '0',
    lang: env('MYPOS_LANG', 'EN'),
    // embedded = card form inside /apps/pay (myPOS Embedded SDK); redirect = myPOS hosted page
    mode: env('CHECKOUT_MODE', 'embedded') === 'redirect' ? 'redirect' : 'embedded',
    embeddedSdkUrl: env('MYPOS_EMBEDDED_SDK_URL', 'https://developers.mypos.com/repository/mypos-embedded-sdk.js'),
    version: '1.4',
    source: 'mypos-checkout-shopify',
  },
};

config.proxyPath = `/${config.shopify.proxyPrefix}/${config.shopify.proxySubpath}`;

module.exports = config;
