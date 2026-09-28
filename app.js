const $ = s => document.querySelector(s);
let catalog = [], filtered = [], active = 'All';
let bag = JSON.parse(localStorage.getItem('gshockBag') || '{}');
let current = null, zoom = 1, fitZoom = 1;

const grid = $('#grid');
const chips = $('#chips');
const search = $('#search');
const sort = $('#sort');

function esc(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1400)}
function bagQty(){return Object.values(bag).reduce((a,b)=>a+b,0)}
function save(){localStorage.setItem('gshockBag',JSON.stringify(bag));renderBag()}
function encodeBag(){const entries=Object.entries(bag).filter(([,q])=>q>0).map(([id,q])=>{const item=catalog.find(x=>x.id===id);return [item?item.sku:id,q]});const payload=JSON.stringify({v:1,items:entries});const bytes=new TextEncoder().encode(payload);let bin='';bytes.forEach(b=>bin+=String.fromCharCode(b));return 'BAG1.'+btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}

function getThumb(item){return item.thumb || item.image}
function getDetail(item){return item.detailImage || item.image}
function getFallback(item){return item.image || item.thumb || ''}
function isFeatured(item){return Boolean(item.featuredLabel)}

function imageMarkup(item, cls=''){
  const src = getThumb(item);
  const fallback = getFallback(item);
  const alt = `${item.category} catalog ${item.catalog}`;
  return `<img class="${cls}" loading="lazy" decoding="async" src="${src}" data-fallback="${fallback}" alt="${esc(alt)}">`;
}

