import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { HttpError, withStore, withLifecycleLock } from '../store.js';
import { requireAdmin, cookies, setEbayNonce, clearEbayNonce, requireOrigin } from './auth.js';
import { validateProducts, validateReferences, validateSettings, parseCart } from '../commerce/index.js';
import { context, currentDraft, catalogSkus, readiness } from '../checkout/context.js';
import type { Product, SoldReference, Draft, Checkout, SellerConnection, ScheduleBinding } from '../contracts.js';
import type { EbayClient } from '../ebay/index.js';

export function adminRouter(ebay: EbayClient):Router {
  const router=Router();
  router.get('/api/admin/dashboard',async(req,res)=>{
    await requireAdmin(req);
    const result=await withStore(async store=>{
      const data=await context(store);const seller=await store.get<SellerConnection>('config','seller');const schedule=await store.get<ScheduleBinding>('config','schedule');
      const checkouts=await store.list<Checkout>('checkouts');const events=await store.list<{type:string;count:number}>('events');
      const totals:Record<string,number>={};for(const event of events)totals[event.type]=(totals[event.type]||0)+event.count;
      return {...data,drafts:await store.list<Draft>('drafts'),checkouts,readiness:await readiness(store,data.settings),seller:{connected:Boolean(seller),sellerName:seller?.sellerName},schedule,metrics:{events:totals,verifiedSales:checkouts.filter(c=>c.state==='COMMITTED'&&c.saleEvidence?.committed).length}};
    });res.json(result);
  });
  router.put('/api/admin/settings',async(req,res)=>{
    await requireAdmin(req,true);const settings=validateSettings(req.body?.settings);
    await withLifecycleLock(store=>store.put('config','settings',settings));res.json({settings});
  });
  router.post('/api/admin/products/import',async(req,res)=>{
    await requireAdmin(req,true);const products=validateProducts(req.body?.products,catalogSkus);
    await withLifecycleLock(store=>store.batch(products.map(product=>({collection:'products',name:product.sku,value:product}))));res.json({imported:products.length});
  });
  router.post('/api/admin/references/import',async(req,res)=>{
    await requireAdmin(req,true);const imported=await withLifecycleLock(async store=>{const products=await store.list<Product>('products');const references=validateReferences(req.body?.references,products);await store.batch(references.map(reference=>({collection:'references',name:reference.sku,value:reference})));return references.length;});res.json({imported});
  });
  router.post('/api/admin/drafts',async(req,res)=>{
    await requireAdmin(req,true);const cart=parseCart(req.body?.items);
    const draft=await withLifecycleLock(async store=>{const draft=await currentDraft(store,cart);const previous=await store.get<Draft>('drafts',draft.id);if(previous?.approvedAt)return previous;await store.put('drafts',draft.id,draft);return draft;});res.json({draft});
  });
  router.post('/api/admin/drafts/:id/approve',async(req,res)=>{
    const owner=await requireAdmin(req,true); const id=String(req.params.id);
    if(!/^[a-f0-9]{64}$/.test(id)||req.body?.confirm!==true||!Number.isSafeInteger(req.body.maxListingFeeCents)||req.body.maxListingFeeCents<0||req.body.maxListingFeeCents>10000)throw new HttpError(400,'APPROVAL','Confirm the exact payload and a valid listing fee ceiling');
    const draft=await withLifecycleLock(async store=>{
      const saved=await store.get<Draft>('drafts',id);if(!saved||saved.payloadHash!==req.body.payloadHash)throw new HttpError(409,'DRAFT_CHANGED','The draft does not match this approval');
      const fresh=await currentDraft(store,saved.cart);
      if(fresh.id!==saved.id||fresh.contextHash!==saved.contextHash||fresh.payloadHash!==saved.payloadHash)throw new HttpError(409,'DRAFT_CHANGED','Product information, price or policies changed. Prepare and review a fresh draft.');
      saved.approvedAt=new Date().toISOString();saved.approvedBy=owner.openId;saved.approvedMaxListingFeeCents=req.body.maxListingFeeCents;
      await store.put('drafts',saved.id,saved);return saved;
    });res.json({draft});
  });
  router.post('/api/admin/ebay/connect',async(req,res)=>{
    const owner=await requireAdmin(req,true);requireOrigin(req);
    const callback=process.env.EBAY_CALLBACK_URL;
    if(!callback||!callback.startsWith('https://')||!process.env.TOKEN_ENCRYPTION_KEY)throw new HttpError(409,'OAUTH_SETUP','Configure EBAY_RUNAME, EBAY_CALLBACK_URL and TOKEN_ENCRYPTION_KEY in protected settings first');
    const nonce=randomBytes(32).toString('base64url');
    await withLifecycleLock(store=>store.put('oauth',nonce,{provider:'ebay',owner:owner.openId,expiresAt:Date.now()+600000,callback}));
    setEbayNonce(res,nonce);res.json({url:ebay.authorizationUrl(nonce)});
  });
  router.get('/api/ebay/callback',async(req,res)=>{
    const owner=await requireAdmin(req);
    const nonce=cookies(req).wc_ebay_nonce;
    if(!nonce||req.query.state!==nonce||typeof req.query.code!=='string')throw new HttpError(400,'OAUTH_STATE','Seller connection expired or browser cookies are blocked');
    await withLifecycleLock(async store=>{
      const record=await store.get<{owner:string;provider:string;expiresAt:number;callback:string}>('oauth',nonce);
      if(!record||record.provider!=='ebay'||record.owner!==owner.openId||record.expiresAt<Date.now()||record.callback!==process.env.EBAY_CALLBACK_URL)throw new HttpError(400,'OAUTH_STATE','Seller connection expired');
      await store.remove('oauth',nonce);
      const connection=await ebay.exchangeCode(String(req.query.code));
      const existing=await store.get<SellerConnection>('config','seller');
      if(existing && existing.sellerId!==connection.sellerId)throw new HttpError(409,'SELLER_MISMATCH','This project is pinned to another seller. Do not reuse its existing offers with this account.');
      await store.put('config','seller',connection);
    });clearEbayNonce(res);res.redirect('/admin.html');
  });
  router.post('/api/admin/schedule',async(req,res)=>{
    await requireAdmin(req,true);const taskUid=req.body?.taskUid;const enabled=req.body?.enabled;
    if(typeof taskUid!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(taskUid)||typeof enabled!=='boolean')throw new HttpError(400,'SCHEDULE','Provide the exact platform schedule task UID and enabled state');
    const schedule:ScheduleBinding={taskUid,enabled};await withLifecycleLock(store=>store.put('config','schedule',schedule));res.json({schedule});
  });
  return router;
}
