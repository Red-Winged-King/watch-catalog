'use strict';

const $ = selector => document.querySelector(selector);
const CART_KEY = 'gshockBag';
const CHECKOUT_KEY = 'watchCheckoutSession';
const IDEMPOTENCY_KEY = 'watchCheckoutIdempotency';
const MAX_QUANTITY = 10;
const EVENT_TYPES = new Set([
  'catalog_view', 'product_view', 'add_to_bag', 'remove_from_bag', 'bag_view',
  'quote_success', 'quote_failure', 'handoff', 'expiry', 'retry'
]);
const API_ORIGIN = typeof window.WATCH_CHECKOUT_API_ORIGIN === 'string'
  ? window.WATCH_CHECKOUT_API_ORIGIN.replace(/\/+$/, '')
  : '';

const CATEGORY_ICONS = {
  'GA2100': '01-ga2100.png',
  'GA2100 Summer': '02-ga2100-summer.png',
  'Diamond / Moissanite Covers': '03-diamond-moissanite-covers.png',
  'GM2100': '04-gm2100.png',
  'GM2100 A-Series': '05-gm2100-a-series.png',
  'GM2100 Steel Strip': '06-gm2100-steel-strip.png',
  'GA2100-AP': '07-ga2100-ap.png',
  'GM2100-AP': '08-gm2100-ap.png',
  'AW500': '09-aw500.png',
  'GA900': '10-ga900.png',
  'DW6900': '11-dw6900.png',
  'GA110 Series': '12-ga110-series.png',
  'B001 Series': '13-b001-series.png',
  'Baby-G': '14-baby-g.png',
  'G-7900': '15-g-7900.png',
  'GA-V01': '16-ga-v01.png',
  'GA700': '17-ga700.png',
  'GD-B500': '18-gd-b500.png',
  'GA100': '19-ga100.png',
  'GA-2300': '20-ga-2300.png',
  'GMW-B5000': '21-gmw-b5000.png',
  'Square Digital Series': '22-square-digital-series.png',
  'B400': '23-b400.png',
  'D012 Series': '24-d012-series.png',
  'N-Series': '25-n-series.png'
};

const state = {
  catalog: [],
  filtered: [],
  catalogStatus: 'loading',
  catalogError: '',
  activeCategory: 'All',
  bag: restoreBag(),
  commerce: { status: 'loading', payload: null, products: new Map(), error: '', controller: null },
  quote: { status: 'idle', signature: '', data: null, ready: false, message: '', controller: null, timer: null, requestId: 0 },
  checkout: restoreCheckout(),
  checkoutPendingSignature: '',
  checkoutTimer: null,
  current: null,
  zoom: 1,
  fitZoom: 1,
  openLayer: null,
  layerReturnFocus: null,
  toastTimer: null
};

const grid = $('#grid');
const chips = $('#chips');
const search = $('#search');
const sort = $('#sort');
const drawer = $('#bagDrawer');
const zoomModal = $('#zoomModal');

class ApiError extends Error {
  constructor(message, code = '', status = 0) {
    super(message || 'The server could not complete that request.');
    this.code = code;
    this.status = status;
  }
}

