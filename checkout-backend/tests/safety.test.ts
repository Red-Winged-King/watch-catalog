import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import type { Request } from 'express';
import { reconcileCheckout, sweep, publicCheckout, type EbayAdapter } from '../server/checkout/lifecycle.js';
import { identity, requireAdmin, csrf } from '../server/admin/auth.js';
import type { Checkout, SaleEvidence } from '../server/contracts.js';
import type { Store } from '../server/store.js';

function memory() {
 const values=new Map<string,unknown>();
 return {get:async(c:string,n:string)=>values.get(`${c}:${n}`)||null,put:async(c:string,n:string,v:unknown)=>{values.set(`${c}:${n}`,structuredClone(v));},list:async(c:string)=>[...values].filter(([k])=>k.startsWith(`${c}:`)).map(([,v])=>structuredClone(v)),batch:async(rows:{collection:string;name:string;value:unknown}[])=>{for(const r of rows)values.set(`${r.collection}:${r.name}`,structuredClone(r.value));}} as unknown as Store;
}
function fixture(overrides:Partial<Checkout>={}):Checkout { return {id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',basketKey:'basket',draftId:'draft',payloadHash:'hash',cart:[{sku:'1001',quantity:1}],state:'ACTIVE',sku:'wc-test',offerId:'offer',listingId:'123',listingUrl:'https://www.ebay.com/itm/123',createdAt:'2026-10-28T10:00:00.000Z',publishedAt:'2026-10-28T10:00:00.000Z',expiresAt:'2026-10-28T10:10:00.000Z',version:1,attempts:0,estimatedFeeCents:0,...overrides}; }
const observation:SaleEvidence={committed:false,quantitySold:0,listingActive:true,listingId:'123',sku:'wc-test',observedAt:'2026-10-28T10:10:00.000Z',orderIds:[],paymentStatuses:[]};
function adapter(evidence:()=>SaleEvidence):EbayAdapter & {withdrawn:number} {
 const result={withdrawn:0,createInventory:async()=>{},createOffer:async()=>({offerId:'offer'}),getOffer:async()=>({offerId:'offer',sku:'wc-test',status:'PUBLISHED',listingId:'123'}),publish:async()=>({listingId:'123',listingUrl:'https://www.ebay.com/itm/123'}),withdraw:async()=>{result.withdrawn++;return{listingId:'123'};},estimateFees:async()=>0,validateSellerSetup:async()=>({ok:true,issues:[]}),saleEvidence:async()=>evidence()};return result;
}
test('never withdraw before expiresAt',async()=>{const db=memory(),row=fixture(),api=adapter(()=>observation);await reconcileCheckout(db,api,row,new Date('2026-10-28T10:09:59.999Z'));assert.equal(api.withdrawn,0);assert.equal(row.state,'ACTIVE');});
test('pending or failed payment commitment suppresses expiry',async()=>{for(const status of ['PENDING','FAILED','PAID']){const db=memory(),row=fixture(),api=adapter(()=>({...observation,committed:true,orderIds:['1'],paymentStatuses:[status]}));await reconcileCheckout(db,api,row,new Date('2026-10-28T10:11:00Z'));assert.equal(row.state,'COMMITTED');assert.equal(api.withdrawn,0);}});
test('purchase appearing on final check is never withdrawn',async()=>{let count=0;const db=memory(),row=fixture(),api=adapter(()=>++count===1?observation:{...observation,quantitySold:1});await reconcileCheckout(db,api,row,new Date('2026-10-28T10:11:00Z'));assert.equal(api.withdrawn,0);assert.equal(row.state,'COMMITTED');});
test('unsold withdrawal is verified against the exact owned listing',async()=>{let count=0;const db=memory(),row=fixture(),api=adapter(()=>({...observation,listingActive:++count<3}));await reconcileCheckout(db,api,row,new Date('2026-10-28T10:11:00Z'));assert.equal(api.withdrawn,1);assert.equal(row.state,'ENDED_UNSOLD');});
test('purchase discovered after withdrawal remains a commitment',async()=>{let count=0;const db=memory(),row=fixture(),api=adapter(()=>++count<3?observation:{...observation,quantitySold:1,listingActive:false,committed:true});await reconcileCheckout(db,api,row,new Date('2026-10-28T10:11:00Z'));assert.equal(api.withdrawn,1);assert.equal(row.state,'COMMITTED');});
test('inconclusive evidence stops mutation and schedules a durable retry',async()=>{const db=memory(),row=fixture(),api=adapter(()=>{throw new Error('Unavailable');});await db.put('checkouts',row.id,row);const result=await sweep(db,api,new Date('2026-10-28T10:11:00Z'));const saved=await db.get<Checkout>('checkouts',row.id);assert.equal(result.exceptions,1);assert.equal(api.withdrawn,0);assert.equal(saved?.state,'END_RETRY');assert.ok(saved?.nextAttemptAt);});
test('uncertain publication reconciles same offer and never publishes a replacement',async()=>{const db=memory(),row=fixture({state:'PUBLISH_UNCERTAIN',publishedAt:undefined,expiresAt:undefined}),api=adapter(()=>observation);api.publish=async()=>{throw new Error('Must not republish');};await reconcileCheckout(db,api,row,new Date('2026-10-28T10:20:00Z'));assert.equal(api.withdrawn,0);assert.equal(row.expiresAt,'2026-10-28T10:30:00.000Z');});
test('expired public response contains no usable redirect link',async()=>{const db=memory();const result=await publicCheckout(db,fixture({expiresAt:'2020-01-01T00:00:00.000Z'}));assert.equal(result.listingUrl,undefined);});
test('owner access requires a real signed project session, not cookie name or role',async()=>{
 const previous={secret:process.env.MANUS_JWT_SECRET,project:process.env.MANUS_PROJECT_ID,owner:process.env.ADMIN_OPEN_ID};
 process.env.MANUS_JWT_SECRET='safety-test-secret-only';process.env.MANUS_PROJECT_ID='test-project';process.env.ADMIN_OPEN_ID='owner';
 const key=new TextEncoder().encode(process.env.MANUS_JWT_SECRET);
 const token=await new SignJWT({openId:'owner',name:'Owner',appId:'test-project'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(key);
 const req={headers:{cookie:`webdev_app_session=${token}`},get:()=>undefined} as unknown as Request;
 const who=await identity(req);assert.equal(who?.isAdmin,true);assert.ok(who&&csrf(who));
 const invalid={headers:{cookie:'webdev_app_session=fake'},get:()=>undefined} as unknown as Request;assert.equal(await identity(invalid),null);
 const other=await new SignJWT({openId:'intruder',appId:'test-project',role:'admin'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(key);
 await assert.rejects(()=>requireAdmin({headers:{cookie:`webdev_app_session=${other}`}} as Request),/not configured/);
 for(const [name,value] of Object.entries({MANUS_JWT_SECRET:previous.secret,MANUS_PROJECT_ID:previous.project,ADMIN_OPEN_ID:previous.owner})){if(value===undefined)delete process.env[name];else process.env[name]=value;}
});

test('missing signing secret fails before any database or eBay action',async()=>{
 const {beginCheckout}=await import('../server/checkout/lifecycle.js');const old=process.env.MANUS_JWT_SECRET;delete process.env.MANUS_JWT_SECRET;
 let touched=false;const db={get:async()=>{touched=true;return null;}} as unknown as Store;
 try{await assert.rejects(()=>beginCheckout(db,adapter(()=>observation),[{sku:'1001',quantity:1}],'test-signing-missing'),/not configured/);assert.equal(touched,false);}finally{if(old===undefined)delete process.env.MANUS_JWT_SECRET;else process.env.MANUS_JWT_SECRET=old;}
});
test('signed-in non-owner can satisfy logout CSRF without gaining admin privileges',async()=>{
 const {verifySessionMutation}=await import('../server/admin/auth.js');const old=process.env.MANUS_JWT_SECRET;process.env.MANUS_JWT_SECRET='test-only-session-mutation';
 try{
  const user={openId:'not-owner',name:'Member',token:'fixture-token',isAdmin:false};const token=csrf(user);
  const req={get:(key:string)=>key==='Origin'?'https://red-winged-king.github.io':key==='X-CSRF-Token'?token:undefined} as unknown as Request;
  assert.doesNotThrow(()=>verifySessionMutation(req,user));
  assert.throws(()=>verifySessionMutation({get:(key:string)=>key==='Origin'?'https://red-winged-king.github.io':'invalid'} as unknown as Request,user),/Reload/);
 }finally{if(old===undefined)delete process.env.MANUS_JWT_SECRET;else process.env.MANUS_JWT_SECRET=old;}
});
