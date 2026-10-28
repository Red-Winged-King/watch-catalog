'use strict';

const $ = selector => document.querySelector(selector);
const API_ORIGIN = typeof window.WATCH_CHECKOUT_API_ORIGIN === 'string'
  ? window.WATCH_CHECKOUT_API_ORIGIN.replace(/\/+$/, '')
  : '';
const DEFAULT_SETTINGS = {
  marketplaceId: 'EBAY_US', currency: 'USD', liveEnabled: false,
  paymentPolicyId: '', fulfillmentPolicyId: '', returnPolicyId: '', merchantLocationKey: '',
  shippingCountry: 'US', shippingOriginCountry: '', shippingSummary: '', returnsSummary: '', handlingDays: 3,
  shippingConfirmed: false, freeShippingPolicyConfirmed: false, packageWeightGrams: 0, shippingTiers: [],
  maxCartUnits: 10, maxDailyListings: 10, maxDailyListingFeesCents: 0, maxReferenceAgeDays: 30, bundleAspects: {}
};

const state = {
  me: null,
  dashboard: null,
  latestDraft: null,
  authLoading: true,
  dashboardLoading: false
};

class ApiError extends Error {
  constructor(message, code = '', status = 0) {
    super(message || 'The server could not complete that request.');
    this.code = code;
    this.status = status;
  }
}

function apiPath(path) { return `${API_ORIGIN}${path}`; }

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function formatMoney(cents) {
  return Number.isInteger(cents)
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
    : 'Not returned';
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Not returned';
}

async function requestJson(path, options = {}) {
  const response = await fetch(apiPath(path), options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || `Request failed (${response.status}).`, payload.code || '', response.status);
  return payload;
}

function csrfHeaders() {
  if (!state.me?.csrfToken) throw new ApiError('The protected owner session did not provide a CSRF token. Sign in again.', 'CSRF_MISSING', 403);
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': state.me.csrfToken };
}

async function adminMutation(path, body) {
  if (!state.me?.authenticated || !state.me?.isAdmin) throw new ApiError('Owner authorization is required for this action.', 'UNAUTHORIZED', 403);
  return requestJson(path, { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(body) });
}

async function adminPut(path, body) {
  if (!state.me?.authenticated || !state.me?.isAdmin) throw new ApiError('Owner authorization is required for this action.', 'UNAUTHORIZED', 403);
  return requestJson(path, { method: 'PUT', headers: csrfHeaders(), body: JSON.stringify(body) });
}

function setStatus(id, message, tone = '') {
  const element = $(id);
  element.textContent = message || '';
  element.className = `form-status ${tone}`.trim();
}