function apiPath(path) {
  return `${API_ORIGIN}${path}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function safeGet(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    try { localStorage.removeItem(key); } catch { /* storage is unavailable */ }
    return fallback;
  }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* preserve in-memory state */ }
}

function safeRemove(key) {
  try { localStorage.removeItem(key); } catch { /* storage is unavailable */ }
}

function restoreBag() {
  const raw = safeGet(CART_KEY, {});
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') return {};
  const restored = {};
  for (const [id, quantity] of Object.entries(raw)) {
    const parsed = Number(quantity);
    if (typeof id === 'string' && id.length <= 160 && Number.isInteger(parsed) && parsed > 0) {
      restored[id] = Math.min(parsed, MAX_QUANTITY);
    }
  }
  return restored;
}

function restoreCheckout() {
  const raw = safeGet(CHECKOUT_KEY, null);
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.accessToken !== 'string') return null;
  return {
    id: raw.id,
    accessToken: raw.accessToken,
    cartSignature: typeof raw.cartSignature === 'string' ? raw.cartSignature : '',
    state: typeof raw.state === 'string' ? raw.state : '',
    listingUrl: typeof raw.listingUrl === 'string' ? raw.listingUrl : '',
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
    message: typeof raw.message === 'string' ? raw.message : '',
    expiryEventRecorded: Boolean(raw.expiryEventRecorded)
  };
}

function persistCheckout() {
  if (state.checkout) safeSet(CHECKOUT_KEY, state.checkout);
  else safeRemove(CHECKOUT_KEY);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function formatMoney(cents) {
  if (!Number.isInteger(cents)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatCondition(condition) {
  return ({ NEW: 'New', USED_EXCELLENT: 'Used · excellent', USED_GOOD: 'Used · good' })[condition] || '';
}

function getThumb(item) { return item.thumb || item.image || ''; }
function getDetail(item) { return item.detailImage || item.image || item.thumb || ''; }
function getFallback(item) { return item.image || item.thumb || ''; }
function isFeatured(item) { return Boolean(item.featuredLabel); }

function imageMarkup(item, className = '') {
  const source = getThumb(item);
  const fallback = getFallback(item);
  const alt = `${item.category || 'Archive'} catalog item ${item.catalog || ''}`.trim();
  return `<span class="catalog-image ${esc(className)}"><img loading="lazy" decoding="async" src="${esc(source)}" data-original="${esc(source)}" data-fallback="${esc(fallback)}" alt="${esc(alt)}"><span class="image-terminal" aria-hidden="true">Image unavailable</span></span>`;
}

function markImageUnavailable(image) {
  const frame = image.closest('.catalog-image');
  if (frame) frame.classList.add('is-terminal');
  image.removeAttribute('src');
  image.alt = 'Image unavailable';
}

function handleImageError(image) {
  const fallback = image.dataset.fallback || '';
  const original = image.dataset.original || '';
  if (fallback && fallback !== original && image.dataset.fallbackTried !== 'true') {
    image.dataset.fallbackTried = 'true';
    image.src = fallback;
    return;
  }
  markImageUnavailable(image);
}

function emitEvent(type, { sku, checkoutId } = {}) {
  if (!EVENT_TYPES.has(type)) return;
  const body = { type };
  if (typeof sku === 'string' && sku) body.sku = sku;
  if (typeof checkoutId === 'string' && checkoutId) body.checkoutId = checkoutId;
  fetch(apiPath('/api/events'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true
  }).catch(() => { /* event collection must not interrupt browsing */ });
}

async function requestJson(path, options = {}) {
  const response = await fetch(apiPath(path), options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || `Request failed (${response.status}).`, payload.code || '', response.status);
  return payload;
}

function inferCatalogKind(item) {
  const text = `${item.category || ''} ${item.watchType || ''}`.toLowerCase();
  return /cover|accessor/.test(text) ? 'accessory' : 'watch';
}

function strictProduct(item) {
  if (state.commerce.status !== 'ready' || !state.commerce.payload) return null;
  const commerce = state.commerce.payload;
  const product = state.commerce.products.get(String(item.sku));
  if (!commerce.checkoutEnabled || commerce.currency !== 'USD' || commerce.shippingCountry !== 'US') return null;
  if (!product || product.sku !== String(item.sku) || product.available !== true) return null;
  if (typeof product.model !== 'string' || !product.model.trim() || typeof product.variant !== 'string' || !product.variant.trim()) return null;
  if (!['watch', 'accessory'].includes(product.kind) || product.kind !== inferCatalogKind(item)) return null;
  if (!['NEW', 'USED_EXCELLENT', 'USED_GOOD'].includes(product.condition)) return null;
  if (!Number.isInteger(product.priceCents) || product.priceCents <= 0) return null;
  return product;
}

function productReason(item) {
  if (state.commerce.status === 'loading') return 'Checking verified availability…';
  if (state.commerce.status === 'error') return 'Commercial verification unavailable — browse only.';
  const product = state.commerce.products.get(String(item.sku));
  if (product && typeof product.reason === 'string' && product.reason.trim()) return `Browse only — ${product.reason.trim()}`;
  if (state.commerce.payload && state.commerce.payload.checkoutEnabled === false) return 'Browse only — checkout is not live.';
  return 'Browse only — exact commercial details are not verified.';
}

function cartEntries() {
  const byId = new Map(state.catalog.map(item => [item.id, item]));
  return Object.entries(state.bag)
    .map(([id, quantity]) => ({ item: byId.get(id), quantity: Number(quantity) }))
    .filter(entry => entry.item && Number.isInteger(entry.quantity) && entry.quantity > 0)
    .sort((a, b) => String(a.item.sku).localeCompare(String(b.item.sku)));
}

function cartLines(entries = cartEntries()) {
  return entries.map(({ item, quantity }) => ({ sku: String(item.sku), quantity }));
}

function cartSignature(lines) {
  return JSON.stringify([...lines].sort((a, b) => a.sku.localeCompare(b.sku) || a.quantity - b.quantity));
}

function bagQuantity() {
  return cartEntries().reduce((total, entry) => total + entry.quantity, 0);
}

function checkoutReadiness(lines) {
  if (!lines.length) return { ready: false, message: 'Add an item to request a verified quote.' };
  if (state.commerce.status === 'loading') return { ready: false, message: 'Checking verified commerce availability…' };
  if (state.commerce.status === 'error') return { ready: false, message: 'Commerce information is unavailable. Archive browsing remains available.' };
  const commerce = state.commerce.payload;
  if (!commerce || commerce.checkoutEnabled !== true || commerce.currency !== 'USD' || commerce.shippingCountry !== 'US') {
    return { ready: false, message: commerce?.message || 'Checkout is not currently available.' };
  }
  for (const line of lines) {
    const item = state.catalog.find(candidate => String(candidate.sku) === line.sku);
    if (!item || !strictProduct(item)) return { ready: false, message: 'Every bag item needs an exact verified model, variant, type, condition, price, and availability before it can be quoted.' };
  }
  return { ready: true, message: '' };
}

function sanitizeBagAgainstCatalog() {
  const knownIds = new Set(state.catalog.map(item => item.id));
  let changed = false;
  for (const id of Object.keys(state.bag)) {
    if (!knownIds.has(id)) {
      delete state.bag[id];
      changed = true;
    }
  }
  if (changed) safeSet(CART_KEY, state.bag);
}

function saveBag({ refreshQuote = true } = {}) {
  safeSet(CART_KEY, state.bag);
  if (state.quote.controller) state.quote.controller.abort();
  clearTimeout(state.quote.timer);
  state.quote = { ...state.quote, status: 'stale', signature: '', data: null, ready: false, message: 'Bag changed. Refreshing verified quote…', controller: null, timer: null };
  renderBag();
  if (refreshQuote) scheduleQuoteRefresh();
}

function encodeBag() {
  const items = cartEntries().map(({ item, quantity }) => [item.sku, quantity]);
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, items }));
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return `BAG1.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function renderChips() {
  const categories = ['All', ...new Set(state.catalog.map(item => item.category))];
  chips.innerHTML = categories.map(category => {
    const visual = category === 'All'
      ? '<span class="chip-all-mark" aria-hidden="true">ALL</span>'
      : `<img src="assets/series-icons/${esc(CATEGORY_ICONS[category] || '')}" alt="" loading="lazy" decoding="async">`;
    return `<button class="chip ${category === state.activeCategory ? 'active' : ''}" type="button" data-category="${esc(category)}" aria-pressed="${category === state.activeCategory}">${visual}<span>${esc(category)}</span></button>`;
  }).join('');
}

function applyFilters() {
  if (state.catalogStatus !== 'ready') return;
  const term = search.value.trim().toLowerCase();
  state.filtered = state.catalog.filter(item => {
    const exact = strictProduct(item);
    const commerceWords = exact ? `${exact.title || ''} ${exact.model} ${exact.variant} ${exact.kind} ${exact.condition}` : '';
    const haystack = `${item.category} ${item.catalog} ${item.page} ${item.id} ${item.sku} ${item.watchType || ''} ${commerceWords}`.toLowerCase();
    return (state.activeCategory === 'All' || item.category === state.activeCategory) && (!term || haystack.includes(term));
  });
  if (sort.value === 'model') {
    state.filtered.sort((a, b) => {
      const aLabel = strictProduct(a)?.model || a.category;
      const bLabel = strictProduct(b)?.model || b.category;
      return aLabel.localeCompare(bLabel) || a.position - b.position;
    });
  } else {
    state.filtered.sort((a, b) => a.page - b.page || a.position - b.position);
  }
  $('#resultCount').textContent = `${state.filtered.length} ${state.filtered.length === 1 ? 'item' : 'items'}`;
  renderGrid();
}

function renderGrid() {
  if (state.catalogStatus !== 'ready') return;
  if (!state.filtered.length) {
    grid.innerHTML = '<div class="empty-results"><b>No archive items match this search.</b><span>Clear the search or choose another category.</span></div>';
    return;
  }
  grid.innerHTML = state.filtered.map(item => {
    const product = strictProduct(item);
    const featured = isFeatured(item) ? ' featured' : '';
    const badge = item.featuredLabel ? `<span class="feature-badge">${esc(item.featuredLabel)}</span>` : '';
    const title = product ? `${product.model} · ${product.variant}` : item.category;
    const details = product
      ? `${product.kind === 'watch' ? 'Watch' : 'Accessory'} · ${formatCondition(product.condition)}`
      : `${item.watchType || inferCatalogKind(item)} · Page ${item.page}`;
    const availability = product
      ? `<div class="verified-commerce"><span>${formatMoney(product.priceCents)} USD</span><small>${esc(product.shippingSummary || 'Shipping treatment confirmed in quote.')}</small></div>`
      : `<p class="browse-state">${esc(productReason(item))}</p>`;
    const actions = product
      ? `<div class="card-actions commerce-actions"><button class="buy-btn" type="button" data-action="buy">Buy on eBay</button><button class="add-btn" type="button" data-action="add">Add to bag</button></div>`
      : `<div class="card-actions"><button class="add-btn" type="button" data-action="add">Add to bag</button></div>`;
    return `<article class="card${featured}" data-id="${esc(item.id)}"><button class="image-wrap" type="button" data-action="zoom" aria-label="View image for ${esc(title)}">${imageMarkup(item)}${badge}<span class="zoom-pill">VIEW</span></button><div class="card-body"><div class="card-kicker"><span>ITEM ${esc(item.sku)}</span><span>#${esc(item.catalog)}</span></div><h3>${esc(title)}</h3><p>${esc(details)}</p>${availability}${actions}</div></article>`;
  }).join('');
}

function renderCatalogState() {
  const target = $('#catalogState');
  if (state.catalogStatus === 'loading') {
    target.innerHTML = '<div class="loading-state">Loading the archive catalog…</div>';
    return;
  }
  if (state.catalogStatus === 'error') {
    target.innerHTML = `<div class="error-state"><b>Catalog unavailable.</b><span>${esc(state.catalogError || 'The archive data could not be loaded.')}</span><button class="secondary small" type="button" data-action="retry-catalog">Retry catalog</button></div>`;
    return;
  }
  target.innerHTML = '';
}

function renderCommerceNotice() {
  const notice = $('#commerceNotice');
  if (state.commerce.status === 'loading') {
    notice.hidden = false;
    notice.textContent = 'Checking verified purchasing availability. Archive browsing remains available.';
    return;
  }
  if (state.commerce.status === 'error') {
    notice.hidden = false;
    notice.innerHTML = `<span>Commerce information is unavailable. The archive remains browse-only.</span><button class="text-btn" type="button" data-action="retry-commerce">Retry availability</button>`;
    return;
  }
  const payload = state.commerce.payload;
  const mapped = state.catalog.filter(item => strictProduct(item)).length;
  if (!payload?.checkoutEnabled || mapped === 0) {
    notice.hidden = false;
    notice.textContent = payload?.message || 'No verified commercial mappings are available. Archive browsing continues.';
    return;
  }
  notice.hidden = true;
  notice.textContent = '';
}

function renderBag() {
  const entries = cartEntries();
  const lines = cartLines(entries);
  const signature = cartSignature(lines);
  $('#bagCount').textContent = String(bagQuantity());
  $('#bagEmpty').style.display = entries.length ? 'none' : 'flex';
  $('#bagList').innerHTML = entries.map(({ item, quantity }) => {
    const product = strictProduct(item);
    const title = product ? `${product.model} · ${product.variant}` : item.category;
    const description = product
      ? `${product.kind === 'watch' ? 'Watch' : 'Accessory'} · ${formatCondition(product.condition)}`
      : `${item.watchType || inferCatalogKind(item)} · Catalog #${item.catalog}`;
    const price = product ? `<span class="bag-line-price">${formatMoney(product.priceCents)} USD each</span>` : '<span class="bag-line-unverified">Browse-only archive item</span>';
    const reachedLimit = quantity >= MAX_QUANTITY;
    return `<div class="bag-item" data-id="${esc(item.id)}">${imageMarkup(item, 'bag-image')}<div><h4>${esc(title)}</h4><small>Item ${esc(item.sku)} · ${esc(description)}</small>${price}<div class="qty" aria-label="Quantity for item ${esc(item.sku)}"><button type="button" data-change="-1" aria-label="Decrease quantity">−</button><b>${quantity}</b><button type="button" data-change="1" aria-label="Increase quantity" ${reachedLimit ? 'disabled' : ''}>+</button></div></div><button class="remove" type="button" data-action="remove">Remove</button></div>`;
  }).join('');
  $('#bagCodeWrap').hidden = !entries.length;
  if (entries.length) $('#bagCode').value = encodeBag();
  renderQuoteSummary(lines, signature);
  renderCheckoutNotice();
}

function renderQuoteSummary(lines, signature) {
  const summary = $('#quoteSummary');
  const continueButton = $('#continueCheckout');
  const help = $('#checkoutHelp');
  const activeCheckout = activeCheckoutFor(signature);
  const readiness = checkoutReadiness(lines);
  let enabled = false;
  let html = '';

  if (!lines.length) {
    html = '<span class="quote-label">QUOTE</span><b>Add an item to begin</b>';
    help.textContent = 'Your archive selection is saved on this device.';
  } else if (activeCheckout) {
    enabled = true;
    html = `<span class="quote-label">ACTIVE LISTING</span><b>Ready for eBay review</b><span class="quote-detail">This is a generated listing, not a reservation.</span>`;
    help.textContent = 'You will review delivery, tax and payment on eBay.';
  } else if (!readiness.ready) {
    html = `<span class="quote-label">PURCHASING</span><b>Browse-only bag</b><span class="quote-detail">${esc(readiness.message)}</span>`;
    help.textContent = 'Keep the bag for a later verified quote; no price or stock is implied.';
  } else if (state.checkoutPendingSignature === signature) {
    html = '<span class="quote-label">HANDOFF</span><b>Preparing eBay listing…</b><span class="quote-detail">Do not refresh while the server confirms this exact selection.</span>';
    help.textContent = 'Your bag remains saved if preparation cannot proceed.';
  } else if (state.quote.signature !== signature || ['idle', 'stale', 'pending'].includes(state.quote.status)) {
    html = '<span class="quote-label">QUOTE</span><b>Refreshing verified quote…</b><span class="quote-detail">Prices and listing readiness are checked server-side.</span>';
    help.textContent = 'The Continue action becomes available only after a fresh verified quote.';
  } else if (state.quote.status === 'ready' && state.quote.ready && state.quote.data) {
    const quote = state.quote.data;
    const shipping = quote.shippingIncluded === true
      ? `Shipping included${quote.shippingSummary ? ` · ${esc(quote.shippingSummary)}` : ''}`
      : (quote.shippingSummary ? esc(quote.shippingSummary) : 'Shipping treatment is confirmed by the listing.');
    const tax = quote.taxDisclosure || 'Tax calculated by eBay.';
    enabled = true;
    html = `<span class="quote-label">VERIFIED QUOTE</span><div class="quote-total"><b>Quote total</b><strong>${formatMoney(quote.totalCents)} USD</strong></div><span class="quote-detail">${shipping}</span><span class="quote-detail">${esc(tax)}</span>`;
    help.textContent = 'You will review delivery, tax and payment on eBay. This is not labelled as an all-in total.';
  } else {
    const message = state.quote.message || 'This bag could not be quoted. Keep it saved and retry after verification is available.';
    html = `<span class="quote-label">QUOTE UNAVAILABLE</span><b>Not ready for eBay</b><span class="quote-detail">${esc(message)}</span><button class="text-btn quote-retry" type="button" data-action="retry-quote">Retry quote</button>`;
    help.textContent = 'Your bag has not been changed.';
  }
  summary.innerHTML = html;
  continueButton.disabled = !enabled;
}

function validEbayListingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.ebay.com' && url.pathname.startsWith('/itm/');
  } catch {
    return false;
  }
}

