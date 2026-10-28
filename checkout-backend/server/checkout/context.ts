import { ebayCallbackUrl } from '../ebay/config.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SETTINGS, type Product, type Settings, type SoldReference, type Draft, type Checkout, type SellerConnection, type ScheduleBinding, type CartLine } from '../contracts.js';
import type { Store } from '../store.js';
import { buildDraft } from '../commerce/index.js';

export const catalog = JSON.parse(readFileSync(resolve('public/data/catalog.json'), 'utf8')) as {sku:string; id:string; category:string; watchType:string}[];
export const catalogSkus = new Set(catalog.map(x => x.sku));
export async function context(store: Store): Promise<{products:Product[]; references:SoldReference[]; settings:Settings}> {
  return { products: await store.list<Product>('products'), references: await store.list<SoldReference>('references'), settings: await store.get<Settings>('config', 'settings') || {...DEFAULT_SETTINGS} };
}
export async function currentDraft(store: Store, items: CartLine[]): Promise<Draft> {
  const data = await context(store); return buildDraft(items, data.products, data.references, data.settings);
}
export async function exactApproval(store: Store, draft: Draft): Promise<Draft | null> {
  const saved = await store.get<Draft>('drafts', draft.id);
  return saved?.approvedAt && saved.payloadHash === draft.payloadHash && saved.contextHash === draft.contextHash && typeof saved.approvedMaxListingFeeCents === 'number' ? saved : null;
}
export const holdsInventory = (checkout: Checkout): boolean => !['ENDED_UNSOLD'].includes(checkout.state);
export async function checkStock(store: Store, cart: CartLine[], basketKey: string, products: Product[]): Promise<boolean> {
  const checkouts = await store.list<Checkout>('checkouts');
  const reserved = new Map<string, number>();
  for (const checkout of checkouts) {
    if (!holdsInventory(checkout) || checkout.basketKey === basketKey && checkout.state !== 'COMMITTED') continue;
    for (const line of checkout.cart) reserved.set(line.sku, (reserved.get(line.sku) || 0) + line.quantity);
  }
  return cart.every(line => (products.find(p=>p.sku===line.sku)?.stock || 0) - (reserved.get(line.sku) || 0) >= line.quantity);
}
export async function readiness(store: Store, settings?: Settings): Promise<{ready:boolean; checks:{key:string;label:string;ok:boolean;detail:string}[]}> {
  const config = settings || (await context(store)).settings;
  const seller = await store.get<SellerConnection>('config', 'seller');
  const schedule = await store.get<ScheduleBinding>('config', 'schedule');
  const last = schedule?.lastSuccessAt ? Date.parse(schedule.lastSuccessAt) : 0;
  const checks = [
    {key:'signing',label:'Runtime session and checkout signing',ok:Boolean(process.env.MANUS_JWT_SECRET && process.env.MANUS_PROJECT_ID),detail:'Platform signing credentials must be available before publication or buyer status-token creation.'},
    {key:'owner',label:'Owner account configured',ok:Boolean(process.env.ADMIN_OPEN_ID),detail:'Pin ADMIN_OPEN_ID to the signed-in owner; no public self-enrolment.'},
    {key:'app',label:'eBay app credentials in deployed environment',ok:Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET),detail:'Use protected project settings; connector keys alone do not grant seller access.'},
    {key:'oauth',label:'Seller OAuth and encryption configuration',ok:Boolean(process.env.EBAY_RUNAME && ebayCallbackUrl() && process.env.TOKEN_ENCRYPTION_KEY),detail:'Registered eBay callback/RuName and 32-byte base64 encryption key required.'},
    {key:'seller',label:'Authorized eBay seller',ok:Boolean(seller),detail:seller ? `Connected: ${seller.sellerName}` : 'Connect your seller account through the official eBay consent page.'},
    {key:'policies',label:'Listing policies and US shipping',ok:Boolean(config.paymentPolicyId && config.fulfillmentPolicyId && config.returnPolicyId && config.merchantLocationKey && config.shippingConfirmed && config.freeShippingPolicyConfirmed && config.shippingTiers.length),detail:'Confirmed combined supplier shipping and matching zero-extra-charge US delivery policy required.'},
    {key:'schedule',label:'Durable expiry scheduler healthy',ok:Boolean(schedule?.enabled && !schedule.lastError && last && Date.now()-last < 180000),detail:schedule?.lastSuccessAt ? `Last authenticated sweep: ${schedule.lastSuccessAt}` : 'Publish, register the one-minute schedule, bind its task UID and verify an authenticated run.'},
    {key:'live',label:'Live checkout enabled',ok:config.liveEnabled,detail:'Off by default. Exact approval and stock checks remain mandatory when enabled.'}
  ];
  return {ready:checks.every(x=>x.ok),checks};
}
