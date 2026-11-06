const $ = id => document.getElementById(id);
const inr = n => '₹' + Math.round(n || 0).toLocaleString('en-IN');

// Inside Shopify admin, App Bridge provides a fresh session token for every request.
async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (window.shopify?.idToken) headers.authorization = `Bearer ${await window.shopify.idToken()}`;
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

const EVENT = {
  installed: ['🎉', 'CartNudge installed'],
  cod_message_sent: ['💬', e => `WhatsApp sent for ${e.order} · ${inr(e.amount)}`],
  confirmed: ['✅', e => `${e.order} confirmed by buyer`],
  cancel_requested: ['✖', e => `${e.order} cancel requested — don't ship`],
  prepaid_link_sent: ['🔗', e => `Pay-online link sent for ${e.order}`],
  paid_online: ['💳', e => `${e.order} paid online · ${inr(e.amount)}`],
  no_phone: ['📵', e => `${e.order} has no phone number`],
  cart_reminder_sent: ['🛒', e => `Cart reminder sent · ${inr(e.amount)}`],
  cart_recovered: ['💰', e => `Cart recovered ${e.order || ''} · ${inr(e.amount)}`],
  test_message: ['🧪', e => `Test message ${e.dryRun ? 'logged (WhatsApp not connected yet)' : 'sent'}`],
  subscription: ['🧾', e => `Plan status: ${e.status}`],
  uninstalled: ['👋', 'App uninstalled'],
  data_request: ['🔒', 'Customer data request received'],
  error: ['⚠️', e => e.message],
};

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function pill(label, tone) {
  const el = document.createElement('span');
  el.className = `pill ${tone}`;
  el.textContent = label;
  return el;
}

function render(data) {
  const { stats, settings, events } = data;
  $('storeName').textContent = data.name;
  $('saved').textContent = inr(stats.savings.total);
  $('fromCancels').textContent = inr(stats.savings.fromCancels);
  $('fromPrepaid').textContent = inr(stats.savings.fromPrepaid);
  $('formula').textContent = `Cancel requests × ₹${stats.savings.rtoCostRupees} + prepaid orders × ₹${stats.savings.rtoCostRupees} × ${stats.savings.codRtoRatePercent}% usual return rate. Confirmations are not counted.`;
  $('messaged').textContent = stats.cod.messaged;
  $('responseRate').textContent = `${stats.cod.responseRate}% replied`;
  $('confirmed').textContent = stats.cod.confirmed;
  $('paidOnline').textContent = stats.cod.paidOnline;
  $('prepaidValue').textContent = `${inr(stats.cod.prepaidValue)} collected`;
  $('cancelRequested').textContent = stats.cod.cancelRequested;
  $('cartsRecovered').textContent = stats.carts.recovered;
  $('cartValue').textContent = `${inr(stats.carts.recoveredValue)} revenue`;

  const total = Math.max(1, stats.cod.messaged);
  const rows = [
    ['Confirmed', stats.cod.confirmed, '#1E5A45'],
    ['Paid online', stats.cod.paidOnline, '#F2B630'],
    ['Link sent, not paid', stats.cod.linkSent, '#E9C46A'],
    ['Cancel requested', stats.cod.cancelRequested, '#D9482B'],
    ['No reply yet', Math.max(0, stats.cod.messaged - stats.cod.confirmed - stats.cod.paidOnline - stats.cod.linkSent - stats.cod.cancelRequested), '#B8B09F'],
  ];
  const funnel = $('funnel');
  funnel.replaceChildren(...rows.map(([label, value, color]) => {
    const row = document.createElement('div');
    row.className = 'bar';
    row.innerHTML = '<span></span><div class="track"><div class="fill"></div></div><b></b>';
    row.children[0].textContent = label;
    row.children[2].textContent = value;
    const fill = row.querySelector('.fill');
    fill.style.setProperty('--c', color);
    requestAnimationFrame(() => { fill.style.width = `${(value / total) * 100}%`; });
    return row;
  }));

  const feed = $('feed');
  if (events.length) {
    feed.replaceChildren(...events.map(e => {
      const [icon, label] = EVENT[e.type] || ['•', e.type];
      const li = document.createElement('li');
      li.innerHTML = '<i></i><span></span><time></time>';
      li.children[0].textContent = icon;
      li.children[1].textContent = typeof label === 'function' ? label(e) : label;
      li.children[2].textContent = ago(e.at);
      return li;
    }));
  }

  const pills = $('pills');
  pills.replaceChildren(
    pill(data.whatsappLive ? 'WhatsApp live' : 'WhatsApp in test mode', data.whatsappLive ? 'ok' : 'warn'),
    pill(settings.razorpayKeyId && settings.razorpayKeySecretSet ? 'Razorpay connected' : 'Razorpay not connected', settings.razorpayKeyId && settings.razorpayKeySecretSet ? 'ok' : 'warn'),
    pill(data.subscription?.status === 'ACTIVE' ? `${data.plan.name}${data.subscription.test ? ' (test)' : ''}` : (data.billingRequired ? 'No active plan' : 'Free beta'), data.subscription?.status === 'ACTIVE' || !data.billingRequired ? 'ok' : 'bad'),
  );

  const banner = $('banner');
  if (data.billingRequired && data.subscription?.status !== 'ACTIVE') {
    banner.hidden = false;
    banner.innerHTML = '<span></span><button class="btn gold" type="button">Start free trial</button>';
    banner.firstChild.textContent = `Messages are paused. Start your ${data.plan.trialDays}-day free trial of ${data.plan.name} ($${data.plan.priceUsd}/month, billed by Shopify).`;
    banner.querySelector('button').onclick = subscribe;
  } else banner.hidden = true;

  $('rzpUrl').textContent = data.razorpayWebhookUrl;
  if (render.filled && !render.refill) return;
  render.filled = true;
  render.refill = false;
  const form = $('settings');
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(settings[el.name]);
    else if (el.type === 'password') el.value = '';
    else el.value = settings[el.name] ?? '';
  }
}