function isActiveListing(checkout = state.checkout) {
  if (!checkout || checkout.state !== 'ACTIVE' || !validEbayListingUrl(checkout.listingUrl) || !checkout.expiresAt) return false;
  const deadline = Date.parse(checkout.expiresAt);
  return Number.isFinite(deadline) && deadline > Date.now();
}

function activeCheckoutFor(signature) {
  return state.checkout && state.checkout.cartSignature === signature && isActiveListing(state.checkout) ? state.checkout : null;
}

function renderCheckoutNotice() {
  const notice = $('#checkoutNotice');
  if (!state.checkout) {
    notice.hidden = true;
    notice.textContent = '';
    return;
  }
  if (isActiveListing(state.checkout)) {
    notice.hidden = false;
    notice.innerHTML = `<b>Generated eBay listing active.</b><span>This generated listing may be withdrawn if unsold after <time id="expiryDeadline" datetime="${esc(state.checkout.expiresAt)}"></time>. A completed purchase remains valid.</span><span id="expiryCountdown" class="expiry-countdown"></span>`;
    updateExpiryDisplay();
    startExpiryTimer();
    return;
  }
  stopExpiryTimer();
  if (state.checkout.expiresAt && Date.parse(state.checkout.expiresAt) <= Date.now()) markCheckoutExpired();
  const text = state.checkout.message || (state.checkout.state === 'ENDED_UNSOLD'
    ? 'The generated listing is no longer active. Your bag is retained so you can request a fresh verified quote.'
    : 'The server has not returned an active eBay listing for this checkout. Your bag remains saved.');
  notice.hidden = false;
  notice.textContent = text;
}

