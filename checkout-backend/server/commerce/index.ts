import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type {
  CartLine,
  Draft,
  ListingPayload,
  PriceResult,
  Product,
  Quote,
  Settings,
  SoldReference,
} from '../contracts.js';

const MAX_CART_UNITS = 50;
const MAX_CART_DISTINCT_ITEMS = 10;
const MAX_CENTS = 100_000_000;
const MAX_WEIGHT_GRAMS = 200_000;
const MAX_STOCK = 100_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WATCH_MARGIN_CENTS = 1_000;

const moneySchema = z.number().int().min(0).max(MAX_CENTS);
const positiveMoneySchema = z.number().int().min(1).max(MAX_CENTS);
const shortTextSchema = z.string().trim().min(1).max(160);
const policyIdSchema = z.string().trim().max(160);
const countrySchema = z.string().regex(/^[A-Z]{2}$/, 'must be a two-letter uppercase country code');
const conditionSchema = z.enum(['NEW', 'USED_EXCELLENT', 'USED_GOOD']);
const skuInputSchema = z.string().min(1).max(80);

const cartLineSchema = z.object({
  sku: skuInputSchema,
  quantity: z.number().int().min(1).max(MAX_CART_UNITS),
}).strict();

const stringArraySchema = z.array(z.string().trim().min(1).max(160)).min(1).max(50)
  .refine((values) => new Set(values).size === values.length, 'must not contain duplicate values');

const aspectsSchema = z.record(z.string().trim().min(1).max(80), stringArraySchema)
  .refine((value) => Object.keys(value).length <= 50, 'must contain at most 50 aspect names');

const shippingTierSchema = z.object({
  maxGrams: z.number().int().min(1).max(MAX_WEIGHT_GRAMS),
  costCents: moneySchema,
}).strict();

const productSchema = z.object({
  sku: skuInputSchema,
  title: shortTextSchema.max(160),
  model: shortTextSchema,
  variant: shortTextSchema,
  brand: shortTextSchema,
  kind: z.enum(['watch', 'accessory']),
  condition: conditionSchema,
  supplierCostCents: moneySchema,
  weightGrams: z.number().int().min(1).max(MAX_WEIGHT_GRAMS),
  stock: z.number().int().min(0).max(MAX_STOCK),
  accessoryMarginCents: moneySchema.optional(),
  categoryId: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(10_000),
  imageUrls: z.array(z.string().trim().min(1).max(2_048)).min(1).max(12),
  aspects: aspectsSchema,
  compatibility: z.string().trim().min(1).max(1_000).optional(),
  supplierConfirmed: z.boolean(),
  authenticConfirmed: z.boolean(),
  fulfillmentAgreementConfirmed: z.boolean(),
  enabled: z.boolean(),
  updatedAt: z.string().min(1).max(80),
}).strict();

const referenceSchema = z.object({
  sku: skuInputSchema,
  model: shortTextSchema,
  variant: shortTextSchema,
  condition: conditionSchema,
  currency: z.literal('USD'),
  marketplaceId: z.literal('EBAY_US'),
  averageSoldCents: positiveMoneySchema,
  sampleSize: z.number().int().min(1).max(100_000),
  windowStart: z.string().min(1).max(80),
  windowEnd: z.string().min(1).max(80),
  checkedAt: z.string().min(1).max(80),
  source: z.literal('EBAY_PRODUCT_RESEARCH'),
  sourceUrl: z.string().min(1).max(2_048),
  priceBasis: z.literal('ITEM_ONLY'),
  comparableConfirmed: z.literal(true),
  excludesPartsAndLots: z.literal(true),
}).strict();

const settingsSchema = z.object({
  marketplaceId: z.literal('EBAY_US'),
  currency: z.literal('USD'),
  liveEnabled: z.boolean(),
  paymentPolicyId: policyIdSchema,
  fulfillmentPolicyId: policyIdSchema,
  returnPolicyId: policyIdSchema,
  merchantLocationKey: policyIdSchema,
  shippingCountry: z.literal('US'),
  shippingOriginCountry: z.union([countrySchema, z.literal('')]),
  shippingSummary: z.string().trim().max(1_000),
  returnsSummary: z.string().trim().max(1_000),
  handlingDays: z.number().int().min(0).max(30),
  shippingConfirmed: z.boolean(),
  freeShippingPolicyConfirmed: z.boolean(),
  packageWeightGrams: z.number().int().min(0).max(MAX_WEIGHT_GRAMS),
  shippingTiers: z.array(shippingTierSchema).max(50),
  maxCartUnits: z.number().int().min(1).max(MAX_CART_UNITS),
  maxDailyListings: z.number().int().min(0).max(100_000),
  maxDailyListingFeesCents: moneySchema,
  maxReferenceAgeDays: z.number().int().min(1).max(30),
  bundleAspects: aspectsSchema,
}).strict();