function identityRows(me) {
  const list = $('#identityList');
  const rows = [];
  if (typeof me?.openId === 'string' && me.openId) rows.push(['OpenID returned by server', me.openId]);
  if (typeof me?.name === 'string' && me.name) rows.push(['Session name', me.name]);
  if (!rows.length) {
    list.hidden = true;
    list.innerHTML = '';
    return;
  }
  list.hidden = false;
  list.innerHTML = rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd><code>${esc(value)}</code></dd></div>`).join('');
}

function renderAuth() {
  const me = state.me;
  const title = $('#authTitle');
  const message = $('#authMessage');
  const login = $('#loginBtn');
  const logout = $('#logoutBtn');
  const dashboard = $('#dashboard');
  identityRows(me);
  dashboard.hidden = true;
  logout.hidden = true;

  if (state.authLoading) {
    title.textContent = 'Checking owner access…';
    message.textContent = 'Contacting the protected server session.';
    login.hidden = true;
    return;
  }
  if (!me) {
    title.textContent = 'Owner access could not be checked.';
    message.textContent = 'The protected server did not return an authentication response. Retry after the API origin is configured.';
    login.hidden = true;
    return;
  }
  if (!me.authenticated) {
    title.textContent = 'Owner sign-in required';
    message.textContent = 'Sign in through the configured Manus authorization flow. This page does not provide a local or Preview bypass.';
    login.hidden = false;
    return;
  }
  login.hidden = true;
  logout.hidden = false;
  if (!me.ownerConfigured) {
    title.textContent = 'ADMIN_OPEN_ID is not configured';
    message.textContent = me.openId
      ? 'Give the returned OpenID shown below to the deployment operator for protected server configuration as ADMIN_OPEN_ID. This dashboard cannot grant owner access to itself.'
      : 'The server did not return an OpenID. The deployment operator must configure ADMIN_OPEN_ID through protected server settings; this dashboard cannot grant access.';
    return;
  }
  if (!me.isAdmin) {
    title.textContent = 'Signed in, but not the configured owner';
    message.textContent = me.openId
      ? 'The returned OpenID shown below does not match the server-configured ADMIN_OPEN_ID. No owner controls are available.'
      : 'The current session is not authorized as the server-configured owner.';
    return;
  }
  title.textContent = 'Protected owner session active';
  message.textContent = 'All mutations include the current session CSRF token. The server independently enforces owner authorization and origin checks.';
  dashboard.hidden = false;
}

function renderReadiness(readiness) {
  const checks = Array.isArray(readiness?.checks) ? readiness.checks : [];
  const mark = $('#readinessMark');
  mark.textContent = readiness?.ready ? 'Ready' : 'Not ready';
  mark.className = `readiness-mark ${readiness?.ready ? 'is-ready' : 'is-not-ready'}`;
  $('#readinessChecklist').innerHTML = checks.length
    ? checks.map(check => `<li class="${check.ok ? 'ok' : 'blocked'}"><span aria-hidden="true">${check.ok ? '✓' : '×'}</span><div><b>${esc(check.label)}</b><small>${esc(check.detail)}</small></div></li>`).join('')
    : '<li class="blocked"><span aria-hidden="true">×</span><div><b>No readiness checks returned</b><small>The server has not supplied live readiness evidence.</small></div></li>';
}

function renderDrafts(drafts) {
  const list = $('#draftsList');
  if (!Array.isArray(drafts) || !drafts.length) {
    list.innerHTML = '<p class="empty-admin-state">No drafts have been returned by the server.</p>';
    return;
  }
  list.innerHTML = drafts.map(draft => {
    const status = draft.approvedAt ? `Approved ${formatDate(draft.approvedAt)}` : 'Awaiting exact owner approval';
    const detail = {
      id: draft.id,
      basketKey: draft.basketKey,
      cart: draft.cart,
      quote: draft.quote,
      payloadHash: draft.payloadHash,
      contextHash: draft.contextHash,
      payload: draft.payload,
      createdAt: draft.createdAt,
      approvedAt: draft.approvedAt,
      approvedMaxListingFeeCents: draft.approvedMaxListingFeeCents
    };
    return `<details><summary><span><b>${esc(draft.id || 'Draft')}</b><small>${esc(status)}</small></span><span>${esc(draft.payloadHash || 'No payload hash')}</span></summary><pre>${esc(JSON.stringify(detail, null, 2))}</pre></details>`;
  }).join('');
}

function renderMetrics(metrics) {
  const events = metrics?.events && typeof metrics.events === 'object' ? metrics.events : {};
  const eventEntries = Object.entries(events);
  const eventCards = eventEntries.length
    ? eventEntries.map(([type, count]) => `<div class="metric-card"><span>${esc(type.replace(/_/g, ' '))}</span><b>${esc(count)}</b></div>`).join('')
    : '<div class="metric-card"><span>Events</span><b>Not returned</b></div>';
  const verified = Number.isInteger(metrics?.verifiedSales) ? metrics.verifiedSales : 'Not returned';
  $('#metrics').innerHTML = `${eventCards}<div class="metric-card verified-sales"><span>Verified eBay sales</span><b>${esc(verified)}</b></div>`;
}

function renderCheckouts(checkouts) {
  const body = $('#checkoutsTable');
  if (!Array.isArray(checkouts) || !checkouts.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty-table">No checkout records were returned by the server.</td></tr>';
    return;
  }
  body.innerHTML = checkouts.map(checkout => {
    const listing = checkout.listingId || checkout.offerId || 'Not published';
    const expiry = checkout.expiresAt ? `Expiry: ${formatDate(checkout.expiresAt)}` : 'No active expiry deadline returned';
    const evidence = checkout.saleEvidence
      ? `Sale evidence: ${checkout.saleEvidence.committed ? 'committed' : 'not committed'} · observed ${formatDate(checkout.saleEvidence.observedAt)}`
      : (checkout.error || 'No verified sale evidence returned');
    return `<tr><td><b>${esc(checkout.id || 'Unknown')}</b><small>Draft ${esc(checkout.draftId || 'not returned')}</small></td><td><span class="state-pill">${esc(checkout.state || 'Unknown')}</span></td><td>${esc(listing)}<small>${esc(expiry)}</small></td><td>${esc(evidence)}</td></tr>`;
  }).join('');
}

function renderSeller(seller) {
  const detail = seller?.connected
    ? `Connected${seller.sellerName ? ` as ${seller.sellerName}` : ''}. Seller authorization is server-managed.`
    : 'No seller connection is reported. Connecting begins the real eBay seller authorization flow.';
  $('#sellerStatus').textContent = detail;
  $('#connectSeller').textContent = seller?.connected ? 'Reconnect eBay seller' : 'Connect eBay seller';
}

function renderSchedule(schedule) {
  $('#scheduleTaskUid').value = schedule?.taskUid || '';
  $('#scheduleEnabled').checked = Boolean(schedule?.enabled);
}

function renderDashboard(data) {
  state.dashboard = data;
  $('#settingsInput').value = JSON.stringify(data.settings || DEFAULT_SETTINGS, null, 2);
  renderReadiness(data.readiness);
  renderDrafts(data.drafts);
  renderMetrics(data.metrics);
  renderCheckouts(data.checkouts);
  renderSeller(data.seller);
  renderSchedule(data.schedule);
}

async function loadDashboard() {
  if (!state.me?.isAdmin) return;
  state.dashboardLoading = true;
  $('#dashboardStatus').textContent = 'Loading server-side readiness and operational records…';
  try {
    const data = await requestJson('/api/admin/dashboard', { cache: 'no-store' });
    renderDashboard(data);
    $('#dashboardStatus').textContent = 'Operational records loaded from the protected server.';
  } catch (error) {
    $('#dashboardStatus').textContent = `Dashboard unavailable: ${error.message || 'unknown server error'}`;
  } finally {
    state.dashboardLoading = false;
  }
}

async function loadMe() {
  state.authLoading = true;
  renderAuth();
  try {
    state.me = await requestJson('/api/auth/me', { cache: 'no-store' });
  } catch {
    state.me = null;
  } finally {
    state.authLoading = false;
    renderAuth();
  }
  if (state.me?.authenticated && state.me?.isAdmin) loadDashboard();
}

async function startLogin() {
  $('#loginBtn').disabled = true;
  try {
    const result = await requestJson('/api/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: window.location.origin })
    });
    if (typeof result.url !== 'string' || !result.url) throw new ApiError('The authorization endpoint did not return a redirect URL.', 'AUTH_URL');
    window.location.assign(result.url);
  } catch (error) {
    $('#authMessage').textContent = error.message || 'Unable to begin the authorization flow.';
    $('#loginBtn').disabled = false;
  }
}

async function logout() {
  try {
    await requestJson('/api/auth/logout', { method: 'POST', headers: csrfHeaders() });
  } catch (error) {
    $('#authMessage').textContent = error.message || 'Unable to log out.';
    return;
  }
  state.me = null;
  state.dashboard = null;
  state.latestDraft = null;
  await loadMe();
}

function parseArrayInput(inputSelector, label) {
  let parsed;
  try { parsed = JSON.parse($(inputSelector).value.trim() || '[]'); }
  catch { throw new ApiError(`${label} must be valid JSON.`, 'INVALID_JSON'); }
  if (!Array.isArray(parsed)) throw new ApiError(`${label} must be a JSON array matching the downloadable schema.`, 'INVALID_JSON');
  return parsed;
}

async function importProducts() {
  setStatus('#productsStatus', 'Validating import…');
  try {
    const products = parseArrayInput('#productsInput', 'Products input');
    const result = await adminMutation('/api/admin/products/import', { products });
    setStatus('#productsStatus', `${result.imported} product record(s) imported after server validation.`, 'success');
    await loadDashboard();
  } catch (error) {
    setStatus('#productsStatus', error.message || 'Product import failed.', 'error');
  }
}

async function importReferences() {
  setStatus('#referencesStatus', 'Validating import…');
  try {
    const references = parseArrayInput('#referencesInput', 'Product Research input');
    const result = await adminMutation('/api/admin/references/import', { references });
    setStatus('#referencesStatus', `${result.imported} Product Research record(s) imported after server validation.`, 'success');
    await loadDashboard();
  } catch (error) {
    setStatus('#referencesStatus', error.message || 'Product Research import failed.', 'error');
  }
}

async function saveSettings() {
  setStatus('#settingsStatus', 'Saving complete settings object…');
  try {
    let settings;
    try { settings = JSON.parse($('#settingsInput').value); }
    catch { throw new ApiError('Settings must be valid JSON matching the Settings schema.', 'INVALID_JSON'); }
    if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new ApiError('Settings must be a JSON object.', 'INVALID_JSON');
    const result = await adminPut('/api/admin/settings', { settings });
    $('#settingsInput').value = JSON.stringify(result.settings || settings, null, 2);
    setStatus('#settingsStatus', 'Settings saved. The server still blocks live mode when readiness prerequisites are incomplete.', 'success');
    await loadDashboard();
  } catch (error) {
    setStatus('#settingsStatus', error.message || 'Settings could not be saved.', 'error');
  }
}

function createDraftLine(sku = '', quantity = 1) {
  const row = document.createElement('div');
  row.className = 'draft-line';
  row.innerHTML = `<label>SKU<input class="draft-sku" type="text" value="${esc(sku)}" autocomplete="off" placeholder="Existing catalog SKU"></label><label>Quantity<input class="draft-quantity" type="number" min="1" max="10" step="1" value="${esc(quantity)}"></label><button class="iconbtn remove-line" type="button" aria-label="Remove draft line">×</button>`;
  row.querySelector('.remove-line').addEventListener('click', () => {
    if ($('#draftLines').children.length > 1) row.remove();
    else { row.querySelector('.draft-sku').value = ''; row.querySelector('.draft-quantity').value = '1'; }
  });
  $('#draftLines').append(row);
}

function draftLines() {
  const lines = [...document.querySelectorAll('.draft-line')].map(row => ({
    sku: row.querySelector('.draft-sku').value.trim(),
    quantity: Number(row.querySelector('.draft-quantity').value)
  }));
  if (!lines.length || lines.some(line => !line.sku || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 10)) {
    throw new ApiError('Each draft line needs an existing catalog SKU and a whole quantity from 1 through 10.', 'INVALID_CART');
  }
  const combined = new Map();
  lines.forEach(line => combined.set(line.sku, (combined.get(line.sku) || 0) + line.quantity));
  const result = [...combined].map(([sku, quantity]) => ({ sku, quantity }));
  if (result.some(line => line.quantity > 10)) throw new ApiError('Combined quantities are limited to 10 per SKU.', 'INVALID_CART');
  return result;
}

function renderDraftResult(draft) {
  state.latestDraft = draft;
  const result = $('#draftResult');
  result.hidden = false;
  const exact = {
    id: draft.id,
    cart: draft.cart,
    quote: draft.quote,
    payloadHash: draft.payloadHash,
    contextHash: draft.contextHash,
    payload: draft.payload,
    createdAt: draft.createdAt
  };
  const approved = Boolean(draft.approvedAt);
  result.innerHTML = `<div class="draft-review-head"><div><span class="panel-kicker">SERVER DRAFT</span><h3>${esc(draft.id || 'Draft returned')}</h3></div><span class="state-pill">${approved ? 'APPROVED' : 'REVIEW REQUIRED'}</span></div><p>Review the exact server quote, inventory and offer payload below. A public listing may be withdrawn if unsold after 10 minutes from successful publication. It is not buyer-exclusive. Approval authorizes this unchanged payload only; it does not publish a listing.</p><details open><summary>Exact quote and listing payload</summary><pre>${esc(JSON.stringify(exact, null, 2))}</pre></details>${approved ? `<p class="approval-state">Approved ${esc(formatDate(draft.approvedAt))} with maximum listing fee ${esc(formatMoney(draft.approvedMaxListingFeeCents))}.</p>` : `<div class="approval-form"><label>Maximum listing fee (USD cents)<input id="feeCeiling" type="number" min="0" step="1" value="0"></label><label class="check-label"><input id="approvalConfirm" type="checkbox"> I reviewed this exact payload hash and understand approval is not publication.</label><button class="primary" id="approveDraft" type="button">Confirm exact approval</button><span class="form-status" id="approvalStatus" role="status"></span></div>`}`;
}

async function buildDraft() {
  setStatus('#draftStatus', 'Building an exact server-side draft…');
  try {
    const result = await adminMutation('/api/admin/drafts', { items: draftLines() });
    if (!result.draft) throw new ApiError('The server did not return a draft payload.', 'DRAFT_MISSING');
    renderDraftResult(result.draft);
    setStatus('#draftStatus', 'Draft built. It has not created or published an eBay listing.', 'success');
    await loadDashboard();
  } catch (error) {
    setStatus('#draftStatus', error.message || 'Draft could not be built.', 'error');
  }
}

async function approveDraft() {
  const draft = state.latestDraft;
  const status = $('#approvalStatus');
  if (!draft) return;
  const fee = Number($('#feeCeiling').value);
  if (!Number.isInteger(fee) || fee < 0) {
    status.textContent = 'Enter a non-negative whole-cent fee ceiling.';
    status.className = 'form-status error';
    return;
  }
  if (!$('#approvalConfirm').checked) {
    status.textContent = 'Explicit confirmation is required before approval.';
    status.className = 'form-status error';
    return;
  }
  status.textContent = 'Submitting exact payload approval…';
  status.className = 'form-status';
  try {
    const result = await adminMutation(`/api/admin/drafts/${encodeURIComponent(draft.id)}/approve`, {
      payloadHash: draft.payloadHash,
      maxListingFeeCents: fee,
      confirm: true
    });
    renderDraftResult(result.draft || draft);
    await loadDashboard();
  } catch (error) {
    status.textContent = error.message || 'Draft approval failed.';
    status.className = 'form-status error';
  }
}

async function connectSeller() {
  $('#connectSeller').disabled = true;
  try {
    const result = await adminMutation('/api/admin/ebay/connect', { origin: window.location.origin });
    if (typeof result.url !== 'string' || !result.url) throw new ApiError('The seller authorization endpoint did not return a redirect URL.', 'EBAY_URL');
    window.location.assign(result.url);
  } catch (error) {
    $('#sellerStatus').textContent = error.message || 'Seller authorization could not be started.';
    $('#connectSeller').disabled = false;
  }
}

async function saveSchedule() {
  setStatus('#scheduleStatus', 'Saving schedule binding…');
  try {
    const taskUid = $('#scheduleTaskUid').value.trim();
    if (!taskUid) throw new ApiError('Enter the actual platform schedule task UID.', 'TASK_UID_REQUIRED');
    const result = await adminMutation('/api/admin/schedule', { taskUid, enabled: $('#scheduleEnabled').checked });
    renderSchedule(result.schedule);
    setStatus('#scheduleStatus', 'Schedule binding saved. The scheduled callback still verifies task identity server-side.', 'success');
    await loadDashboard();
  } catch (error) {
    setStatus('#scheduleStatus', error.message || 'Schedule binding could not be saved.', 'error');
  }
}

function bindFileInput(inputSelector, textSelector, label) {
  $(inputSelector).addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      JSON.parse(text);
      $(textSelector).value = text;
    } catch {
      setStatus(textSelector === '#productsInput' ? '#productsStatus' : '#referencesStatus', `${label} file is not valid JSON.`, 'error');
    }
  });
}

function bindEvents() {
  $('#loginBtn').addEventListener('click', startLogin);
  $('#logoutBtn').addEventListener('click', logout);
  $('#authRetryBtn').addEventListener('click', loadMe);
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#importProducts').addEventListener('click', importProducts);
  $('#importReferences').addEventListener('click', importReferences);
  $('#addDraftLine').addEventListener('click', () => createDraftLine());
  $('#buildDraft').addEventListener('click', buildDraft);
  $('#draftResult').addEventListener('click', event => {
    if (event.target.closest('#approveDraft')) approveDraft();
  });
  $('#connectSeller').addEventListener('click', connectSeller);
  $('#saveSchedule').addEventListener('click', saveSchedule);
  bindFileInput('#productFile', '#productsInput', 'Product');
  bindFileInput('#referenceFile', '#referencesInput', 'Product Research');
}

function init() {
  createDraftLine();
  bindEvents();
  loadMe();
}

init();