function updateExpiryDisplay() {
  if (!isActiveListing(state.checkout)) return;
  const deadline = new Date(state.checkout.expiresAt);
  const deadlineElement = $('#expiryDeadline');
  const countdown = $('#expiryCountdown');
  if (deadlineElement) deadlineElement.textContent = deadline.toLocaleString();
  if (countdown) {
    const seconds = Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    countdown.textContent = `Availability window: ${minutes}:${String(remainder).padStart(2, '0')} remaining`;
  }
}

function startExpiryTimer() {
  stopExpiryTimer();
  if (!isActiveListing(state.checkout)) return;
  state.checkoutTimer = setInterval(() => {
    if (!isActiveListing(state.checkout)) {
      stopExpiryTimer();
      markCheckoutExpired();
      renderBag();
      return;
    }
    updateExpiryDisplay();
  }, 1000);
}

function stopExpiryTimer() {
  if (state.checkoutTimer) clearInterval(state.checkoutTimer);
  state.checkoutTimer = null;
}

function markCheckoutExpired() {
  if (!state.checkout) return;
  if (!state.checkout.expiryEventRecorded) {
    state.checkout.expiryEventRecorded = true;
    persistCheckout();
    emitEvent('expiry', { checkoutId: state.checkout.id });
  }
}

function scheduleQuoteRefresh() {
  const lines = cartLines();
  const signature = cartSignature(lines);
  const readiness = checkoutReadiness(lines);
  if (!readiness.ready) {
    state.quote = { ...state.quote, status: 'unavailable', signature, data: null, ready: false, message: readiness.message };
    renderBag();
    return;
  }
  state.quote = { ...state.quote, status: 'pending', signature, data: null, ready: false, message: '' };
  renderBag();
  state.quote.timer = setTimeout(() => {
    fetchQuote(lines, signature, true).catch(() => { /* rendered in fetchQuote */ });
  }, 360);
}