const quoteLineSchema = z.object({
  sku: skuInputSchema,
  title: shortTextSchema.max(160),
  model: shortTextSchema,
  variant: shortTextSchema,
  kind: z.enum(['watch', 'accessory']),
  condition: conditionSchema,
  quantity: z.number().int().min(1).max(MAX_CART_UNITS),
}).strict();

const quoteSchema = z.object({
  basketKey: z.string().regex(/^[a-f0-9]{64}$/),
  currency: z.literal('USD'),
  totalCents: positiveMoneySchema,
  shippingIncluded: z.literal(true),
  taxDisclosure: z.string().trim().min(1).max(500),
  shippingSummary: z.string().trim().min(1).max(1_000),
  returnsSummary: z.string().trim().min(1).max(1_000),
  lines: z.array(quoteLineSchema).min(1).max(MAX_CART_DISTINCT_ITEMS),
  calculatedAt: z.string().min(1).max(80),
  referenceCheckedAt: z.string().min(1).max(80),
}).strict();

const priceResultSchema = z.object({
  quote: quoteSchema,
  supplierCents: moneySchema,
  shippingCents: moneySchema,
  retailCents: positiveMoneySchema,
  marginFloorCents: positiveMoneySchema,
}).strict();

function fail(message: string): never {
  throw new Error(`Commerce validation failed: ${message}`);
}

function parseWith<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    fail(`${label} ${path}${issue?.message ?? 'is invalid'}`);
  }
  return parsed.data;
}

function normalizedSku(value: string): string {
  const normalized = value.normalize('NFC').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,79}$/.test(normalized)) {
    fail(`SKU "${value}" is not a supported canonical SKU`);
  }
  return normalized;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function checkedDate(value: string, label: string): Date {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail(`${label} must be a valid ISO date or timestamp`);
  return new Date(ms);
}

function checkedNow(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('now must be a valid Date');
  return now;
}

function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || !host) return false;
  if (isIP(host) !== 0) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  return true;
}

function assertSafeText(value: string, label: string): void {
  if(/[\u0000-\u001F\u007F]/.test(value)) fail(`${label} contains a control character`);
  if (/[<>]/.test(value)) fail(`${label} must be plain text, not HTML`);
  if (/\b(?:javascript|vbscript|data)\s*:/i.test(value)) fail(`${label} contains an unsafe URL scheme`);
  if (/(?:https?:\/\/|www\.)/i.test(value)) fail(`${label} must not contain an unverified URL`);
}

function assertPublicImages(urls: string[], productSku: string): void {
  const seen = new Set<string>();
  for (const url of urls) {
    if (!isPublicHttpsUrl(url)) fail(`product ${productSku} has a non-public HTTPS image URL`);
    if (seen.has(url)) fail(`product ${productSku} has duplicate image URLs`);
    seen.add(url);
  }
}

function isEbayProductResearchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (host === 'ebay.com' || host.endsWith('.ebay.com'))
      && (url.pathname === '/sh/research' || url.pathname.startsWith('/sh/research/'));
  } catch {
    return false;
  }
}

function totalUnits(cart: CartLine[]): number {
  return cart.reduce((total, line) => total + line.quantity, 0);
}

function assertCartWithinSettings(cart: CartLine[], settings: Settings): void {
  if (cart.length > MAX_CART_DISTINCT_ITEMS) fail(`cart may contain at most ${MAX_CART_DISTINCT_ITEMS} distinct SKUs`);
  const units = totalUnits(cart);
  if (units > settings.maxCartUnits) fail(`cart has ${units} units, exceeding configured maximum of ${settings.maxCartUnits}`);
  if (units > MAX_CART_UNITS) fail(`cart may contain at most ${MAX_CART_UNITS} units`);
}

