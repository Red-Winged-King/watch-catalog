import test from 'node:test';
import assert from 'node:assert/strict';
// Opt in against the real local server; never calls eBay or writes sellable data.
const base=process.env.WATCH_HTTP_TEST_ORIGIN;
test('real server reports schema health and honest unconfigured commerce',{skip:!base},async()=>{
 const health=await fetch(`${base}/health`);assert.equal(health.status,200);assert.equal((await health.json()).mode,'live-gated');
 const manifest=await fetch(`${base}/manus-routes.json`);assert.equal(manifest.status,200);const routes=await manifest.json();assert.deepEqual(routes.routes.map((x:{path:string})=>x.path),['/','/decoder.html','/admin.html']);
 const me=await fetch(`${base}/api/auth/me`);assert.equal(me.status,200);assert.equal((await me.json()).authenticated,false);
});
test('real server rejects anonymous owner and scheduler operations',{skip:!base},async()=>{
 const owner=await fetch(`${base}/api/admin/products/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({products:[]})});assert.equal(owner.status,401);
 const cron=await fetch(`${base}/api/scheduled/expire`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(cron.status,401);
 const origin=await fetch(`${base}/api/checkout`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://attacker.invalid'},body:'{}'});assert.equal(origin.status,403);
});