async function fetchQuote(lines, signature, reflectInBag) {
  const readiness = checkoutReadiness(lines);
  if (!readiness.ready) throw new ApiError(readiness.message, 'NOT_READY');
  if (state.quote.controller) state.quote.controller.abort();
  const controller = new AbortController();
  const requestId = state.quote.requestId + 1;
  state.quote = { ...state.quote, status: 'pending', signature, controller, requestId, message: '' };
  if (reflectInBag) renderBag();
  try {
    const response = await requestJson('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: lines }),
      signal: controller.signal
    });
    if (!response.quote || response.readyToCheckout !== true || !Number.isInteger(response.quote.totalCents)) {
      throw new ApiError(response.message || 'The exact selection is not ready for checkout.', 'NOT_READY');
    }
    const currentSignature = cartSignature(cartLines());
    if (reflectInBag && (requestId !== state.quote.requestId || currentSignature !== signature)) return response;
    if (reflectInBag) {
      state.quote = { ...state.quote, status: 'ready', signature, data: response.quote, ready: true, message: response.message || '', controller: null };
      renderBag();
    }
    emitEvent('quote_success');
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const message = error instanceof ApiError ? error.message : 'The quote service could not be reached.';
    const currentSignature = cartSignature(cartLines());
    if (reflectInBag && requestId === state.quote.requestId && currentSignature === signature) {
      state.quote = { ...state.quote, status: 'failed', signature, data: null, ready: false, message, controller: null };
      renderBag();
    }
    emitEvent('quote_failure');
    throw error;
  }
}

function idempotencyFor(signature) {
  const raw = safeGet(IDEMPOTENCY_KEY, {});
  const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const existing = map[signature];
  if (existing && typeof existing.key === 'string' && existing.key) return existing.key;
  if (!window.crypto || typeof window.crypto.randomUUID !== 'function') throw new Error('This browser cannot create the required checkout idempotency key.');
  const keys = Object.entries(map).sort((a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0));
  while (keys.length >= 50) {
    const [oldSignature] = keys.shift();
    delete map[oldSignature];
  }
  const key = window.crypto.randomUUID();
  map[signature] = { key, createdAt: Date.now() };
  safeSet(IDEMPOTENCY_KEY, map);
  return key;
}