function selectedRecordsForCart(input: unknown, cart: CartLine[], label: string): unknown[] {
  if (!Array.isArray(input)) fail(`${label} must be an array`);
  if (input.length > 10_000) fail(`${label} contains too many records`);
  const selectedSkus = new Set(cart.map((line) => line.sku));
  return input.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object' || typeof (candidate as { sku?: unknown }).sku !== 'string') return false;
    try {
      return selectedSkus.has(normalizedSku((candidate as { sku: string }).sku));
    } catch {
      return false;
    }
  });
}

function validatedProductsForCommerce(products: unknown, cart: CartLine[]): Product[] {
  const selectedInput = selectedRecordsForCart(products, cart, 'products');
  const input = parseWith(z.array(productSchema).min(1).max(MAX_CART_DISTINCT_ITEMS), selectedInput, 'selected products');
  const catalogSkus = new Set(cart.map((line) => line.sku));
  const validated = validateProducts(input, catalogSkus);
  const bySku = new Map(validated.map((product) => [product.sku, product]));

  for (const line of cart) {
    const product = bySku.get(line.sku);
    if (!product) fail(`cart SKU ${line.sku} is not supported by the product mapping`);
    assertCommerceReadyProduct(product, line.quantity);
  }
  return validated;
}

function validatedReferencesForCommerce(
  references: unknown,
  products: Product[],
  cart: CartLine[],
  now: Date,
): SoldReference[] {
  const selectedInput = selectedRecordsForCart(references, cart, 'sold references');
  const selectedReferences = parseWith(
    z.array(referenceSchema).min(1).max(MAX_CART_DISTINCT_ITEMS),
    selectedInput,
    'selected sold references',
  );
  return validateReferences(selectedReferences, products, now);
}

function assertCommerceReadyProduct(product: Product, requestedQuantity: number): void {
  if (!product.enabled) fail(`product ${product.sku} is disabled`);
  if (!product.supplierConfirmed) fail(`product ${product.sku} lacks confirmed supplier mapping`);
  if (!product.authenticConfirmed) fail(`product ${product.sku} lacks genuine-product attestation`);
  if (!product.fulfillmentAgreementConfirmed) fail(`product ${product.sku} lacks fulfillment-agreement attestation`);
  if (product.supplierCostCents <= 0) fail(`product ${product.sku} lacks a confirmed positive supplier cost`);
  if (product.stock < requestedQuantity) fail(`product ${product.sku} has insufficient confirmed stock`);
  if (product.kind === 'accessory' && product.accessoryMarginCents === undefined) {
    fail(`accessory ${product.sku} lacks a configured accessory margin`);
  }
  if (Object.keys(product.aspects).length === 0) fail(`product ${product.sku} lacks required item aspects`);
}

function assertShippingReadiness(settings: Settings): void {
  if (!settings.shippingConfirmed) fail('supplier shipping is not confirmed for US delivery');
  if (!settings.freeShippingPolicyConfirmed) fail('free US shipping policy is not confirmed');
  if (settings.shippingTiers.length === 0) fail('no confirmed US shipping tiers are configured');
}

function shippingFor(cart: CartLine[], products: Product[], settings: Settings): number {
  assertShippingReadiness(settings);
  const productsBySku = new Map(products.map((product) => [product.sku, product]));
  let weight = settings.packageWeightGrams;
  for (const line of cart) {
    const product = productsBySku.get(line.sku);
    if (!product) fail(`cart SKU ${line.sku} is not supported by the product mapping`);
    weight += product.weightGrams * line.quantity;
    if (!Number.isSafeInteger(weight) || weight > MAX_WEIGHT_GRAMS) fail('combined shipping weight exceeds supported limits');
  }
  const tier = settings.shippingTiers.find((candidate) => candidate.maxGrams >= weight);
  if (!tier) fail(`no confirmed US shipping tier covers combined weight of ${weight} grams`);
  return tier.costCents;
}

function findExactReferences(
  cart: CartLine[],
  products: Product[],
  references: SoldReference[],
  settings: Settings,
  now: Date,
): Map<string, SoldReference> {
  const productsBySku = new Map(products.map((product) => [product.sku, product]));
  const refsBySku = new Map(references.map((reference) => [reference.sku, reference]));
  for (const line of cart) {
    const product = productsBySku.get(line.sku);
    const reference = refsBySku.get(line.sku);
    if (!product || !reference) fail(`product ${line.sku} lacks an exact Product Research sold reference`);
    if (reference.model !== product.model || reference.variant !== product.variant || reference.condition !== product.condition) {
      fail(`sold reference for ${line.sku} does not exactly match model, variant, and condition`);
    }
    const ageMs = now.getTime() - checkedDate(reference.checkedAt, `sold reference ${line.sku} checkedAt`).getTime();
    if (ageMs > settings.maxReferenceAgeDays * DAY_MS) {
      fail(`sold reference for ${line.sku} is older than configured ${settings.maxReferenceAgeDays}-day maximum`);
    }
  }
  return refsBySku;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function truncateUnicode(value: string, maximumLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximumLength) return value;
  return `${characters.slice(0, Math.max(0, maximumLength - 1)).join('')}…`;
}