function renderChips(){
  const cats=['All',...new Set(catalog.map(x=>x.category))];
  chips.innerHTML = cats.map(c=>`<button class="chip ${c===active?'active':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  chips.onclick = e => {
    const b = e.target.closest('.chip');
    if(!b) return;
    active = b.dataset.cat;
    renderChips();
    apply();
  };
}

function apply(){
  const q = search.value.trim().toLowerCase();
  filtered = catalog.filter(x => {
    const hay = `${x.category} ${x.catalog} ${x.page} ${x.id} ${x.sku}`.toLowerCase();
    return (active==='All'||x.category===active) && (!q || hay.includes(q));
  });

  if(sort.value==='model') filtered.sort((a,b)=>a.category.localeCompare(b.category)||a.position-b.position);
  else filtered.sort((a,b)=>a.page-b.page||a.position-b.position);

  $('#resultCount').textContent = `${filtered.length} ${filtered.length===1?'item':'items'}`;
  renderGrid();
}

function renderGrid(){
  grid.innerHTML = filtered.map(item => {
    const featured = isFeatured(item) ? ' featured' : '';
    const badge = item.featuredLabel ? `<span class="feature-badge">${esc(item.featuredLabel)}</span>` : '';
    return `
      <article class="card${featured}" data-id="${item.id}">
        <div class="image-wrap">
          ${imageMarkup(item)}
          ${badge}
          <span class="zoom-pill">VIEW</span>
        </div>
        <div class="card-body">
          <div class="card-kicker"><span>ITEM ${esc(item.sku)}</span><span>#${esc(item.catalog)}</span></div>
          <h3>${esc(item.category)}</h3>
          <p>${esc(item.watchType||'Watch')} · Page ${item.page}</p>
          <div class="card-actions"><button class="add-btn">Add to bag</button></div>
        </div>
      </article>`;
  }).join('');
}

grid.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if(!card) return;
  const item = catalog.find(x=>x.id===card.dataset.id);
  if(!item) return;
  if(e.target.closest('.add-btn')){
    bag[item.id]=(bag[item.id]||0)+1; save(); toast('Added to bag');
  } else if(e.target.closest('.image-wrap')) openZoom(item);
});

grid.addEventListener('error', e => {
  const img = e.target;
  if(img.tagName !== 'IMG') return;
  const fallback = img.dataset.fallback;
  if(fallback && img.src.indexOf(fallback)===-1){ img.src = fallback; }
}, true);

function renderBag(){
  const entries = Object.entries(bag).filter(([,q])=>q>0).map(([id,q])=>[catalog.find(x=>x.id===id),q]).filter(([x])=>x);
  $('#bagCount').textContent = bagQty();
  $('#bagEmpty').style.display = entries.length ? 'none' : 'flex';
  $('#bagCodeWrap').style.display = entries.length ? 'block' : 'none';
  $('#bagList').innerHTML = entries.map(([item,q]) => `
    <div class="bag-item" data-id="${item.id}">
      ${imageMarkup(item)}
      <div>
        <h4>Item ${esc(item.sku)} · ${esc(item.category)}</h4>
        <small>${esc(item.watchType||'Watch')} · Catalog #${esc(item.catalog)}</small>
        <div class="qty"><button data-d="-1">−</button><b>${q}</b><button data-d="1">+</button></div>
      </div>
      <button class="remove">Remove</button>
    </div>`).join('');
  if(entries.length) $('#bagCode').value = encodeBag();
}

$('#bagList').onclick = e => {
  const row = e.target.closest('.bag-item');
  if(!row) return;
  const id = row.dataset.id;
  if(e.target.matches('[data-d]')){
    bag[id]=(bag[id]||0)+Number(e.target.dataset.d); if(bag[id]<=0) delete bag[id]; save();
  }
  if(e.target.classList.contains('remove')){ delete bag[id]; save(); }
};
$('#bagList').addEventListener('error', e => {
  const img = e.target; if(img.tagName!=='IMG') return; const fallback = img.dataset.fallback; if(fallback && img.src.indexOf(fallback)===-1) img.src=fallback;
}, true);

function openBag(){renderBag();$('#bagDrawer').classList.add('open');$('#scrim').classList.add('show');$('#bagDrawer').setAttribute('aria-hidden','false')}
function closeBag(){$('#bagDrawer').classList.remove('open');$('#scrim').classList.remove('show');$('#bagDrawer').setAttribute('aria-hidden','true')}
$('#bagBtn').onclick=openBag;$('#closeBag').onclick=closeBag;$('#scrim').onclick=closeBag;
$('#copyCode').onclick=async()=>{await navigator.clipboard.writeText($('#bagCode').value);toast('Selection code copied')};

function configureViewer(){
  if(!current) return;
  const img = $('#zoomImg');
  const stage = $('#zoomStage');
  const canvas = $('#zoomCanvas');
  const naturalW = img.naturalWidth || current.sourceWidth || 1;
  const naturalH = img.naturalHeight || current.sourceHeight || 1;
  const rot = current.viewerRotation || 0;
  const renderedW = rot ? naturalH : naturalW;
  const renderedH = rot ? naturalW : naturalH;

  canvas.style.width = renderedW + 'px';
  canvas.style.height = renderedH + 'px';
  img.style.width = naturalW + 'px';
  img.style.height = naturalH + 'px';
  img.style.transform = rot ? 'translate(-50%,-50%) rotate(90deg)' : 'translate(-50%,-50%)';

  const sw = Math.max(260, stage.clientWidth - 120);
  const sh = Math.max(260, stage.clientHeight - 100);
  fitZoom = Math.min(1, sw/renderedW, sh/renderedH);
  zoom = fitZoom;
  applyZoom();

  const shown = getDetail(current) === current.image ? 'Source image' : 'Exact tile crop';
  $('#zoomSub').textContent = `Archive ID ${current.id} · ${shown} · ${naturalW}×${naturalH}px`;
}
function applyZoom(){
  $('#zoomCanvas').style.transform = `scale(${zoom})`;
  $('#zoomPct').textContent = `${Math.round(zoom*100)}%`;
  $('#zoomIn').disabled = false;
  $('#zoomOut').disabled = zoom <= Math.max(0.1, fitZoom*0.5) + 0.001;
}
function setZoom(v){ zoom = Math.max(Math.max(0.1, fitZoom*0.5), v); applyZoom(); }

function openZoom(item){
  current = {...item};
  current.viewerRotation = (item.detailImage && item.detailImage!==item.image) ? 0 : (item.rotation||0);
  const img = $('#zoomImg');
  img.onload = configureViewer;
  img.onerror = ()=>{
    const fallback = item.image;
    if(fallback && img.src.indexOf(fallback)===-1){ img.src = fallback; current.viewerRotation = item.rotation||0; }
  };
  img.src = getDetail(item);
  $('#zoomTitle').textContent = item.category;
  $('#zoomMeta').textContent = `ITEM ${item.sku} · ${item.watchType||'Watch'}`;
  $('#zoomSub').textContent = `Catalog #${item.catalog} · Page ${item.page}`;
  $('#zoomModal').classList.add('open');
  $('#zoomModal').setAttribute('aria-hidden','false');
  if(img.complete) configureViewer();
}
function closeZoom(){$('#zoomModal').classList.remove('open');$('#zoomModal').setAttribute('aria-hidden','true')}
$('#closeModal').onclick=closeZoom;
$('#zoomIn').onclick=()=>setZoom(zoom+0.12);
$('#zoomOut').onclick=()=>setZoom(zoom-0.12);
$('#modalAdd').onclick=()=>{if(!current)return;bag[current.id]=(bag[current.id]||0)+1;save();toast('Added to bag')};
$('#zoomStage').addEventListener('wheel',e=>{if(!current)return;e.preventDefault();setZoom(zoom+(e.deltaY<0?0.08:-0.08))},{passive:false});
$('#zoomStage').addEventListener('dblclick',()=>setZoom(Math.abs(zoom-fitZoom)<0.02?fitZoom*2.5:fitZoom));
window.addEventListener('resize',()=>{if(current&&$('#zoomModal').classList.contains('open'))configureViewer()});

search.oninput=apply;
sort.onchange=apply;
$('#clearFilters').onclick=()=>{active='All';search.value='';sort.value='source';renderChips();apply()};
$('#browseBtn').onclick=$('#enterCatalog').onclick=()=>$('#catalog').scrollIntoView({behavior:'smooth'});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeBag();closeZoom()}});

fetch('data/catalog.json').then(r=>r.json()).then(d=>{catalog=d;renderChips();apply();renderBag()});