async function beginCheckout(lines, { direct = false } = {}) {
  const signature = cartSignature(lines);
  const readiness = checkoutReadiness(lines);
  if (!readiness.ready) {
    showToast(readiness.message);
    if (!direct) renderBag();
    return;
  }
  const existing = activeCheckoutFor(signature);
  if (existing) {
    handoff(existing);
    return;
  }

  state.checkoutPendingSignature = signature;
  if (!direct) renderBag();
  try {
    let quoteResponse;
    const matchingQuote = state.quote.status === 'ready' && state.quote.ready && state.quote.signature === signature;
    if (matchingQuote) quoteResponse = { quote: state.quote.data, readyToCheckout: true };
    else quoteResponse = await fetchQuote(lines, signature, !direct);
    if (!quoteResponse.readyToCheckout || !quoteResponse.quote) throw new ApiError(quoteResponse.message || 'This selection is not ready for checkout.', 'NOT_READY');

    const response = await requestJson('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: lines, idempotencyKey: idempotencyFor(signature) })
    });
    if (response.quote && signature === cartSignature(cartLines())) {
      state.quote = { ...state.quote, status: 'ready', signature, data: response.quote, ready: true, message: response.message || '', controller: null };
    }
    state.checkout = {
      id: response.id,
      accessToken: response.accessToken,
      cartSignature: signature,
      state: response.state || '',
      listingUrl: response.listingUrl || '',
      expiresAt: response.expiresAt || '',
      message: response.message || '',
      expiryEventRecorded: false
    };
    persistCheckout();
    state.checkoutPendingSignature = '';
    if (isActiveListing(state.checkout)) {
      if (!direct) renderBag();
      handoff(state.checkout);
      return;
    }
    if (!direct) renderBag();
    await checkCheckoutStatus({ quiet: true });
    if (direct && !isActiveListing(state.checkout)) showToast(state.checkout?.message || 'The server has not returned an active eBay listing. Your bag was not changed.');
  } catch (error) {
    state.checkoutPendingSignature = '';
    let message = error instanceof ApiError ? error.message : 'Checkout preparation could not be reached.';
    if (error instanceof ApiError && error.status === 409 && error.code === 'APPROVAL_REQUIRED') {
      message = 'This exact selection is not yet approved for an eBay listing. Your bag remains saved.';
    }
    if (error instanceof ApiError && ['NOT_READY', 'LIVE_NOT_READY'].includes(error.code)) {
      message = error.message || 'Checkout is not live-ready. Your bag remains saved.';
    }
    if (signature === cartSignature(cartLines())) {
      state.quote = { ...state.quote, status: 'failed', signature, data: null, ready: false, message, controller: null };
    }
    if (!direct) renderBag();
    showToast(message);
  }
}

function handoff(checkout) {
  if (!isActiveListing(checkout) || !validEbayListingUrl(checkout.listingUrl)) {
    showToast('No verified eBay listing is available for this checkout.');
    return;
  }
  emitEvent('handoff', { checkoutId: checkout.id });
  window.location.assign(checkout.listingUrl);
}

async function checkCheckoutStatus({ quiet = false } = {}) {
  if (!state.checkout?.id || !state.checkout?.accessToken) return;
  try {
    const result = await requestJson(`/api/checkout/${encodeURIComponent(state.checkout.id)}`, {
      headers: { Authorization: `Bearer ${state.checkout.accessToken}` }
    });
    state.checkout = {
      ...state.checkout,
      state: result.state || state.checkout.state,
      listingUrl: result.listingUrl || '',
      expiresAt: result.expiresAt || '',
      message: result.message || ''
    };
    persistCheckout();
    renderBag();
  } catch (error) {
    if (!quiet) showToast(error instanceof ApiError ? error.message : 'Checkout status could not be refreshed.');
  }
}

function addToBag(item) {
  const current = Number(state.bag[item.id] || 0);
  if (current >= MAX_QUANTITY) {
    showToast(`Bag quantities are limited to ${MAX_QUANTITY} per archive item.`);
    return;
  }
  state.bag[item.id] = current + 1;
  saveBag();
  emitEvent('add_to_bag', { sku: String(item.sku) });
  showToast('Added to bag');
}

function updateBagQuantity(item, delta) {
  const current = Number(state.bag[item.id] || 0);
  const next = current + delta;
  if (next <= 0) {
    delete state.bag[item.id];
    emitEvent('remove_from_bag', { sku: String(item.sku) });
  } else if (next > MAX_QUANTITY) {
    showToast(`Bag quantities are limited to ${MAX_QUANTITY} per archive item.`);
    return;
  } else {
    state.bag[item.id] = next;
  }
  saveBag();
}

function removeFromBag(item) {
  if (!(item.id in state.bag)) return;
  delete state.bag[item.id];
  saveBag();
  emitEvent('remove_from_bag', { sku: String(item.sku) });
}