function listingTitle(cart: CartLine[], productsBySku: Map<string, Product>): string {
  const unitCount = totalUnits(cart);
  if (cart.length === 1) {
    const line = cart[0];
    const product = productsBySku.get(line.sku)!;
    return truncateUnicode(`${product.title} — ${product.model} ${product.variant} — Qty ${line.quantity}`, 80);
  }
  const kinds = new Set(cart.map((line) => productsBySku.get(line.sku)!.kind));
  const kindLabel = kinds.size > 1 ? 'watch/accessory' : [...kinds][0];
  const modelSummary = cart.map((line) => {
    const product = productsBySku.get(line.sku)!;
    return `${truncateUnicode(product.model, 16)} ×${line.quantity}`;
  }).join(' + ');
  return truncateUnicode(`${unitCount}-unit ${kindLabel} bundle — ${modelSummary}`, 80);
}

function compatibilityTokens(value: string): Set<string> {
  return new Set(value
    .split(/[;,\n]+/)
    .map((part) => part.trim().toLocaleUpperCase('en-US'))
    .filter(Boolean));
}

function assertAccessoryCompatibility(cart: CartLine[], productsBySku: Map<string, Product>): void {
  const watches = cart
    .map((line) => productsBySku.get(line.sku)!)
    .filter((product) => product.kind === 'watch');
  const accessories = cart
    .map((line) => productsBySku.get(line.sku)!)
    .filter((product) => product.kind === 'accessory');

  if (watches.length === 0 || accessories.length === 0) return;

  for (const accessory of accessories) {
    if (!accessory.compatibility) fail(`accessory ${accessory.sku} has no declared watch compatibility`);
    const tokens = compatibilityTokens(accessory.compatibility);
    for (const watch of watches) {
      const candidates = [
        watch.sku,
        watch.model,
        watch.variant,
        `${watch.model} ${watch.variant}`,
      ].map((value) => value.toLocaleUpperCase('en-US'));
      if (!tokens.has('UNIVERSAL') && !candidates.some((candidate) => tokens.has(candidate))) {
        fail(`accessory ${accessory.sku} is not compatible with watch ${watch.sku}`);
      }
    }
  }
}

function assertListingSettings(settings: Settings): void {
  if (settings.marketplaceId !== 'EBAY_US' || settings.currency !== 'USD' || settings.shippingCountry !== 'US') {
    fail('only USD EBAY_US listings with US shipping are supported');
  }
  assertShippingReadiness(settings);
  if (!settings.paymentPolicyId) fail('payment policy ID is required');
  if (!settings.fulfillmentPolicyId) fail('fulfillment policy ID is required');
  if (!settings.returnPolicyId) fail('return policy ID is required');
  if (!settings.merchantLocationKey) fail('merchant location key is required');
  if (!settings.shippingOriginCountry) fail('shipping origin country is required');
  if (!settings.shippingSummary) fail('shipping summary is required');
  if (!settings.returnsSummary) fail('returns summary is required');
}

function assertPriceMatchesCart(price: PriceResult, cart: CartLine[], productsBySku: Map<string, Product>): void {
  const expectedBasketKey = stableHash(cart);
  if (price.quote.basketKey !== expectedBasketKey) fail('price quote basket key does not match canonical cart');
  const expectedLines = cart.map((line) => {
    const product = productsBySku.get(line.sku)!;
    return {
      sku: line.sku,
      title: product.title,
      model: product.model,
      variant: product.variant,
      kind: product.kind,
      condition: product.condition,
      quantity: line.quantity,
    };
  });
  if (stableCanonicalJson(price.quote.lines) !== stableCanonicalJson(expectedLines)) {
    fail('price quote lines do not match exact cart products');
  }
}

/**
 * Parse untrusted cart input into a normalized, duplicate-free canonical basket.
 * The object form is accepted for direct use with the public `{items: [...]}` API body.
 */
