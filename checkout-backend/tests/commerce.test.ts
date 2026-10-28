// All products, references, categories, policies, suppliers, images, and prices in this file are
// fictitious test fixtures only. They are not catalog seed data and make no network requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDraft,
  buildListing,
  calculatePrice,
  parseCart,
  stableHash,
  validateProducts,
  validateReferences,
  validateSettings,
} from '../server/commerce/index.js';
import type { Product, Settings, SoldReference } from '../server/contracts.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    marketplaceId: 'EBAY_US',
    currency: 'USD',
    liveEnabled: false,
    paymentPolicyId: 'fictitious-payment-policy',
    fulfillmentPolicyId: 'fictitious-free-us-fulfillment-policy',
    returnPolicyId: 'fictitious-return-policy',
    merchantLocationKey: 'fictitious-us-location',
    shippingCountry: 'US',
    shippingOriginCountry: 'US',
    shippingSummary: 'Fictitious fixture: free US shipping included.',
    returnsSummary: 'Fictitious fixture: returns accepted under listed terms.',
    handlingDays: 2,
    shippingConfirmed: true,
    freeShippingPolicyConfirmed: true,
    packageWeightGrams: 100,
    shippingTiers: [
      { maxGrams: 500, costCents: 200 },
      { maxGrams: 1_000, costCents: 500 },
      { maxGrams: 2_000, costCents: 900 },
    ],
    maxCartUnits: 10,
    maxDailyListings: 10,
    maxDailyListingFeesCents: 5_000,
    maxReferenceAgeDays: 30,
    bundleAspects: { Type: ['Exact Fictitious Bundle'], Brand: ['Fictitious'] },
    ...overrides,
  };
}