function activateLayer(name, element, opener) {
  if (state.openLayer && state.openLayer !== name) closeLayer(state.openLayer, false);
  state.openLayer = name;
  state.layerReturnFocus = opener || document.activeElement;
  element.classList.add('open');
  element.setAttribute('aria-hidden', 'false');
  if (name === 'drawer') {
    $('#scrim').classList.add('show');
    $('#bagBtn').setAttribute('aria-expanded', 'true');
  }
  setTimeout(() => {
    const focusable = element.querySelector('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
    (focusable || element).focus();
  }, 0);
}

function closeLayer(name, restoreFocus = true) {
  const element = name === 'drawer' ? drawer : zoomModal;
  element.classList.remove('open');
  element.setAttribute('aria-hidden', 'true');
  if (name === 'drawer') {
    $('#scrim').classList.remove('show');
    $('#bagBtn').setAttribute('aria-expanded', 'false');
  }
  if (state.openLayer === name) {
    state.openLayer = null;
    const opener = state.layerReturnFocus;
    state.layerReturnFocus = null;
    if (restoreFocus && opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
  }
}

function openBag(opener = $('#bagBtn')) {
  renderBag();
  activateLayer('drawer', drawer, opener);
  emitEvent('bag_view');
  const lines = cartLines();
  if (lines.length && state.quote.signature !== cartSignature(lines)) scheduleQuoteRefresh();
  checkCheckoutStatus({ quiet: true });
}

function configureViewer() {
  if (!state.current) return;
  const image = $('#zoomImg');
  const stage = $('#zoomStage');
  const canvas = $('#zoomCanvas');
  const naturalWidth = image.naturalWidth || state.current.sourceWidth || 1;
  const naturalHeight = image.naturalHeight || state.current.sourceHeight || 1;
  const rotation = state.current.viewerRotation || 0;
  const renderedWidth = rotation ? naturalHeight : naturalWidth;
  const renderedHeight = rotation ? naturalWidth : naturalHeight;
  canvas.style.width = `${renderedWidth}px`;
  canvas.style.height = `${renderedHeight}px`;
  image.style.display = '';
  image.style.width = `${naturalWidth}px`;
  image.style.height = `${naturalHeight}px`;
  image.style.transform = rotation ? 'translate(-50%,-50%) rotate(90deg)' : 'translate(-50%,-50%)';
  const stageWidth = Math.max(260, stage.clientWidth - 120);
  const stageHeight = Math.max(260, stage.clientHeight - 100);
  state.fitZoom = Math.min(1, stageWidth / renderedWidth, stageHeight / renderedHeight);
  state.zoom = state.fitZoom;
  applyZoom();
  const sourceLabel = getDetail(state.current) === state.current.image ? 'Source image' : 'Exact tile crop';
  $('#zoomSub').textContent = `Archive ID ${state.current.id} · ${sourceLabel} · ${naturalWidth}×${naturalHeight}px`;
}

function applyZoom() {
  $('#zoomCanvas').style.transform = `scale(${state.zoom})`;
  $('#zoomPct').textContent = `${Math.round(state.zoom * 100)}%`;
  $('#zoomIn').disabled = false;
  $('#zoomOut').disabled = state.zoom <= Math.max(0.1, state.fitZoom * 0.5) + 0.001;
}

function setZoom(value) {
  state.zoom = Math.max(Math.max(0.1, state.fitZoom * 0.5), value);
  applyZoom();
}

function openZoom(item, opener) {
  state.current = { ...item, viewerRotation: (item.detailImage && item.detailImage !== item.image) ? 0 : (item.rotation || 0) };
  const image = $('#zoomImg');
  const terminal = $('#zoomTerminal');
  terminal.hidden = true;
  image.style.display = '';
  image.dataset.fallbackTried = '';
  image.onload = configureViewer;
  image.onerror = () => {
    const fallback = getFallback(item);
    if (fallback && fallback !== getDetail(item) && image.dataset.fallbackTried !== 'true') {
      image.dataset.fallbackTried = 'true';
      image.src = fallback;
      state.current.viewerRotation = item.rotation || 0;
      return;
    }
    image.style.display = 'none';
    terminal.hidden = false;
    $('#zoomSub').textContent = 'The archive image is unavailable.';
  };
  image.src = getDetail(item);
  $('#zoomTitle').textContent = strictProduct(item) ? `${strictProduct(item).model} · ${strictProduct(item).variant}` : item.category;
  $('#zoomMeta').textContent = `ITEM ${item.sku} · ${item.watchType || inferCatalogKind(item)}`;
  $('#zoomSub').textContent = `Catalog #${item.catalog} · Page ${item.page}`;
  activateLayer('modal', zoomModal, opener);
  emitEvent('product_view', { sku: String(item.sku) });
  if (image.complete && image.naturalWidth) configureViewer();
}

async function loadCatalog() {
  state.catalogStatus = 'loading';
  renderCatalogState();
  try {
    const response = await fetch('data/catalog.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Archive data returned ${response.status}.`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('Archive data is not a catalog array.');
    state.catalog = payload.filter(item => item && typeof item.id === 'string' && item.sku !== undefined);
    state.catalogStatus = 'ready';
    state.catalogError = '';
    sanitizeBagAgainstCatalog();
    renderCatalogState();
    renderChips();
    applyFilters();
    renderCommerceNotice();
    renderBag();
    if (state.catalog.length) emitEvent('catalog_view');
    if (cartEntries().length) scheduleQuoteRefresh();
  } catch (error) {
    state.catalogStatus = 'error';
    state.catalogError = error.message || 'The archive data could not be loaded.';
    $('#resultCount').textContent = 'Archive unavailable';
    grid.innerHTML = '';
    renderCatalogState();
  }
}

async function loadCommerce({ retry = false } = {}) {
  if (state.commerce.controller) state.commerce.controller.abort();
  state.commerce.status = 'loading';
  state.commerce.error = '';
  renderCommerceNotice();
  const controller = new AbortController();
  state.commerce.controller = controller;
  if (retry) emitEvent('retry');
  try {
    const payload = await requestJson('/api/commerce', { signal: controller.signal, cache: 'no-store' });
    if (!payload || !Array.isArray(payload.products) || payload.currency !== 'USD' || payload.shippingCountry !== 'US') {
      throw new ApiError('The commerce response does not contain a supported public availability catalog.', 'INVALID_COMMERCE');
    }
    const products = new Map();
    payload.products.forEach(product => {
      if (product && typeof product.sku === 'string') products.set(product.sku, product);
    });
    state.commerce = { status: 'ready', payload, products, error: '', controller: null };
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.commerce = { status: 'error', payload: null, products: new Map(), error: error.message || 'Commerce information could not be loaded.', controller: null };
  }
  renderCommerceNotice();
  if (state.catalogStatus === 'ready') {
    applyFilters();
    renderBag();
    if (cartEntries().length) scheduleQuoteRefresh();
  }
}

function trapFocus(event) {
  if (event.key !== 'Tab' || !state.openLayer) return;
  const root = state.openLayer === 'drawer' ? drawer : zoomModal;
  const focusable = [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && element.offsetParent !== null);
  if (!focusable.length) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function bindEvents() {
  chips.addEventListener('click', event => {
    const button = event.target.closest('.chip');
    if (!button) return;
    state.activeCategory = button.dataset.category || 'All';
    renderChips();
    applyFilters();
  });

  grid.addEventListener('click', event => {
    const card = event.target.closest('.card');
    if (!card) return;
    const item = state.catalog.find(candidate => candidate.id === card.dataset.id);
    if (!item) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'add') addToBag(item);
    else if (action === 'buy') beginCheckout([{ sku: String(item.sku), quantity: 1 }], { direct: true });
    else if (action === 'zoom') openZoom(item, event.target.closest('button'));
  });
  grid.addEventListener('error', event => {
    if (event.target.tagName === 'IMG') handleImageError(event.target);
  }, true);

  $('#catalogState').addEventListener('click', event => {
    if (event.target.closest('[data-action="retry-catalog"]')) {
      emitEvent('retry');
      loadCatalog();
    }
  });
  $('#commerceNotice').addEventListener('click', event => {
    if (event.target.closest('[data-action="retry-commerce"]')) loadCommerce({ retry: true });
  });

  $('#bagList').addEventListener('click', event => {
    const row = event.target.closest('.bag-item');
    if (!row) return;
    const item = state.catalog.find(candidate => candidate.id === row.dataset.id);
    if (!item) return;
    const change = event.target.closest('[data-change]')?.dataset.change;
    if (change) updateBagQuantity(item, Number(change));
    if (event.target.closest('[data-action="remove"]')) removeFromBag(item);
  });
  $('#bagList').addEventListener('error', event => {
    if (event.target.tagName === 'IMG') handleImageError(event.target);
  }, true);

  $('#quoteSummary').addEventListener('click', event => {
    if (event.target.closest('[data-action="retry-quote"]')) {
      emitEvent('retry');
      scheduleQuoteRefresh();
    }
  });
  $('#continueCheckout').addEventListener('click', () => beginCheckout(cartLines()));
  $('#bagBtn').addEventListener('click', event => openBag(event.currentTarget));
  $('#closeBag').addEventListener('click', () => closeLayer('drawer'));
  $('#scrim').addEventListener('click', () => closeLayer('drawer'));
  $('#copyCode').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#bagCode').value);
      showToast('Selection code copied');
    } catch {
      showToast('Copy is unavailable in this browser.');
    }
  });

  $('#closeModal').addEventListener('click', () => closeLayer('modal'));
  $('#zoomIn').addEventListener('click', () => setZoom(state.zoom + 0.12));
  $('#zoomOut').addEventListener('click', () => setZoom(state.zoom - 0.12));
  $('#modalAdd').addEventListener('click', () => { if (state.current) addToBag(state.current); });
  $('#zoomStage').addEventListener('wheel', event => {
    if (!state.current) return;
    event.preventDefault();
    setZoom(state.zoom + (event.deltaY < 0 ? 0.08 : -0.08));
  }, { passive: false });
  $('#zoomStage').addEventListener('dblclick', () => setZoom(Math.abs(state.zoom - state.fitZoom) < 0.02 ? state.fitZoom * 2.5 : state.fitZoom));

  search.addEventListener('input', applyFilters);
  sort.addEventListener('change', applyFilters);
  $('#clearFilters').addEventListener('click', () => {
    state.activeCategory = 'All';
    search.value = '';
    sort.value = 'source';
    renderChips();
    applyFilters();
  });
  const browse = () => $('#catalog').scrollIntoView({ behavior: 'smooth' });
  $('#browseBtn').addEventListener('click', browse);
  $('#enterCatalog').addEventListener('click', browse);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.openLayer) {
      closeLayer(state.openLayer);
      return;
    }
    trapFocus(event);
  });
  window.addEventListener('resize', () => {
    if (state.current && zoomModal.classList.contains('open') && $('#zoomImg').naturalWidth) configureViewer();
  });
  window.addEventListener('focus', () => checkCheckoutStatus({ quiet: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkCheckoutStatus({ quiet: true });
  });
}

function init() {
  bindEvents();
  renderBag();
  loadCatalog();
  loadCommerce();
  checkCheckoutStatus({ quiet: true });
}

init();