async function load() {
  try { render(await api('/api/overview')); }
  catch (error) { $('banner').hidden = false; $('banner').textContent = error.message; }
}

async function subscribe() {
  try {
    const { confirmationUrl } = await api('/api/billing/subscribe', { method: 'POST' });
    window.open(confirmationUrl, '_top');
  } catch (error) { alertStatus($('saveStatus'), error.message, true); }
}

function alertStatus(el, message, isError = false) {
  el.textContent = message;
  el.classList.toggle('err', isError);
  if (!isError) setTimeout(() => { if (el.textContent === message) el.textContent = ''; }, 4000);
}

$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type=submit]');
  const patch = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') patch[el.name] = el.checked;
    else if (el.type === 'number') patch[el.name] = Number(el.value);
    else if (el.type === 'password') { if (el.value) patch[el.name] = el.value; }
    else patch[el.name] = el.value.trim();
  }
  button.disabled = true;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
    alertStatus($('saveStatus'), 'Saved ✓');
    render.refill = true;
    await load();
  } catch (error) { alertStatus($('saveStatus'), error.message, true); }
  finally { button.disabled = false; }
});

$('testBtn').addEventListener('click', async () => {
  const button = $('testBtn');
  button.disabled = true;
  try {
    const result = await api('/api/test-message', { method: 'POST', body: JSON.stringify({ phone: $('testPhone').value }) });
    alertStatus($('testStatus'), result.dryRun ? 'Logged. Connect WhatsApp to send real messages.' : 'Sent! Check your WhatsApp.');
    await load();
  } catch (error) { alertStatus($('testStatus'), error.message, true); }
  finally { button.disabled = false; }
});

load();
setInterval(load, 60_000);