export function parseCart(input: unknown): CartLine[] {
  const source = Array.isArray(input)
    ? parseWith(z.array(cartLineSchema).min(1).max(MAX_CART_DISTINCT_ITEMS * 4), input, 'cart')
    : parseWith(z.object({ items: z.array(cartLineSchema).min(1).max(MAX_CART_DISTINCT_ITEMS * 4) }).strict(), input, 'cart').items;
  const quantities = new Map<string, number>();
  for (const line of source) {
    const sku = normalizedSku(line.sku);
    const next = (quantities.get(sku) ?? 0) + line.quantity;
    if (!Number.isSafeInteger(next) || next > MAX_CART_UNITS) {
      fail(`SKU ${sku} quantity exceeds maximum of ${MAX_CART_UNITS}`);
    }
    quantities.set(sku, next);
  }
  if (quantities.size > MAX_CART_DISTINCT_ITEMS) {
    fail(`cart may contain at most ${MAX_CART_DISTINCT_ITEMS} distinct SKUs`);
  }
  const cart = [...quantities.entries()]
    .map(([sku, quantity]) => ({ sku, quantity }))
    .sort((a, b) => compareText(a.sku, b.sku));
  if (totalUnits(cart) > MAX_CART_UNITS) fail(`cart may contain at most ${MAX_CART_UNITS} units`);
  return cart;
}

/** Validate mapped products without making any external request. */
export function validateProducts(input: unknown, catalogSkus: Set<string>): Product[] {
  if (!(catalogSkus instanceof Set)) fail('catalogSkus must be a Set');
  const products = parseWith(z.array(productSchema).min(1).max(10_000), input, 'products');
  const seen = new Set<string>();
  for (const product of products) {
    if (product.sku !== normalizedSku(product.sku)) fail(`product SKU ${product.sku} must be canonical uppercase`);
    if (!catalogSkus.has(product.sku)) fail(`product SKU ${product.sku} is not an exact catalog SKU`);
    if (seen.has(product.sku)) fail(`duplicate product SKU ${product.sku}`);
    seen.add(product.sku);
    assertSafeText(product.title, `product ${product.sku} title`);
    assertSafeText(product.model, `product ${product.sku} model`);
    assertSafeText(product.variant, `product ${product.sku} variant`);
    assertSafeText(product.brand, `product ${product.sku} brand`);
    assertSafeText(product.description, `product ${product.sku} description`);
    if (product.compatibility) assertSafeText(product.compatibility, `product ${product.sku} compatibility`);
    assertPublicImages(product.imageUrls, product.sku);
    checkedDate(product.updatedAt, `product ${product.sku} updatedAt`);
  }
  return [...products].sort((a, b) => compareText(a.sku, b.sku));
}

/** Validate actual eBay Product Research sold-price imports for exact mapped products. */
export function validateReferences(input: unknown, products: Product[], now: Date = new Date()): SoldReference[] {
  const current = checkedNow(now);
  const validatedProducts = parseWith(z.array(productSchema).min(1).max(10_000), products, 'products');
  const productsBySku = new Map(validatedProducts.map((product) => [product.sku, product]));
  const references = parseWith(z.array(referenceSchema).min(1).max(10_000), input, 'sold references');
  const seen = new Set<string>();

  for (const reference of references) {
    if (reference.sku !== normalizedSku(reference.sku)) fail(`sold reference SKU ${reference.sku} must be canonical uppercase`);
    if (seen.has(reference.sku)) fail(`duplicate sold reference for SKU ${reference.sku}`);
    seen.add(reference.sku);
    const product = productsBySku.get(reference.sku);
    if (!product) fail(`sold reference SKU ${reference.sku} is not an imported product`);
    if (reference.model !== product.model || reference.variant !== product.variant || reference.condition !== product.condition) {
      fail(`sold reference for ${reference.sku} does not exactly match product model, variant, and condition`);
    }
    if (!isEbayProductResearchUrl(reference.sourceUrl)) {
      fail(`sold reference for ${reference.sku} sourceUrl must be an HTTPS ebay.com Product Research URL`);
    }
    const start = checkedDate(reference.windowStart, `sold reference ${reference.sku} windowStart`);
    const end = checkedDate(reference.windowEnd, `sold reference ${reference.sku} windowEnd`);
    const checked = checkedDate(reference.checkedAt, `sold reference ${reference.sku} checkedAt`);
    if (start.getTime() > end.getTime()) fail(`sold reference ${reference.sku} windowStart must not be after windowEnd`);
    if (end.getTime() > current.getTime()) fail(`sold reference ${reference.sku} windowEnd cannot be in the future`);
    if (checked.getTime() > current.getTime()) fail(`sold reference ${reference.sku} checkedAt cannot be in the future`);
    if (end.getTime() > checked.getTime()) fail(`sold reference ${reference.sku} windowEnd cannot be after checkedAt`);
    if (current.getTime() - checked.getTime() > 30 * DAY_MS) {
      fail(`sold reference ${reference.sku} checkedAt must be within 30 days`);
    }
    if (checked.getTime() - end.getTime() > 7 * DAY_MS) {
      fail(`sold reference ${reference.sku} windowEnd must be within seven days of checkedAt`);
    }
    const days = (end.getTime() - start.getTime()) / DAY_MS;
    if (days < 89 || days > 92) fail(`sold reference ${reference.sku} window must span 89 to 92 days`);
  }
  return [...references].sort((a, b) => compareText(a.sku, b.sku));
}

