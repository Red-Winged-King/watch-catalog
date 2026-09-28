const $=s=>document.querySelector(s);
let catalog=[];
function esc(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function getThumb(item){return item.thumb || item.image}
function decode(code){
  let text=String(code||'').trim();
  if(!text) throw Error('Paste a selection code first.');
  const first=text.indexOf('{'), last=text.lastIndexOf('}');
  let payload;
  if(first>=0 && last>first){
    payload=JSON.parse(text.slice(first,last+1));
  } else {
    text=text.replace(/^[\'\"`]+|[\'\"`]+$/g,'').replace(/\s+/g,'');
    let token=text;
    if(text.includes('.')) token=text.slice(text.lastIndexOf('.')+1);
    if(!/^[A-Za-z0-9_-]{12,}$/.test(token)){
      const dotted=String(code).match(/[A-Za-z0-9_-]{1,24}\.([A-Za-z0-9_-]{20,})/);
      if(dotted) token=dotted[1];
      else {
        const tokens=String(code).match(/[A-Za-z0-9_-]{20,}/g)||[];
        if(!tokens.length) throw Error('Could not recognize the selection code.');
        tokens.sort((a,b)=>b.length-a.length); token=tokens[0];
      }
    }
    let b64=token.replace(/-/g,'+').replace(/_/g,'/');
    while(b64.length%4) b64+='=';
    const bin=atob(b64), bytes=Uint8Array.from(bin,c=>c.charCodeAt(0));
    payload=JSON.parse(new TextDecoder().decode(bytes));
  }
  if(payload.v!==1 || !Array.isArray(payload.items)) throw Error('Unsupported selection format.');
  return payload;
}
function render(payload){
  let total=0, valid=[];
  for(const [id,q0] of payload.items){
    const q=Math.max(1, Number(q0)||1), key=String(id), item=catalog.find(a=>a.sku===key||a.id===key);
    if(item){ total+=q; valid.push([item,q]); }
  }
  $('#decodedTitle').textContent=`${total} item${total===1?'':'s'} · ${valid.length} unique`;
  $('#decodedGrid').innerHTML=valid.map(([item,q])=>`<article class="decoded-item"><img src="${getThumb(item)}" alt="${esc(item.category)}"><div><h4>Item ${esc(item.sku)} · ${esc(item.category)}</h4><p>${esc(item.watchType||'Watch')} · Catalog #${esc(item.catalog)}</p><b>Quantity ${q}</b></div></article>`).join('');
  $('#decodeStatus').textContent=valid.length?`Decoded ${valid.length} unique catalog entries successfully.`:'Code decoded, but no matching archive entries were found.';
}
$('#decodeBtn').onclick=()=>{try{render(decode($('#decodeInput').value.trim()))}catch(e){$('#decodeStatus').textContent=e.message;$('#decodedTitle').textContent='Could not decode';$('#decodedGrid').innerHTML=''}};
$('#clearDecode').onclick=()=>{$('#decodeInput').value='';$('#decodeStatus').textContent='';$('#decodedTitle').textContent='No selection loaded';$('#decodedGrid').innerHTML=''};
fetch('data/catalog.json').then(r=>r.json()).then(d=>catalog=d);
document.addEventListener('error',e=>{const img=e.target;if(img.tagName!=='IMG')return;const fallback=img.dataset?.fallback;if(fallback&&img.src.indexOf(fallback)===-1)img.src=fallback;},true);