function watch(overrides: Partial<Product> = {}): Product {
  return {
    sku: 'WATCH-001',
    title: 'Fictitious Chronos Watch',
    model: 'Chronos 100',
    variant: 'Blue Dial',
    brand: 'Fictitious',
    kind: 'watch',
    condition: 'NEW',
    supplierCostCents: 10_000,
    weightGrams: 200,
    stock: 8,
    categoryId: '31387',
    description: 'Fictitious plain-text watch description & specifications.',
    imageUrls: ['https://images.example.test/fictitious-watch-001.jpg'],
    aspects: { Brand: ['Fictitious'], Model: ['Chronos 100'], Colour: ['Blue'] },
    supplierConfirmed: true,
    authenticConfirmed: true,
    fulfillmentAgreementConfirmed: true,
    enabled: true,
    updatedAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}

function reference(product: Product, overrides: Partial<SoldReference> = {}): SoldReference {
  return {
    sku: product.sku,
    model: product.model,
    variant: product.variant,
    condition: product.condition,
    currency: 'USD',
    marketplaceId: 'EBAY_US',
    averageSoldCents: 14_000,
    sampleSize: 12,
    windowStart: '2026-07-01T00:00:00.000Z',
    windowEnd: '2026-09-29T00:00:00.000Z',
    checkedAt: '2026-09-30T10:00:00.000Z',
    source: 'EBAY_PRODUCT_RESEARCH',
    sourceUrl: 'https://www.ebay.com/sh/research?tabName=SOLD&fixture=only',
    priceBasis: 'ITEM_ONLY',
    comparableConfirmed: true,
    excludesPartsAndLots: true,
    ...overrides,
  };
}

function commercePrice(
  cart: unknown,
  products: Product[] = [watch()],
  refs: SoldReference[] = [reference(products[0])],
  sellerSettings: Settings = settings(),
) {
  return calculatePrice(cart, products, refs, sellerSettings, NOW);
}

test('prices a single fictitious watch in integer cents with confirmed combined shipping', () => {
  const product = watch();
  const result = commercePrice([{ sku: 'watch-001', quantity: 1 }], [product], [reference(product)]);

  // supplier 10000 + first adequate 200g+100g tier 200 + sold reference 14000, divided by two
  assert.equal(result.shippingCents, 200);
  assert.equal(result.supplierCents, 10_000);
  assert.equal(result.retailCents, 14_000);
  assert.equal(result.marginFloorCents, 11_200);
  assert.equal(result.quote.totalCents, 12_100);
  assert.equal(result.quote.basketKey, stableHash([{ sku: 'WATCH-001', quantity: 1 }]));
});

test('uses the shipping-inclusive $10-per-watch floor when reference arithmetic is lower', () => {
  const product = watch();
  const result = commercePrice(
    [{ sku: product.sku, quantity: 1 }],
    [product],
    [reference(product, { averageSoldCents: 10_100 })],
  );

  assert.equal(result.quote.totalCents, 11_200);
  assert.equal(result.marginFloorCents, 11_200);
});

test('canonicalizes duplicate quantities and uses the first sorted adequate shipping tier', () => {
  const product = watch({ weightGrams: 225 });
  const result = commercePrice(
    [{ sku: 'watch-001', quantity: 1 }, { sku: 'WATCH-001', quantity: 1 }],
    [product],
    [reference(product)],
  );

  assert.deepEqual(result.quote.lines.map(({ sku, quantity }) => ({ sku, quantity })), [{ sku: 'WATCH-001', quantity: 2 }]);
  // 225*2 + 100 = 550g, so the 500g tier cannot be extrapolated and the 1000g tier is selected.
  assert.equal(result.shippingCents, 500);
  assert.equal(result.quote.totalCents, 24_250);
});

test('applies an explicitly configured accessory margin without counting an accessory as a watch', () => {
  const primary = watch();
  const accessory = watch({
    sku: 'ACCESSORY-001',
    title: 'Fictitious Universal Strap',
    model: 'Universal Strap',
    variant: 'Blue',
    kind: 'accessory',
    supplierCostCents: 1_000,
    accessoryMarginCents: 300,
    weightGrams: 50,
    compatibility: 'UNIVERSAL',
    imageUrls: ['https://images.example.test/fictitious-accessory-001.jpg'],
  });
  const result = commercePrice(
    [{ sku: primary.sku, quantity: 1 }, { sku: accessory.sku, quantity: 1 }],
    [primary, accessory],
    [reference(primary, { averageSoldCents: 10_100 }), reference(accessory, { averageSoldCents: 500 })],
  );

  assert.equal(result.shippingCents, 200);
  assert.equal(result.marginFloorCents, 12_500);
  assert.equal(result.quote.totalCents, 12_500);
});

test('rejects a cart outside supported unit and shape bounds', () => {
  assert.throws(() => parseCart([]), /cart/i);
  assert.throws(() => parseCart([{ sku: 'WATCH-001', quantity: 51 }]), /quantity|max/i);
  assert.throws(() => parseCart({ items: [{ sku: 'WATCH-001', quantity: 1 }], injected: true }), /unrecognized key/i);
  assert.throws(() => parseCart([{ sku: 'WATCH-001', quantity: 30 }, { sku: 'WATCH-001', quantity: 30 }]), /maximum of 50/i);

  const product = watch();
  assert.throws(
    () => commercePrice([{ sku: product.sku, quantity: 2 }], [product], [reference(product)], settings({ maxCartUnits: 1 })),
    /configured maximum/i,
  );
});

test('validates exact actual-sold Product Research imports and rejects asking-listing URLs', () => {
  const product = watch();
  assert.throws(
    () => validateReferences([reference(product, { sourceUrl: 'https://www.ebay.com/itm/fictitious-asking-listing' })], [product], NOW),
    /Product Research URL/i,
  );
  assert.throws(
    () => validateReferences([reference(product, { variant: 'Different Dial' })], [product], NOW),
    /exactly match/i,
  );
  assert.throws(
    () => validateReferences([reference(product, {
      windowStart: '2026-07-04T00:00:00.000Z',
      windowEnd: '2026-10-02T00:00:00.000Z',
      checkedAt: '2026-10-02T00:00:00.000Z',
    })], [product], NOW), /future/i);
  assert.throws(
    () => validateReferences([reference(product, {
      windowStart: '2026-06-11T00:00:00.000Z',
      windowEnd: '2026-09-09T00:00:00.000Z',
      checkedAt: '2026-09-30T00:00:00.000Z',
    })], [product], NOW), /within seven days/i);
});

test('rejects stale references according to the configured maximum age', () => {
  const product = watch();
  const stale = reference(product, {
    windowStart: '2026-05-02T00:00:00.000Z',
    windowEnd: '2026-07-31T00:00:00.000Z',
    checkedAt: '2026-08-01T00:00:00.000Z',
  });
  assert.throws(
    () => commercePrice([{ sku: product.sku, quantity: 1 }], [product], [stale]),
    /within 30 days/i,
  );
});

test('requires actual ecommerce attestations before using a mapped product in commerce', () => {
  const product = watch({ authenticConfirmed: false });
  assert.throws(
    () => commercePrice([{ sku: product.sku, quantity: 1 }], [product], [reference(product)]),
    /genuine-product attestation/i,
  );
  assert.throws(
    () => validateProducts([watch({ imageUrls: ['http://images.example.test/not-https.jpg'] })], new Set(['WATCH-001'])),
    /non-public HTTPS image/i,
  );
  assert.throws(
    () => validateProducts([watch({ imageUrls: ['https://localhost/fictitious.jpg'] })], new Set(['WATCH-001'])),
    /non-public HTTPS image/i,
  );
});

test('uses stable hashes and canonical order independent of input ordering or product updatedAt', () => {
  const first = watch();
  const second = watch({
    sku: 'WATCH-002',
    title: 'Fictitious Chronos Two',
    model: 'Chronos 200',
    variant: 'Silver Dial',
    imageUrls: ['https://images.example.test/fictitious-watch-002.jpg'],
  });
  const refs = [reference(first), reference(second, { checkedAt: '2026-09-29T10:00:00.000Z' })];
  const cartA = [{ sku: second.sku, quantity: 1 }, { sku: first.sku, quantity: 1 }];
  const cartB = [...cartA].reverse();
  assert.deepEqual(parseCart(cartA), parseCart(cartB));
  assert.equal(stableHash({ b: [2, { y: true, x: null }], a: 1 }), stableHash({ a: 1, b: [2, { x: null, y: true }] }));

  const draftA = buildDraft(cartA, [second, first], refs.reverse(), settings(), NOW);
  const draftB = buildDraft(cartB, [first, { ...second, updatedAt: '2026-10-01T01:00:00.000Z' }], refs, settings(), NOW);
  assert.equal(draftA.payloadHash, draftB.payloadHash);
  assert.equal(draftA.contextHash, draftB.contextHash);
  assert.equal(draftA.id, draftB.id);
  assert.equal(draftA.quote.referenceCheckedAt, '2026-09-29T10:00:00.000Z');
});

test('ignores unrelated products, stale references, and operational limits when pricing and hashing a selected basket', () => {
  const selected = watch();
  const unrelated = watch({
    sku: 'WATCH-999',
    title: 'Fictitious Unrelated Watch',
    model: 'Unrelated 999',
    variant: 'Ignored Dial',
    imageUrls: ['https://images.example.test/fictitious-unrelated-999.jpg'],
  });
  const staleUnrelated = reference(unrelated, {
    windowStart: '2023-01-01T00:00:00.000Z',
    windowEnd: '2023-04-01T00:00:00.000Z',
    checkedAt: '2023-04-02T00:00:00.000Z',
  });
  const cart = [{ sku: selected.sku, quantity: 1 }];
  const baseline = buildDraft(cart, [selected, unrelated], [reference(selected), staleUnrelated], settings(), NOW);
  const changedUnrelated = { ...unrelated, supplierCostCents: 99_999, stock: 0, updatedAt: '2026-10-01T01:00:00.000Z' };
  const afterOperationalChange = buildDraft(
    cart,
    [selected, changedUnrelated],
    [reference(selected), { ...staleUnrelated, averageSoldCents: 1 }],
    settings({ liveEnabled: true, maxDailyListings: 999, maxDailyListingFeesCents: 99_999 }),
    NOW,
  );

  assert.equal(baseline.quote.totalCents, afterOperationalChange.quote.totalCents);
  assert.equal(baseline.payloadHash, afterOperationalChange.payloadHash);
  assert.equal(baseline.contextHash, afterOperationalChange.contextHash);
  assert.equal(baseline.id, afterOperationalChange.id);
});

test('builds escaped static HTML and rejects unsafe product descriptions', () => {
  const product = watch({ description: 'Fictitious & carefully checked "plain" text.' });
  const price = commercePrice([{ sku: product.sku, quantity: 1 }], [product], [reference(product)]);
  const payload = buildListing([{ sku: product.sku, quantity: 1 }], [product], settings(), price);

  assert.match(payload.inventory.product.description, /Fictitious &amp; carefully checked &quot;plain&quot; text\./);
  assert.doesNotMatch(payload.inventory.product.description, /<script|javascript:/i);
  assert.equal(payload.inventory.availability.shipToLocationAvailability.quantity, 1);
  assert.equal(payload.offer.availableQuantity, 1);
  assert.match(payload.sku, /^wc-[a-f0-9]{32}$/);

  assert.throws(
    () => validateProducts([watch({ description: '<script>fictitious()</script>' })], new Set(['WATCH-001'])),
    /plain text/i,
  );
  assert.throws(
    () => validateProducts([watch({ description: 'See javascript:alert(1)' })], new Set(['WATCH-001'])),
    /unsafe URL scheme/i,
  );
});

test('builds a real exact bundle at quantity one and permits different exact models only with shared category and condition', () => {
  const first = watch();
  const second = watch({
    sku: 'WATCH-002',
    title: 'Fictitious Chronos Two',
    model: 'Chronos 200',
    variant: 'Silver Dial',
    imageUrls: ['https://images.example.test/fictitious-watch-002.jpg'],
  });
  const cart = [{ sku: second.sku, quantity: 1 }, { sku: first.sku, quantity: 1 }];
  const draft = buildDraft(cart, [first, second], [reference(first), reference(second)], settings(), NOW);

  assert.equal(draft.payload.inventory.availability.shipToLocationAvailability.quantity, 1);
  assert.equal(draft.payload.offer.availableQuantity, 1);
  assert.deepEqual(draft.payload.inventory.product.aspects, settings().bundleAspects);
  assert.match(draft.payload.offer.listingDescription, /SKU:<\/strong> WATCH-001; <strong>title:<\/strong> Fictitious Chronos Watch; <strong>model:<\/strong> Chronos 100; <strong>variant:<\/strong> Blue Dial; <strong>quantity:<\/strong> 1/);
  assert.match(draft.payload.offer.listingDescription, /SKU:<\/strong> WATCH-002; <strong>title:<\/strong> Fictitious Chronos Two; <strong>model:<\/strong> Chronos 200; <strong>variant:<\/strong> Silver Dial; <strong>quantity:<\/strong> 1/);
  assert.match(draft.payload.inventory.product.title, /Chronos 100/);
  assert.match(draft.payload.inventory.product.title, /Chronos 200/);

  const incompatibleCategory = { ...second, categoryId: '99999' };
  assert.throws(
    () => buildDraft(cart, [first, incompatibleCategory], [reference(first), reference(incompatibleCategory)], settings(), NOW),
    /share one eBay category/i,
  );
  const incompatibleCondition = { ...second, condition: 'USED_GOOD' as const };
  assert.throws(
    () => buildDraft(cart, [first, incompatibleCondition], [reference(first), reference(incompatibleCondition)], settings(), NOW),
    /share one condition/i,
  );
});

test('keeps long single and multi-item titles within 80 Unicode characters while descriptions retain exact details', () => {
  const first = watch({ title: `Fictitious ${'Very Long Product Name '.repeat(6)}`.trim() });
  const second = watch({
    sku: 'WATCH-002',
    title: `Fictitious ${'Long Second Product '.repeat(6)}`.trim(),
    model: 'Extremely Long Chronos Model Two',
    variant: 'Silver Dial Variant',
    imageUrls: ['https://images.example.test/fictitious-watch-002.jpg'],
  });
  const third = watch({
    sku: 'WATCH-003',
    title: `Fictitious ${'Long Third Product '.repeat(6)}`.trim(),
    model: 'Extremely Long Chronos Model Three',
    variant: 'Gold Dial Variant',
    imageUrls: ['https://images.example.test/fictitious-watch-003.jpg'],
  });
  const single = buildDraft([{ sku: first.sku, quantity: 1 }], [first], [reference(first)], settings(), NOW);
  assert.ok(Array.from(single.payload.inventory.product.title).length <= 80);
  assert.match(single.payload.inventory.product.description, new RegExp(first.title));

  const bundle = buildDraft(
    [{ sku: first.sku, quantity: 1 }, { sku: second.sku, quantity: 1 }, { sku: third.sku, quantity: 1 }],
    [first, second, third],
    [reference(first), reference(second), reference(third)],
    settings(),
    NOW,
  );
  assert.ok(Array.from(bundle.payload.inventory.product.title).length <= 80);
  assert.match(bundle.payload.inventory.product.title, /^3-unit watch bundle — /);
  assert.match(bundle.payload.inventory.product.description, new RegExp(second.model));
  assert.match(bundle.payload.inventory.product.description, new RegExp(third.variant));
});

test('discloses each accessory product title and declared compatibility in the exact bundle description', () => {
  const primary = watch();
  const accessory = watch({
    sku: 'ACCESSORY-001',
    title: 'Fictitious Universal Strap',
    model: 'Universal Strap',
    variant: 'Blue',
    kind: 'accessory',
    supplierCostCents: 1_000,
    accessoryMarginCents: 300,
    weightGrams: 50,
    compatibility: 'UNIVERSAL',
    imageUrls: ['https://images.example.test/fictitious-accessory-001.jpg'],
  });
  const draft = buildDraft(
    [{ sku: primary.sku, quantity: 1 }, { sku: accessory.sku, quantity: 1 }],
    [primary, accessory],
    [reference(primary), reference(accessory)],
    settings(),
    NOW,
  );
  assert.match(draft.payload.offer.listingDescription, /title:<\/strong> Fictitious Universal Strap/);
  assert.match(draft.payload.offer.listingDescription, /compatibility:<\/strong> UNIVERSAL/);
});

test('requires sorted shipping tiers, a covered combined weight, and bundle aspects', () => {
  assert.throws(() => validateSettings(settings({ shippingTiers: [{ maxGrams: 1_000, costCents: 500 }, { maxGrams: 500, costCents: 200 }] })), /sorted/i);
  const product = watch({ weightGrams: 2_000 });
  assert.throws(
    () => commercePrice([{ sku: product.sku, quantity: 1 }], [product], [reference(product)]),
    /no confirmed US shipping tier/i,
  );
  const first = watch();
  const second = watch({ sku: 'WATCH-002', model: 'Chronos 200', title: 'Fictitious Chronos Two', imageUrls: ['https://images.example.test/fictitious-watch-002.jpg'] });
  assert.throws(
    () => buildDraft([{ sku: first.sku, quantity: 1 }, { sku: second.sku, quantity: 1 }], [first, second], [reference(first), reference(second)], settings({ bundleAspects: {} }), NOW),
    /bundleAspects/i,
  );
});