/** Validate persisted seller settings while allowing an intentionally incomplete disabled configuration. */
export function validateSettings(input: unknown): Settings {
  const settings = parseWith(settingsSchema, input, 'settings');
  let previousMax = 0;
  for (const tier of settings.shippingTiers) {
    if (tier.maxGrams <= previousMax) fail('shipping tiers must be sorted by strictly increasing maxGrams');
    previousMax = tier.maxGrams;
  }
  for (const [name, values] of Object.entries(settings.bundleAspects)) {
    assertSafeText(name, 'bundle aspect name');
    for (const value of values) assertSafeText(value, `bundle aspect ${name}`);
  }
  return settings;
}

/** Calculate a shipping-inclusive, integer-cent quote from confirmed readiness data only. */
export function calculatePrice(
  cartInput: unknown,
  productsInput: Product[],
  referencesInput: SoldReference[],
  settingsInput: Settings,
  now: Date = new Date(),
): PriceResult {
  const current = checkedNow(now);
  const cart = parseCart(cartInput);
  const settings = validateSettings(settingsInput);
  assertCartWithinSettings(cart, settings);
  const products = validatedProductsForCommerce(productsInput, cart);
  const references = validatedReferencesForCommerce(referencesInput, products, cart, current);
  const referencesBySku = findExactReferences(cart, products, references, settings, current);
  const productsBySku = new Map(products.map((product) => [product.sku, product]));
  const shippingCents = shippingFor(cart, products, settings);

  let supplierCents = 0;
  let retailCents = 0;
  let watchUnits = 0;
  let accessoryMarginCents = 0;
  for (const line of cart) {
    const product = productsBySku.get(line.sku)!;
    const reference = referencesBySku.get(line.sku)!;
    supplierCents += product.supplierCostCents * line.quantity;
    retailCents += reference.averageSoldCents * line.quantity;
    if (!Number.isSafeInteger(supplierCents) || !Number.isSafeInteger(retailCents)) fail('price calculation exceeds supported bounds');
    if (product.kind === 'watch') watchUnits += line.quantity;
    else accessoryMarginCents += product.accessoryMarginCents! * line.quantity;
  }
  const candidateCents = Math.ceil((supplierCents + shippingCents + retailCents) / 2);
  const marginFloorCents = supplierCents + shippingCents + (WATCH_MARGIN_CENTS * watchUnits) + accessoryMarginCents;
  const totalCents = Math.max(candidateCents, marginFloorCents);
  if (!Number.isSafeInteger(totalCents) || totalCents > MAX_CENTS) fail('calculated price exceeds supported bounds');

  const referenceCheckedAt = cart
    .map((line) => referencesBySku.get(line.sku)!.checkedAt)
    .map((value) => checkedDate(value, 'sold reference checkedAt'))
    .sort((a, b) => a.getTime() - b.getTime())[0]
    .toISOString();

  const quote: Quote = {
    basketKey: stableHash(cart),
    currency: 'USD',
    totalCents,
    shippingIncluded: true,
    taxDisclosure: 'Shipping included; tax calculated by eBay.',
    shippingSummary: settings.shippingSummary || 'Shipping included to US destinations.',
    returnsSummary: settings.returnsSummary || 'Return terms are confirmed in the eBay listing.',
    lines: cart.map((line) => {
      const product = productsBySku.get(line.sku)!;
      return {
        sku: product.sku,
        title: product.title,
        model: product.model,
        variant: product.variant,
        kind: product.kind,
        condition: product.condition,
        quantity: line.quantity,
      };
    }),
    calculatedAt: current.toISOString(),
    referenceCheckedAt,
  };

  return { quote, supplierCents, shippingCents, retailCents, marginFloorCents };
}

