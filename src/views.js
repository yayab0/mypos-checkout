'use strict';
// HTML/Liquid templates. Proxy pages are returned as application/liquid so Shopify renders
// them inside the store's own theme layout (header, footer, fonts, colours).
const config = require('./config');
const countries = require('./countries');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
<style>
.mpc{max-width:1100px;margin:0 auto;padding:24px 16px;display:grid;grid-template-columns:1fr;gap:32px}
@media(min-width:900px){.mpc{grid-template-columns:1.1fr .9fr}}
.mpc h2{margin:0 0 16px;font-size:1.3em}
.mpc .card{border:1px solid rgba(0,0,0,.12);border-radius:10px;padding:20px}
.mpc .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.mpc label{display:block;font-size:.85em;margin:10px 0 4px;opacity:.85}
.mpc input,.mpc select{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid rgba(0,0,0,.25);border-radius:8px;font:inherit;background:transparent;color:inherit}
.mpc .item{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid rgba(0,0,0,.08)}
.mpc .item img{width:56px;height:56px;object-fit:cover;border-radius:6px;background:rgba(0,0,0,.05)}
.mpc .item .t{flex:1;font-size:.95em}.mpc .item .t small{display:block;opacity:.65}
.mpc .tot{display:flex;justify-content:space-between;padding:8px 0}.mpc .tot.g{font-weight:700;font-size:1.15em;border-top:1px solid rgba(0,0,0,.12);margin-top:6px;padding-top:12px}
.mpc .btn{width:100%;margin-top:18px;padding:14px;border:0;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;background:#111;color:#fff}
.mpc .btn[disabled]{opacity:.6;cursor:wait}
.mpc .secure{font-size:.8em;opacity:.7;margin-top:12px;text-align:center}
.mpc .err{background:#fdecec;color:#8a1f1f;padding:10px 12px;border-radius:8px;margin-bottom:12px}
.mpc .empty{text-align:center;padding:48px 0}
</style>`;

// The checkout page. Cart comes from Liquid (Shopify renders it in the storefront session).
function checkoutLiquid({ shopRow, error }) {
  const action = `${config.proxyPath}/create`;
  const ship = Number(shopRow.shipping_amount || 0);
  return `${CSS}
<div class="mpc" id="mpc">
{% if cart.item_count == 0 %}
  <div class="card empty" style="grid-column:1/-1"><h2>Your cart is empty</h2><p><a href="/collections/all">Continue shopping</a></p></div>
{% else %}
  <div>
    <h2>Checkout</h2>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form class="card" method="post" action="${action}" id="mpcForm">
      <input type="hidden" name="cart" id="mpcCart" value="">
      <label>Email</label><input type="email" name="email" required autocomplete="email" value="{{ customer.email | escape }}">
      <div class="row">
        <div><label>First name</label><input name="firstName" required autocomplete="given-name" value="{{ customer.first_name | escape }}"></div>
        <div><label>Last name</label><input name="lastName" required autocomplete="family-name" value="{{ customer.last_name | escape }}"></div>
      </div>
      <label>Phone</label><input name="phone" type="tel" autocomplete="tel">
      <label>Address</label><input name="address" required autocomplete="address-line1">
      <div class="row">
        <div><label>City</label><input name="city" required autocomplete="address-level2"></div>
        <div><label>Postcode</label><input name="zip" required autocomplete="postal-code"></div>
      </div>
      <label>Country</label><select name="country" autocomplete="country">${countries.options('GB')}</select>
      <button class="btn" type="submit" id="mpcBtn">Pay {{ cart.total_price | plus: ${Math.round(ship * 100)} | money }}</button>
      <div class="secure">🔒 Secure card payment by myPOS · Visa, Mastercard, Apple Pay, Google Pay</div>
    </form>
  </div>
  <div>
    <h2>Your order</h2>
    <div class="card">
      {% for item in cart.items %}
      <div class="item">
        {% if item.image %}<img src="{{ item.image | image_url: width: 112 }}" alt="">{% else %}<div class="img"></div>{% endif %}
        <div class="t">{{ item.product.title | escape }}{% unless item.variant.title == 'Default Title' %}<small>{{ item.variant.title | escape }}</small>{% endunless %}<small>Qty {{ item.quantity }}</small></div>
        <div>{{ item.final_line_price | money }}</div>
      </div>
      {% endfor %}
      <div class="tot" style="margin-top:12px"><span>Subtotal</span><span>{{ cart.total_price | money }}</span></div>
      <div class="tot"><span>${esc(shopRow.shipping_label || 'Shipping')}</span><span>${ship > 0 ? `{{ ${Math.round(ship * 100)} | money }}` : 'Free'}</span></div>
      <div class="tot g"><span>Total</span><span>{{ cart.total_price | plus: ${Math.round(ship * 100)} | money }}</span></div>
    </div>
  </div>
  <script>
  (function(){
    var items = [{% for item in cart.items %}{"variantId":{{ item.variant_id }},"quantity":{{ item.quantity }}}{% unless forloop.last %},{% endunless %}{% endfor %}];
    document.getElementById('mpcCart').value = JSON.stringify(items);
    document.getElementById('mpcForm').addEventListener('submit', function(){ var b=document.getElementById('mpcBtn'); b.disabled=true; b.textContent='Redirecting to secure payment…'; });
  })();
  </script>
{% endif %}
</div>`;
}

// Embedded payment page: order summary + myPOS card form (iframe) on the store's own domain.
function embeddedPayLiquid({ order, shopRow, creds }) {
  const cart = JSON.parse(order.cart_json || '[]');
  const customer = JSON.parse(order.customer_json || '{}');
  const ship = Number(shopRow.shipping_amount || 0);
  const items = cart.map((c) => ({ article: String(c.title).slice(0, 120), quantity: c.quantity, price: Number(Number(c.price).toFixed(2)), currency: order.currency }));
  if (ship > 0) items.push({ article: shopRow.shipping_label || 'Shipping', quantity: 1, price: Number(ship.toFixed(2)), currency: order.currency });
  const params = {
    sid: creds.sid, walletNumber: creds.wallet, keyIndex: Number(creds.keyIndex) || 1,
    ipcLanguage: String(config.mypos.lang || 'en').toLowerCase(),
    amount: Number(Number(order.amount).toFixed(2)), currency: order.currency, orderID: order.order_id,
    urlNotify: `${config.appUrl}/mypos/notify`,
    urlOk: `${config.appUrl}/mypos/ok?order=${order.order_id}`,
    urlCancel: `${config.appUrl}/mypos/cancel?order=${order.order_id}`,
    cartItems: items,
  };
  const thanksUrl = `${config.proxyPath}/thanks?order=${order.order_id}`;
  const hostedUrl = `${config.proxyPath}/hosted?order=${order.order_id}`;
  const fmt = (n) => `{{ ${Math.round(Number(n) * 100)} | money }}`;
  return `${CSS}
<style>#myPOSEmbeddedCheckout{min-height:620px}.mpc .alt{display:block;text-align:center;margin-top:14px;font-size:.9em}</style>
<div class="mpc">
  <div>
    <h2>Payment</h2>
    <div class="card">
      <div id="mpcErr" class="err" style="display:none"></div>
      <div id="myPOSEmbeddedCheckout"></div>
      <a class="alt" href="${hostedUrl}">Prefer Apple Pay / Google Pay? Pay on the secure myPOS page →</a>
      <div class="secure">🔒 Card details are entered directly with myPOS and never touch this store.</div>
    </div>
    <p style="font-size:.85em;opacity:.7;margin-top:12px"><a href="${config.proxyPath}">← Back to details</a></p>
  </div>
  <div>
    <h2>Your order</h2>
    <div class="card">
      ${cart.map((c) => `<div class="item"><div class="t">${esc(c.title)}<small>Qty ${c.quantity}</small></div><div>${fmt(c.price * c.quantity)}</div></div>`).join('')}
      <div class="tot" style="margin-top:12px"><span>${esc(shopRow.shipping_label || 'Shipping')}</span><span>${ship > 0 ? fmt(ship) : 'Free'}</span></div>
      <div class="tot g"><span>Total</span><span>${fmt(order.amount)}</span></div>
      <div style="margin-top:14px;font-size:.85em;opacity:.75">${esc(customer.firstName || '')} ${esc(customer.lastName || '')}<br>${esc(customer.address || '')}, ${esc(customer.city || '')} ${esc(customer.zip || '')}<br>${esc(customer.email || '')}</div>
    </div>
  </div>
</div>
<script src="${esc(config.mypos.embeddedSdkUrl)}"></script>
<script>
(function(){
  var params = ${JSON.stringify(params)};
  var err = document.getElementById('mpcErr');
  function fail(msg){ err.textContent = msg || 'The payment could not be completed. Please try again or use the myPOS page link below.'; err.style.display='block'; }
  if (!window.MyPOSEmbedded) { fail('The payment form could not be loaded.'); return; }
  try {
    MyPOSEmbedded.createPayment('myPOSEmbeddedCheckout', params, {
      isSandbox: ${creds.sandbox ? 'true' : 'false'},
      onSuccess: function(){ try{fetch('/cart/clear.js',{method:'POST'})}catch(e){} window.location.href = ${JSON.stringify(thanksUrl)}; },
      onError: function(e){ fail(e && (e.message || e.msg) ? String(e.message || e.msg) : ''); }
    });
  } catch (e) { fail(); }
})();
</script>`;
}

function thanksLiquid({ order }) {
  const paid = order && order.status === 'paid';
  const pending = order && order.status === 'created';
  return `${CSS}
<div class="mpc" style="grid-template-columns:1fr;max-width:640px">
  <div class="card" style="text-align:center;padding:40px 24px">
    ${paid ? `<h2>Thank you — payment received ✅</h2>
      <p>Your order ${order.shopify_order_name ? `<strong>${esc(order.shopify_order_name)}</strong>` : ''} is confirmed. A confirmation email is on its way${order.customer_json ? ` to <strong>${esc(JSON.parse(order.customer_json).email || '')}</strong>` : ''}.</p>`
    : pending ? `<h2>Confirming your payment…</h2><p>This usually takes a few seconds. This page refreshes automatically.</p><script>setTimeout(function(){location.reload()},4000)</script>`
    : `<h2>Order not found</h2><p>If you were charged, please contact us with reference <code>${esc(order ? order.order_id : '')}</code>.</p>`}
    <p style="margin-top:24px"><a href="/">Continue shopping</a></p>
  </div>
  ${paid ? `<script>try{fetch('/cart/clear.js',{method:'POST'})}catch(e){}</script>` : ''}
</div>`;
}

function cancelLiquid() {
  return `${CSS}
<div class="mpc" style="grid-template-columns:1fr;max-width:640px">
  <div class="card" style="text-align:center;padding:40px 24px">
    <h2>Payment cancelled</h2><p>No money was taken. Your cart is still saved.</p>
    <p style="margin-top:24px"><a href="${config.proxyPath}">Try again</a> · <a href="/cart">Back to cart</a></p>
  </div>
</div>`;
}

// Plain HTML wrapper for pages served directly from this service (not through the proxy).
function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1b1f24}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px}h1{font-size:1.4em;margin:0 0 18px}h2{font-size:1.05em;margin:28px 0 10px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;font-size:.9em}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #eceff3;vertical-align:top}th{background:#f0f2f5;font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.8em;background:#e8eaee}.paid{background:#d9f3e3;color:#136c3a}.created{background:#fff3cd;color:#7a5a00}.failed,.refunded{background:#fde2e2;color:#8a1f1f}
.card{background:#fff;border-radius:10px;padding:18px;margin-bottom:18px}code{background:#eef0f3;padding:1px 5px;border-radius:4px}
input,select{padding:8px;border:1px solid #cfd4db;border-radius:6px;font:inherit}button{padding:8px 12px;border:0;border-radius:6px;background:#111;color:#fff;font:inherit;cursor:pointer}
.ok{color:#136c3a}.bad{color:#8a1f1f}.muted{color:#6b7280}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

function adminHtml({ shops, orders, myposStatus, flash }) {
  const fmt = (n, c) => `${Number(n).toFixed(2)} ${c}`;
  const shopRows = shops.map((s) => `
    <tr><td><strong>${esc(s.name || s.shop)}</strong><br><span class="muted">${esc(s.shop)}</span></td>
      <td><a href="${esc(s.primary_domain)}${config.proxyPath}" target="_blank">${esc(s.primary_domain)}${config.proxyPath}</a></td>
      <td>${esc(s.currency)}</td>
      <td><form method="post" action="/admin/shipping" style="display:flex;gap:6px">
        <input type="hidden" name="shop" value="${esc(s.shop)}">
        <input name="label" value="${esc(s.shipping_label)}" style="width:110px" placeholder="Label">
        <input name="amount" value="${Number(s.shipping_amount || 0).toFixed(2)}" style="width:80px">
        <button>Save</button></form></td>
      <td class="muted">${esc(s.installed_at.slice(0, 10))}</td></tr>`).join('');
  const orderRows = orders.map((o) => {
    const c = JSON.parse(o.customer_json || '{}');
    const cart = JSON.parse(o.cart_json || '[]');
    const canRefund = o.status === 'paid' && o.ipc_trnref && Number(o.refunded_amount || 0) < Number(o.amount);
    return `
    <tr><td><code>${esc(o.order_id)}</code><br><span class="muted">${esc(o.created_at.replace('T', ' ').slice(0, 16))}</span></td>
      <td>${esc(o.shop.replace('.myshopify.com', ''))}</td>
      <td>${esc(c.firstName || '')} ${esc(c.lastName || '')}<br><span class="muted">${esc(c.email || '')}</span></td>
      <td>${cart.map((i) => `${esc(i.title)} ×${i.quantity}`).join('<br>')}</td>
      <td>${fmt(o.amount, o.currency)}${Number(o.refunded_amount) > 0 ? `<br><span class="muted">refunded ${fmt(o.refunded_amount, o.currency)}</span>` : ''}</td>
      <td><span class="pill ${esc(o.status)}">${esc(o.status)}</span>${o.card_last4 ? `<br><span class="muted">•••• ${esc(o.card_last4)}</span>` : ''}</td>
      <td>${o.shopify_order_name ? `<a href="https://${esc(o.shop)}/admin/orders/${esc(o.shopify_order_gid.split('/').pop())}" target="_blank">${esc(o.shopify_order_name)}</a>`
          : o.shopify_error ? `<span class="bad" title="${esc(o.shopify_error)}">failed</span> <form method="post" action="/admin/retry" style="display:inline"><input type="hidden" name="order_id" value="${esc(o.order_id)}"><button>Retry</button></form>` : '—'}</td>
      <td>${canRefund ? `<form method="post" action="/admin/refund" onsubmit="return confirm('Refund this amount via myPOS?')" style="display:flex;gap:4px"><input type="hidden" name="order_id" value="${esc(o.order_id)}"><input name="amount" value="${(Number(o.amount) - Number(o.refunded_amount || 0)).toFixed(2)}" style="width:80px"><button>Refund</button></form>` : ''}</td></tr>`;
  }).join('');
  return page('myPOS checkout — admin', `
    <h1>myPOS checkout — admin</h1>
    ${flash ? `<div class="card ${flash.ok ? 'ok' : 'bad'}">${esc(flash.msg)}</div>` : ''}
    <div class="grid">
      <div class="card"><strong>myPOS</strong><br>
        ${myposStatus.missing.length ? `<span class="bad">Not configured — missing ${esc(myposStatus.missing.join(', '))}</span>${myposStatus.packKeys.length ? `<br><span class="muted">Config pack keys seen: ${esc(myposStatus.packKeys.join(', '))}</span>` : ''}`
          : `<span class="ok">Configured</span> · SID <code>${esc(myposStatus.sid)}</code> · wallet <code>${esc(myposStatus.wallet)}</code> · key index ${esc(myposStatus.keyIndex)}`}
        <br>Mode: <strong>${myposStatus.sandbox ? 'SANDBOX (checkout-test)' : 'LIVE'}</strong>
        <br><span class="muted">Notify URL to keep public: <code>${esc(config.appUrl)}/mypos/notify</code></span></div>
      <div class="card"><strong>Install on a store</strong><br>
        <form method="get" action="/auth" style="display:flex;gap:6px;margin-top:8px"><input name="shop" placeholder="store.myshopify.com" style="flex:1"><button>Install</button></form>
        <span class="muted">Then set the app proxy in Shopify to <code>${esc(config.proxyPath)}</code> → <code>${esc(config.appUrl)}/proxy</code></span></div>
    </div>
    <h2>Stores (${shops.length})</h2>
    <table><tr><th>Store</th><th>Checkout URL</th><th>Currency</th><th>Flat shipping</th><th>Installed</th></tr>${shopRows || '<tr><td colspan="5" class="muted">No stores installed yet.</td></tr>'}</table>
    <h2>Orders (latest ${orders.length})</h2>
    <table><tr><th>Ref</th><th>Store</th><th>Customer</th><th>Items</th><th>Amount</th><th>Status</th><th>Shopify</th><th>Refund</th></tr>${orderRows || '<tr><td colspan="8" class="muted">No orders yet.</td></tr>'}</table>`);
}

module.exports = { checkoutLiquid, embeddedPayLiquid, thanksLiquid, cancelLiquid, page, adminHtml, esc };
