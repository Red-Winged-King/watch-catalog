import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { withStore, withLifecycleLock, HttpError } from '../store.js';
import type { Checkout, Draft, CartLine } from '../contracts.js';
import type { EbayClient } from '../ebay/index.js';
import { parseCart } from '../commerce/index.js';
import { context, currentDraft, exactApproval, checkStock, readiness } from './context.js';
import { beginCheckout, publicCheckout, checkoutAccessToken } from './lifecycle.js';
import { EVENT_TYPES, recordEvent } from '../events.js';
import { requireOrigin } from '../admin/auth.js';

async function rate(store: import('../store.js').Store, name: string, max: number): Promise<void> {
  const key=`${name}:${Math.floor(Date.now()/60000)}`;
  const value=await store.get<{count:number}>('rate',key);
  if((value?.count||0)>=max)throw new HttpError(429,'RATE_LIMIT','Too many requests; please retry in a minute');
  await store.put('rate',key,{count:(value?.count||0)+1});
}
export function publicRouter(ebay: EbayClient): Router {
  const router=Router();
  router.get('/api/commerce',async(_req,res)=>{
    const result=await withStore(async store=>{
      const data=await context(store); const ready=await readiness(store,data.settings);
      const products=[];
      for(const product of data.products){
        let priceCents:number|undefined; let available=false; let reason='Product information needs seller review';
        try {
          const draft=await currentDraft(store,[{sku:product.sku,quantity:1}]);
          priceCents=draft.quote.totalCents;
          available=ready.ready && Boolean(await exactApproval(store,draft)) && await checkStock(store,draft.cart,draft.basketKey,data.products);
          reason=available?'':ready.ready?'This exact offer needs seller approval':'eBay checkout is not live yet';
        }catch{}
        products.push({sku:product.sku,title:product.title,model:product.model,variant:product.variant,kind:product.kind,condition:product.condition,priceCents,available,reason,shippingSummary:data.settings.shippingSummary,returnsSummary:data.settings.returnsSummary});
      }
      return {products,currency:'USD',shippingCountry:'US',checkoutEnabled:ready.ready,message:ready.ready?'Review delivery, tax and payment on eBay. Eligible US delivery only.':'Browse the archive and save your bag. eBay checkout is awaiting seller setup.'};
    });res.json(result);
  });
  router.post('/api/quote',async(req,res)=>{
    requireOrigin(req);
    const result=await withLifecycleLock(async store=>{
      await rate(store,'quote',120); const cart=parseCart(req.body?.items); const draft=await currentDraft(store,cart);const data=await context(store);
      if(!(await checkStock(store,cart,draft.basketKey,data.products)))throw new HttpError(409,'STOCK','This selection is not currently available');
      const ready=await readiness(store,data.settings);const approved=await exactApproval(store,draft);
      if (!(await store.get<Draft>('drafts',draft.id))) {
        const queued=await store.list<Draft>('drafts');
        if (queued.length < 1000) await store.put('drafts',draft.id,draft);
      }
      const earlier=(await store.list<Checkout>('checkouts')).find(c=>c.basketKey===draft.basketKey && !['COMMITTED','ENDED_UNSOLD'].includes(c.state));
      const compatible=!earlier || earlier.state==='ACTIVE' && earlier.payloadHash===draft.payloadHash && Boolean(earlier.expiresAt && Date.parse(earlier.expiresAt)>Date.now());
      return {quote:draft.quote,readyToCheckout:ready.ready && Boolean(approved) && compatible,
        message:!ready.ready?'The seller is completing eBay checkout setup. Your bag is saved.':!approved?'This exact basket and price need seller approval. Your bag is saved.':!compatible?'An earlier listing is being reconciled. Your bag is saved.':'Continue to eBay to review delivery, tax and payment.'};
    });res.json(result);
  });
  router.post('/api/checkout',async(req,res)=>{
    requireOrigin(req);
    const result=await withLifecycleLock(async store=>{await rate(store,'checkout',30);const checkout=await beginCheckout(store,ebay,req.body?.items,req.body?.idempotencyKey);return publicCheckout(store,checkout,true);});res.json(result);
  });
  router.get('/api/checkout/:id',async(req,res)=>{
    const id=String(req.params.id); if(!/^[a-f0-9-]{36}$/.test(id))throw new HttpError(404,'NOT_FOUND','Checkout not found');
    const supplied=(req.get('Authorization')||'').replace(/^Bearer /,'');const expected=checkoutAccessToken(id);
    if(supplied.length!==expected.length || !timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw new HttpError(403,'CHECKOUT_TOKEN','Checkout access is not valid');
    const result=await withStore(async store=>{const checkout=await store.get<Checkout>('checkouts',id);if(!checkout)throw new HttpError(404,'NOT_FOUND','Checkout not found');return publicCheckout(store,checkout);});res.json(result);
  });
  router.post('/api/events',async(req,res)=>{
    requireOrigin(req);const type=req.body?.type;if(typeof type!=='string'||!EVENT_TYPES.has(type))throw new HttpError(400,'EVENT','Unsupported event');
    await withLifecycleLock(async store=>{await rate(store,'events',300);await recordEvent(store,type);});res.status(202).json({accepted:true});
  });
  return router;
}