/**
 * Build one fixed-price listing for the exact cart. Inventory and offer quantity are always one,
 * because the listing represents this exact bundle rather than separate catalogue stock.
 */
export function buildListing(
  cartInput: unknown,
  productsInput: Product[],
  settingsInput: Settings,
  priceInput: PriceResult,
): ListingPayload {
  const cart = parseCart(cartInput);
  const settings = validateSettings(settingsInput);
  assertCartWithinSettings(cart, settings);
  assertListingSettings(settings);
  const products = validatedProductsForCommerce(productsInput, cart);
  const productsBySku = new Map(products.map((product) => [product.sku, product]));
  const parsedPrice = parseWith(priceResultSchema, priceInput, 'price result');
  assertPriceMatchesCart(parsedPrice, cart, productsBySku);

  // Confirm the current cart still has a usable shipping tier; never extrapolate a price.
  shippingFor(cart, products, settings);
  const isBundle = cart.length > 1 || totalUnits(cart) > 1;
  const selectedProducts = cart.map((line) => productsBySku.get(line.sku)!);
  if (isBundle) {
    const first = selectedProducts[0];
    if (!selectedProducts.every((product) => product.categoryId === first.categoryId)) {
      fail('all products in an exact bundle must share one eBay category');
    }
    if (!selectedProducts.every((product) => product.condition === first.condition)) {
      fail('all products in an exact bundle must share one condition');
    }
    if (Object.keys(settings.bundleAspects).length === 0) fail('bundleAspects are required for a multi-item bundle');
  }
  assertAccessoryCompatibility(cart, productsBySku);

  const title = listingTitle(cart, productsBySku);
  assertSafeText(title, 'listing title');

  const images: string[] = [];
  const imageSet = new Set<string>();
  const addImage = (url: string): void => {
    if (images.length < 12 && !imageSet.has(url)) {
      images.push(url);
      imageSet.add(url);
    }
  };
  // A bundle shows at least one confirmed photo from every selected catalogue item first.
  for (const product of selectedProducts) addImage(product.imageUrls[0]);
  for (const product of selectedProducts) for (const image of product.imageUrls) addImage(image);
  if (images.length < 1 || images.length > 12) fail('listing must use one to twelve confirmed public image URLs');

  const itemRows = cart.map((line) => {
    const product = productsBySku.get(line.sku)!;
    const compatibility = product.kind === 'accessory' ? product.compatibility ?? 'Not declared' : 'Not applicable';
    return `<li><strong>SKU:</strong> ${escapeHtml(product.sku)}; <strong>title:</strong> ${escapeHtml(product.title)}; <strong>model:</strong> ${escapeHtml(product.model)}; <strong>variant:</strong> ${escapeHtml(product.variant)}; <strong>quantity:</strong> ${line.quantity}; <strong>condition:</strong> ${escapeHtml(product.condition)}; <strong>type:</strong> ${escapeHtml(product.kind)}; <strong>compatibility:</strong> ${escapeHtml(compatibility)}.<br>${escapeHtml(product.description)}</li>`;
  }).join('');
  const description = `<section><h1>${escapeHtml(title)}</h1><p>This fixed-price listing is for the exact item${isBundle ? ' bundle' : ''} below. It is not an unspecified lot.</p><ul>${itemRows}</ul><p>Shipping is included for US delivery. Tax is calculated by eBay. ${escapeHtml(settings.returnsSummary)}</p></section>`;

  const categoryId = selectedProducts[0].categoryId;
  const aspects = isBundle ? settings.bundleAspects : selectedProducts[0].aspects;
  const sku = `wc-${parsedPrice.quote.basketKey.slice(0, 32)}`;
  return {
    sku,
    inventory: {
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: selectedProducts[0].condition,
      product: { title, description, imageUrls: images, aspects },
    },
    offer: {
      sku,
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      availableQuantity: 1,
      categoryId,
      merchantLocationKey: settings.merchantLocationKey,
      listingDuration: 'GTC',
      listingDescription: description,
      pricingSummary: { price: { currency: 'USD', value: (parsedPrice.quote.totalCents / 100).toFixed(2) } },
      listingPolicies: {
        paymentPolicyId: settings.paymentPolicyId,
        fulfillmentPolicyId: settings.fulfillmentPolicyId,
        returnPolicyId: settings.returnPolicyId,
      },
    },
  };
}

