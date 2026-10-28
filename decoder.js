'use strict';
const $ = selector => document.querySelector(selector);
let catalog = [];
let ready = false;
function esc(value) { return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function decode(code) {
  const text = String(code || '').trim();
  if (!text) throw Error('Paste a selection code first.');
  if (text.length > 50000) throw Error('That selection code is too long.');
  let payload;
  if (text.startsWith('{')) payload = JSON.parse(text);
  else {
    const token = text.replace(/^[\s'"`]+|[\s'"`]+$/g,'').replace(/^BAG1\./,'');
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw Error('Use a complete BAG1 selection code.');
    const base64 = token.replace(/-/g,'+').replace(/_/g,'/');
    payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), char => char.charCodeAt(0))));
  }
  if (payload?.v !== 1 || !Array.isArray(payload.items) || payload.items.length > 592) throw Error('Unsupported selection format.');
  for (const line of payload.items) if (!Array.isArray(line) || line.length !== 2 || typeof line[0] !== 'string' || !Number.isSafeInteger(line[1]) || line[1] < 1 || line[1] > 50) throw Error('The selection contains an invalid item or quantity.');
  return payload;
}
function render(payload) {
  let total = 0;
  const valid = [];
  for (const [key, quantity] of payload.items) {
    const item = catalog.find(entry => entry.sku === key || entry.id === key);
    if (item) { total += quantity; valid.push([item, quantity]); }
  }
  $('#decodedTitle').textContent = `${total} item${total === 1 ? '' : 's'} · ${valid.length} selections`;
  $('#decodedGrid').innerHTML = valid.map(([item, quantity]) => `<article class="decoded-item"><img src="${esc(item.thumb || item.image)}" alt="${esc(item.category)}"><div><h4>Item ${esc(item.sku)} · ${esc(item.category)}</h4><p>${esc(item.watchType || 'Watch')} · Catalog #${esc(item.catalog)}</p><b>Quantity ${quantity}</b></div></article>`).join('');
  $('#decodeStatus').textContent = valid.length ? `Decoded ${valid.length} selections. This code is a saved selection, not an order or payment.` : 'Code decoded, but no matching archive entries were found.';
}
async function loadCatalog() {
  ready = false; $('#decodeBtn').disabled = true; $('#decodeStatus').textContent = 'Loading archive…';
  try {
    const response = await fetch('data/catalog.json');
    if (!response.ok) throw Error('load');
    const data = await response.json();
    if (!Array.isArray(data)) throw Error('shape');
    catalog = data; ready = true; $('#decodeBtn').disabled = false; $('#decodeStatus').textContent = 'Paste a saved BAG1 selection to view its items.';
  } catch {
    $('#decodeStatus').textContent = 'The archive could not load. Your code is unchanged. Use Clear / retry to load it again.';
  }
}
$('#decodeBtn').onclick = () => {
  if (!ready) return;
  try { render(decode($('#decodeInput').value)); }
  catch (error) { $('#decodeStatus').textContent = error.message; $('#decodedTitle').textContent = 'Could not decode'; $('#decodedGrid').innerHTML = ''; }
};
$('#clearDecode').onclick = () => {
  if (!ready) { loadCatalog(); return; }
  $('#decodeInput').value = ''; $('#decodeStatus').textContent = ''; $('#decodedTitle').textContent = 'No selection loaded'; $('#decodedGrid').innerHTML = '';
};
loadCatalog();
