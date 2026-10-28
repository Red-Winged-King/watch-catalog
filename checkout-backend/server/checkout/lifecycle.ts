import { randomUUID, createHmac } from 'node:crypto';
import type { CartLine, Checkout, Draft, SaleEvidence, Settings } from '../contracts.js';
import { type Store, HttpError } from '../store.js';
import { context, currentDraft, exactApproval, checkStock, readiness } from './context.js';
import { parseCart, stableHash } from '../commerce/index.js';
import type { EbayClient } from '../ebay/index.js';

export type EbayAdapter = Pick<EbayClient, 'createInventory'|'createOffer'|'getOffer'|'publish'|'withdraw'|'estimateFees'|'saleEvidence'|'validateSellerSetup'>;
export function checkoutAccessToken(id: string): string {
  if (!process.env.MANUS_JWT_SECRET) throw new HttpError(503, 'SECRET_REQUIRED', 'Checkout is not configured');
  return createHmac('sha256', process.env.MANUS_JWT_SECRET).update(`watch-checkout:${id}`).digest('base64url');
}
export function stateMessage(checkout: Checkout): string {
  if (checkout.state === 'ACTIVE') return 'Continue to eBay to review delivery, tax and payment. This public listing may be withdrawn if unsold after its deadline.';
  if (checkout.state === 'COMMITTED') return 'eBay recorded a purchase. Any payment and fulfillment are handled through eBay; the expiry worker will not cancel it.';
  if (checkout.state === 'ENDED_UNSOLD') return 'This listing has ended. Your bag is retained; refresh it for a new available offer.';
  if (['EXPIRY_CLAIMED','END_RETRY'].includes(checkout.state)) return 'This listing is being checked and may be ending. Keep your bag and refresh shortly.';
  return 'Listing preparation needs seller review. No payment has been taken by this catalog.';
}
export async function publicCheckout(store: Store, checkout: Checkout, includeToken = false): Promise<Record<string, unknown>> {
  const draft = await store.get<Draft>('drafts', checkout.draftId);
  const expired = Boolean(checkout.expiresAt && Date.now() >= Date.parse(checkout.expiresAt));
  return {id:checkout.id,state:checkout.state,quote:draft?.quote,expiresAt:checkout.expiresAt,
    listingUrl:checkout.state === 'ACTIVE' && !expired ? checkout.listingUrl : undefined,
    message:expired && checkout.state === 'ACTIVE' ? 'The ten-minute handoff window has passed; the backend is checking this listing. Your bag is retained.' : stateMessage(checkout),
    ...(includeToken ? {accessToken:checkoutAccessToken(checkout.id)} : {})};
}
export function isSale(evidence: SaleEvidence): boolean { return evidence.committed || evidence.quantitySold > 0 || evidence.orderIds.length > 0; }
export async function saveCheckout(store: Store, checkout: Checkout): Promise<void> { checkout.version++; await store.put('checkouts', checkout.id, checkout); }
async function audit(store: Store, checkout: Checkout, type: string): Promise<void> {
  await store.put('audit', randomUUID(), {checkoutId:checkout.id,type,state:checkout.state,at:new Date().toISOString(),version:checkout.version});
}
export async function beginCheckout(store: Store, ebay: EbayAdapter, raw: unknown, key: unknown): Promise<Checkout> {
  checkoutAccessToken('preflight'); // Fail before any listing mutation if signing is unavailable.
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(key)) throw new HttpError(400, 'IDEMPOTENCY_KEY', 'A valid checkout request key is required');
  const cart = parseCart(raw);
  const cartHash = stableHash(cart);
  const previousRequest = await store.get<{cartHash:string;checkoutId:string}>('idempotency',key);
  if (previousRequest) {
    if (previousRequest.cartHash !== cartHash) throw new HttpError(409,'CART_CHANGED','This request key belongs to another bag; refresh the quote');
    const previous = await store.get<Checkout>('checkouts',previousRequest.checkoutId);
    if (!previous) throw new HttpError(503,'RECONCILE','The original checkout needs reconciliation');
    return previous;
  }
  const draft = await currentDraft(store, cart);
  const config = await context(store);
  const existing = (await store.list<Checkout>('checkouts')).find(c => c.basketKey === draft.basketKey && !['ENDED_UNSOLD','COMMITTED'].includes(c.state));
  if (existing) {
    if (existing.payloadHash !== draft.payloadHash) throw new HttpError(409,'OFFER_CHANGED','An earlier offer has different terms and needs reconciliation before a fresh checkout.');
    await store.put('idempotency',key,{cartHash,checkoutId:existing.id});
    return existing;
  }
  const approved = await exactApproval(store,draft);
  if (!approved) throw new HttpError(409,'APPROVAL_REQUIRED','The seller has not approved this exact basket and price yet. Your bag is retained.');
  const ready = await readiness(store,config.settings);
  if (!ready.ready) throw new HttpError(409,'NOT_READY','Checkout is not live yet. Your bag is retained.');
  if (!(await checkStock(store,cart,draft.basketKey,config.products))) throw new HttpError(409,'STOCK','This selection is not currently available');
  const records = await store.list<Checkout>('checkouts');
  const sameSku = records.filter(c=>c.sku === draft.payload.sku);
  if (sameSku.some(c=>c.state==='COMMITTED')) throw new HttpError(409,'SELLER_REVIEW','This listing has recorded a purchase and needs seller inventory review before another sale.');
  const today = new Date().toISOString().slice(0,10);
  const daily = records.filter(c=>c.createdAt.startsWith(today));
  if (daily.length >= config.settings.maxDailyListings) throw new HttpError(429,'DAILY_LIMIT','The seller’s daily listing limit has been reached');
  const usedFees = daily.reduce((n,c)=>n+c.estimatedFeeCents,0);
  const setup = await ebay.validateSellerSetup(config.settings);
  if (!setup.ok) throw new HttpError(409,'SELLER_SETUP','The seller’s eBay listing policies need review');
  const checkout: Checkout = {id:randomUUID(),basketKey:draft.basketKey,draftId:approved.id,payloadHash:approved.payloadHash,cart,
    state:'PUBLISH_INTENT',sku:draft.payload.sku,createdAt:new Date().toISOString(),version:1,attempts:0,estimatedFeeCents:0};
  const reusable = sameSku.find(c=>c.state==='ENDED_UNSOLD' && c.offerId && c.payloadHash === draft.payloadHash);
  if (sameSku.length && !reusable) throw new HttpError(409,'SELLER_REVIEW','An earlier offer for this selection needs seller review before reuse.');
  if (reusable) checkout.offerId = reusable.offerId;
  await store.batch([{collection:'checkouts',name:checkout.id,value:checkout},{collection:'idempotency',name:key,value:{cartHash,checkoutId:checkout.id}}]);
  try {
    if (checkout.offerId) {
      const offer = await ebay.getOffer(checkout.offerId);
      if (offer.sku !== checkout.sku || offer.status !== 'UNPUBLISHED') throw new Error('Existing offer requires reconciliation');
    }
    await ebay.createInventory(draft.payload);
    if (!checkout.offerId) {
      const created = await ebay.createOffer(draft.payload);
      checkout.offerId = created.offerId;
      await saveCheckout(store,checkout);
    }
    const fee = await ebay.estimateFees(checkout.offerId);
    if (!Number.isSafeInteger(fee) || fee < 0 || fee > approved.approvedMaxListingFeeCents! || usedFees + fee > config.settings.maxDailyListingFeesCents) throw new Error('Listing fee exceeds the approved or daily budget');
    checkout.estimatedFeeCents = fee;
    // A crash after this durable marker has unknown publication outcome, never a retry licence.
    checkout.state = 'PUBLISH_UNCERTAIN'; await saveCheckout(store,checkout); await audit(store,checkout,'publish_intent');
    const published = await ebay.publish(checkout.offerId);
    checkout.listingId = published.listingId; checkout.listingUrl = published.listingUrl;
    checkout.publishedAt = new Date().toISOString(); checkout.expiresAt = new Date(Date.parse(checkout.publishedAt)+600000).toISOString();
    checkout.state = 'ACTIVE'; checkout.error = undefined; await saveCheckout(store,checkout); await audit(store,checkout,'published');
    return checkout;
  } catch {
    // Preserve ownership, the offer ID and held stock. The worker reconciles the same
    // objects, and never makes a replacement listing after an ambiguous response.
    checkout.error = 'Listing preparation was not confirmed. Seller reconciliation required.';
    if (checkout.state !== 'PUBLISH_UNCERTAIN') checkout.state = 'RECONCILIATION_REQUIRED';
    await saveCheckout(store,checkout); await audit(store,checkout,'publish_unconfirmed');
    throw new HttpError(503,'PREPARATION_UNCONFIRMED','eBay listing preparation could not be confirmed. Your bag is retained; do not create a second request.');
  }
}
export async function reconcileCheckout(store: Store, ebay: EbayAdapter, checkout: Checkout, now = new Date()): Promise<void> {
  if (checkout.state === 'COMMITTED' || checkout.state === 'ENDED_UNSOLD') return;
  if (checkout.nextAttemptAt && Date.parse(checkout.nextAttemptAt) > now.getTime()) return;
  if (checkout.state === 'EXPIRY_CLAIMED' && checkout.leaseUntil && Date.parse(checkout.leaseUntil)>now.getTime()) return;
  if (checkout.state === 'PUBLISH_UNCERTAIN') {
    if (!checkout.offerId) { checkout.state='RECONCILIATION_REQUIRED'; await saveCheckout(store,checkout); return; }
    const offer = await ebay.getOffer(checkout.offerId);
    if (offer.sku !== checkout.sku) throw new Error('Offer identity mismatch');
    if (offer.status === 'PUBLISHED' && offer.listingId) {
      checkout.listingId=offer.listingId; checkout.listingUrl=`https://www.ebay.com/itm/${encodeURIComponent(offer.listingId)}`;
      // The original publish time is uncertain. A full window from the first
      // recovered observation may be late, but cannot withdraw early. Persist once.
      checkout.publishedAt ||= now.toISOString();
      checkout.expiresAt ||= new Date(Date.parse(checkout.publishedAt)+600000).toISOString(); checkout.state='ACTIVE';
      await saveCheckout(store,checkout);
    } else { checkout.state='RECONCILIATION_REQUIRED'; checkout.error='Publication outcome requires seller review'; await saveCheckout(store,checkout); return; }
  }
  if (checkout.state === 'PUBLISH_INTENT') { checkout.state='RECONCILIATION_REQUIRED'; checkout.error='Interrupted offer preparation requires seller review'; await saveCheckout(store,checkout); return; }
  if (!['ACTIVE','EXPIRY_CLAIMED','END_RETRY'].includes(checkout.state)) return;
  if (!checkout.offerId || !checkout.listingId || !checkout.expiresAt) throw new Error('Listing ownership chain incomplete');
  const evidence = await ebay.saleEvidence(checkout.listingId,checkout.sku,checkout.createdAt);
  if (evidence.listingId !== checkout.listingId || evidence.sku !== checkout.sku) throw new Error('Sale evidence identity mismatch');
  checkout.saleEvidence=evidence;
  if (isSale(evidence)) { checkout.state='COMMITTED'; checkout.error=undefined; checkout.nextAttemptAt=undefined; await saveCheckout(store,checkout); await audit(store,checkout,'purchase_recorded'); return; }
  if (!evidence.listingActive) { checkout.state='ENDED_UNSOLD'; checkout.error=undefined; await saveCheckout(store,checkout); await audit(store,checkout,'ended_verified'); return; }
  if (now.getTime() < Date.parse(checkout.expiresAt)) { await saveCheckout(store,checkout); return; }
  checkout.state='EXPIRY_CLAIMED'; checkout.leaseUntil=new Date(now.getTime()+120000).toISOString(); await saveCheckout(store,checkout);
  const offer = await ebay.getOffer(checkout.offerId);
  if (offer.sku !== checkout.sku || offer.listingId !== checkout.listingId || offer.status !== 'PUBLISHED') throw new Error('Owned active offer could not be verified');
  // No eBay atomic if-unsold withdrawal exists. This second read narrows the race;
  // any purchase discovered later remains an obligation, never an order cancellation.
  const finalEvidence = await ebay.saleEvidence(checkout.listingId,checkout.sku,checkout.createdAt);
  checkout.saleEvidence=finalEvidence;
  if (isSale(finalEvidence)) { checkout.state='COMMITTED'; checkout.error=undefined; await saveCheckout(store,checkout); return; }
  if (!finalEvidence.listingActive) { checkout.state='ENDED_UNSOLD'; await saveCheckout(store,checkout); return; }
  const ended = await ebay.withdraw(checkout.offerId);
  if (ended.listingId !== checkout.listingId) throw new Error('Withdrawal was not confirmed for this listing');
  const after = await ebay.saleEvidence(checkout.listingId,checkout.sku,checkout.createdAt);
  checkout.saleEvidence=after;
  checkout.state=isSale(after) ? 'COMMITTED' : after.listingActive ? 'END_RETRY' : 'ENDED_UNSOLD';
  checkout.error=after.listingActive ? 'eBay has not yet confirmed the listing ended' : undefined;
  checkout.leaseUntil=undefined; await saveCheckout(store,checkout); await audit(store,checkout,'withdrawal_checked');
}
export async function sweep(store: Store, ebay: EbayAdapter, now = new Date()): Promise<{processed:number;exceptions:number}> {
  const checkouts=(await store.list<Checkout>('checkouts')).filter(c=>!['COMMITTED','ENDED_UNSOLD','RECONCILIATION_REQUIRED'].includes(c.state)).sort((a,b)=>(a.expiresAt||a.createdAt).localeCompare(b.expiresAt||b.createdAt));
  let processed=0,exceptions=0;
  for (const checkout of checkouts.slice(0,10)) {
    try { await reconcileCheckout(store,ebay,checkout,now); processed++; }
    catch { exceptions++; checkout.attempts++; checkout.state=checkout.state==='PUBLISH_UNCERTAIN'?'PUBLISH_UNCERTAIN':'END_RETRY'; checkout.leaseUntil=undefined;
      checkout.error='eBay verification failed; no unsafe withdrawal or replacement was attempted. Seller review may be required.';
      checkout.nextAttemptAt=new Date(now.getTime()+Math.min(300000,15000*2**Math.min(checkout.attempts,5))).toISOString(); await saveCheckout(store,checkout); }
  }
  // Post-withdrawal sale propagation can lag. Recheck app-owned ended listings for
  // one day, retaining the original sale identity even when a later sale appears.
  const ended=(await store.list<Checkout>('checkouts')).filter(c=>c.state==='ENDED_UNSOLD' && now.getTime()-Date.parse(c.createdAt)<86400000).slice(0,10);
  for(const checkout of ended) {
    if(!checkout.listingId) continue;
    try { const evidence=await ebay.saleEvidence(checkout.listingId,checkout.sku,checkout.createdAt); if(isSale(evidence)){checkout.saleEvidence=evidence;checkout.state='COMMITTED';await saveCheckout(store,checkout);await audit(store,checkout,'late_purchase_recorded');} } catch { exceptions++; }
  }
  return {processed,exceptions};
}