/** Build a deterministic, approval-ready draft without making an eBay or database mutation. */
export function buildDraft(
  cartInput: unknown,
  productsInput: Product[],
  referencesInput: SoldReference[],
  settingsInput: Settings,
  now: Date = new Date(),
): Draft {
  const current = checkedNow(now);
  const cart = parseCart(cartInput);
  const settings = validateSettings(settingsInput);
  const products = validatedProductsForCommerce(productsInput, cart);
  const references = validatedReferencesForCommerce(referencesInput, products, cart, current);
  const price = calculatePrice(cart, products, references, settings, current);
  const payload = buildListing(cart, products, settings, price);
  const payloadHash = stableHash(payload);
  const contextHash = stableHash({
    cart,
    products: products.map(({ updatedAt: _updatedAt, ...product }) => product),
    references,
    settings: {
      marketplaceId: settings.marketplaceId,
      currency: settings.currency,
      paymentPolicyId: settings.paymentPolicyId,
      fulfillmentPolicyId: settings.fulfillmentPolicyId,
      returnPolicyId: settings.returnPolicyId,
      merchantLocationKey: settings.merchantLocationKey,
      shippingCountry: settings.shippingCountry,
      shippingOriginCountry: settings.shippingOriginCountry,
      shippingSummary: settings.shippingSummary,
      returnsSummary: settings.returnsSummary,
      handlingDays: settings.handlingDays,
      shippingConfirmed: settings.shippingConfirmed,
      freeShippingPolicyConfirmed: settings.freeShippingPolicyConfirmed,
      packageWeightGrams: settings.packageWeightGrams,
      shippingTiers: settings.shippingTiers,
      maxReferenceAgeDays: settings.maxReferenceAgeDays,
      bundleAspects: settings.bundleAspects,
    },
    price: {
      supplierCents: price.supplierCents,
      shippingCents: price.shippingCents,
      retailCents: price.retailCents,
      marginFloorCents: price.marginFloorCents,
      quote: {
        basketKey: price.quote.basketKey,
        currency: price.quote.currency,
        totalCents: price.quote.totalCents,
        shippingIncluded: price.quote.shippingIncluded,
        taxDisclosure: price.quote.taxDisclosure,
        shippingSummary: price.quote.shippingSummary,
        returnsSummary: price.quote.returnsSummary,
        lines: price.quote.lines,
        referenceCheckedAt: price.quote.referenceCheckedAt,
      },
    },
    payload,
  });
  return {
    id: stableHash({ payloadHash, contextHash }),
    basketKey: price.quote.basketKey,
    cart,
    quote: price.quote,
    payload,
    payloadHash,
    contextHash,
    createdAt: current.toISOString(),
  };
}

function stableCanonicalJson(value: unknown): string {
  const stack = new Set<object>();
  const visit = (item: unknown): string => {
    if (item === null) return 'null';
    switch (typeof item) {
      case 'string': return JSON.stringify(item);
      case 'boolean': return item ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(item)) fail('stable hash input contains a non-finite number');
        return Object.is(item, -0) ? '0' : JSON.stringify(item);
      case 'undefined':
      case 'bigint':
      case 'function':
      case 'symbol':
        fail('stable hash input contains a non-JSON value');
      case 'object': {
        if (stack.has(item)) fail('stable hash input contains a circular reference');
        stack.add(item);
        let output: string;
        if (Array.isArray(item)) {
          output = `[${item.map(visit).join(',')}]`;
        } else if (item instanceof Date) {
          if (!Number.isFinite(item.getTime())) fail('stable hash input contains an invalid Date');
          output = JSON.stringify(item.toISOString());
        } else {
          const record = item as Record<string, unknown>;
          const keys = Object.keys(record).sort(compareText);
          output = `{${keys.map((key) => `${JSON.stringify(key)}:${visit(record[key])}`).join(',')}}`;
        }
        stack.delete(item);
        return output;
      }
      default:
        fail('stable hash input contains an unsupported value');
    }
  };
  return visit(value);
}

/** SHA-256 of canonical JSON with recursively sorted object keys. */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableCanonicalJson(value), 'utf8').digest('hex');
}
