const $=s=>document.querySelector(s);
let products=[],shown=[];
function esc(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function money(n){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n)}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1500)}
function renderFilters(){const cats=['All',...new Set(products.map(x=>x.category))];$('#dropCategory').innerHTML=cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}
function apply(){
  const q=$('#dropSearch').value.trim().toLowerCase(),cat=$('#dropCategory').value,sort=$('#dropSort').value;
  shown=products.filter(p=>(cat==='All'||p.category===cat)&&(!q||`${p.title} ${p.category} ${p.compatibility} ${p.supplier}`.toLowerCase().includes(q)));
  if(sort==='markup')shown.sort((a,b)=>b.markup-a.markup);
  else if(sort==='margin')shown.sort((a,b)=>b.grossMarginPct-a.grossMarginPct);
  else if(sort==='cost')shown.sort((a,b)=>a.sourceCost-b.sourceCost);
  else shown.sort((a,b)=>a.priority-b.priority||b.markup-a.markup);
  render();
}
function render(){
  $('#dropshipGrid').innerHTML=shown.map(p=>`
    <article class="drop-card">
      <div class="drop-visual"><img src="assets/dropship/${p.icon}.svg" alt=""><span class="drop-badge">${esc(p.badge)}</span></div>
      <div class="drop-body">
        <div class="drop-meta"><span>${esc(p.category)}</span><span>${esc(p.id)}</span></div>
        <h3>${esc(p.title)}</h3>
        <p class="drop-short">${esc(p.short)}</p>
        <div class="drop-compat"><b>Fits</b><span>${esc(p.compatibility)}</span></div>
        <div class="profit-grid">
          <div><small>Supplier</small><strong>${money(p.sourceCost)}</strong></div>
          <div><small>Target retail</small><strong>${money(p.targetRetail)}</strong></div>
          <div><small>Markup</small><strong>${p.markup.toFixed(2)}×</strong></div>
          <div><small>Gross margin</small><strong>${p.grossMarginPct.toFixed(1)}%</strong></div>
        </div>
        <details><summary>Research notes</summary><p>${esc(p.description)}</p><small>${esc(p.supplier)} · checked ${esc(p.sourceDate)}</small></details>
        <div class="drop-actions">
          <a class="primary small" href="${p.sourceUrl}" target="_blank" rel="noopener">Open supplier</a>
          <a class="secondary small" href="${p.researchUrl}" target="_blank" rel="noopener">Price research</a>
        </div>
      </div>
    </article>`).join('');
}
$('#dropSearch').oninput=apply;$('#dropCategory').onchange=apply;$('#dropSort').onchange=apply;
$('#copySuppliers').onclick=async()=>{await navigator.clipboard.writeText(products.map(p=>`${p.id}\t${p.title}\t${p.sourceUrl}`).join('\n'));toast('Supplier links copied')};
fetch('data/dropship.json').then(r=>r.json()).then(d=>{products=d;const avg=products.reduce((s,p)=>s+p.markup,0)/products.length;$('#labCount').textContent=products.length;$('#avgMarkup').textContent=avg.toFixed(1)+'×';renderFilters();apply()});
