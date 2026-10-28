import assert from 'node:assert/strict';
import test from 'node:test';
import { EbayClient } from '../server/ebay/index.js';
import { DEFAULT_SETTINGS, type ListingPayload, type SellerConnection, type Settings } from '../server/contracts.js';

const SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  'https://api.ebay.com/oauth/api_scope',
];

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function configureEnv(): void {
  process.env.EBAY_CLIENT_ID = 'fixture-client-id';
  process.env.EBAY_CLIENT_SECRET = 'fixture-client-secret';
  process.env.EBAY_RUNAME = 'fixture-runame';
  process.env.EBAY_CALLBACK_URL = 'https://watch.example.test/api/ebay/callback';
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}

function restoreGlobals(): void {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function xml(value: string, status = 200): Response {
  return new Response(value, { status, headers: { 'content-type': 'text/xml' } });
}

async function establishConnection(): Promise<SellerConnection> {
  const client = new EbayClient(async () => null);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.ebay.com/identity/v1/oauth2/token') {
      return json({
        access_token: 'code-access-token',
        refresh_token: 'refresh-token-that-must-not-be-stored-plaintext',
        expires_in: 3600,
      });
    }
    if (url === 'https://apiz.ebay.com/commerce/identity/v1/user/') {
      return json({ userId: 'seller-123', username: 'fixture-seller' });
    }
    throw new Error(`unexpected fixture request ${url}`);
  }) as typeof fetch;
  return client.exchangeCode('fixture-authorization-code');
}

function fixturePayload(): ListingPayload {
  return {
    sku: 'wc-checkout-123',
    inventory: {
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: 'NEW',
      product: { title: 'Fixture watch', description: 'Fixture description', imageUrls: ['https://images.example.test/watch.jpg'], aspects: { Brand: ['Fixture'] } },
    },
    offer: {
      sku: 'wc-checkout-123', marketplaceId: 'EBAY_US', format: 'FIXED_PRICE', availableQuantity: 1,
      categoryId: '31387', merchantLocationKey: 'fixture-location', listingDuration: 'GTC', listingDescription: 'Fixture description',
      pricingSummary: { price: { currency: 'USD', value: '100.00' } },
      listingPolicies: { paymentPolicyId: 'payment-id', fulfillmentPolicyId: 'fulfillment-id', returnPolicyId: 'return-id' },
    },
  };
}

function fixtureSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    paymentPolicyId: 'payment-id',
    fulfillmentPolicyId: 'fulfillment-id',
    returnPolicyId: 'return-id',
    merchantLocationKey: 'fixture-location',
    shippingCountry: 'US',
    shippingOriginCountry: 'US',
    shippingConfirmed: true,
    freeShippingPolicyConfirmed: true,
    ...overrides,
  };
}

test('authorization URL requests documented scopes and code exchange encrypts the refresh token', { concurrency: false }, async () => {
  configureEnv();
  try {
    const client = new EbayClient(async () => null);
    const authorization = new URL(client.authorizationUrl('opaque-state'));
    assert.equal(authorization.origin, 'https://auth.ebay.com');
    assert.equal(authorization.searchParams.get('client_id'), 'fixture-client-id');
    assert.equal(authorization.searchParams.get('redirect_uri'), 'fixture-runame');
    assert.equal(authorization.searchParams.get('response_type'), 'code');
    assert.equal(authorization.searchParams.get('state'), 'opaque-state');
    assert.deepEqual(new Set(authorization.searchParams.get('scope')?.split(' ')), new Set(SCOPES));

    const connection = await establishConnection();
    assert.equal(connection.sellerId, 'seller-123');
    assert.equal(connection.sellerName, 'fixture-seller');
    assert.match(connection.refreshTokenEncrypted, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!connection.refreshTokenEncrypted.includes('refresh-token-that-must-not-be-stored-plaintext'));
    assert.deepEqual(connection.scopes, [...SCOPES].sort());
  } finally {
    restoreGlobals();
  }
});

test('inventory, offer, fee, publish, and withdraw calls use documented paths without retries', { concurrency: false }, async () => {
  configureEnv();
  try {
    const connection = await establishConnection();
    const client = new EbayClient(async () => connection);
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init: init ?? {} });
      if (url === 'https://api.ebay.com/identity/v1/oauth2/token') {
        return json({ access_token: 'refresh-access-token', expires_in: 3600 });
      }
      if (url.endsWith('/inventory_item/wc-checkout-123')) return new Response(null, { status: 204 });
      if (url.endsWith('/sell/inventory/v1/offer') && init?.method === 'POST') return json({ offerId: 'offer-123' }, 201);
      if (url.endsWith('/sell/inventory/v1/offer/offer-123') && init?.method === 'GET') {
        return json({ offerId: 'offer-123', sku: 'wc-checkout-123', status: 'UNPUBLISHED' });
      }
      if (url.endsWith('/offer/get_listing_fees')) {
        return json({ feeSummaries: [{ marketplaceId: 'EBAY_US', fees: [
          { feeType: 'InsertionFee', amount: { currency: 'USD', value: '0.35' }, promotionalDiscount: { currency: 'USD', value: '0.05' } },
          { feeType: 'SubtitleFee', amount: { currency: 'USD', value: '0.00' }, promotionalDiscount: { currency: 'USD', value: '0.00' } },
        ] }] });
      }
      if (url.endsWith('/publish')) return json({ listingId: '120000000001' });
      if (url.endsWith('/withdraw')) return json({ listingId: '120000000001' });
      throw new Error(`unexpected fixture request ${url}`);
    }) as typeof fetch;

    const payload = fixturePayload();
    await client.createInventory(payload);
    assert.deepEqual(JSON.parse(String(requests.at(-1)?.init.body)), payload.inventory);
    assert.deepEqual(await client.createOffer(payload), { offerId: 'offer-123' });
    assert.deepEqual(await client.getOffer('offer-123'), { offerId: 'offer-123', sku: 'wc-checkout-123', status: 'UNPUBLISHED' });
    assert.equal(await client.estimateFees('offer-123'), 30);
    assert.deepEqual(await client.publish('offer-123'), { listingId: '120000000001', listingUrl: 'https://www.ebay.com/itm/120000000001' });
    assert.deepEqual(await client.withdraw('offer-123'), { listingId: '120000000001' });

    const feeRequest = requests.find((request) => request.url.endsWith('/offer/get_listing_fees'));
    assert.deepEqual(JSON.parse(String(feeRequest?.init.body)), { offers: [{ offerId: 'offer-123' }] });
    assert.equal(requests.filter((request) => request.url.endsWith('/publish')).length, 1);
    assert.equal(requests.filter((request) => request.url.endsWith('/withdraw')).length, 1);
  } finally {
    restoreGlobals();
  }
});

test('sale evidence paginates Trading and Fulfillment reads and commits pending payment', { concurrency: false }, async () => {
  configureEnv();
  try {
    const connection = await establishConnection();
    const client = new EbayClient(async () => connection);
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url === 'https://api.ebay.com/identity/v1/oauth2/token') return json({ access_token: 'refresh-access-token', expires_in: 3600 });
      if (url === 'https://api.ebay.com/ws/api.dll') {
        const body = String(init?.body);
        if (body.includes('<GetItemRequest')) {
          return xml('<?xml version="1.0"?><GetItemResponse><Ack>Success</Ack><Item><ItemID>120000000001</ItemID><SKU>wc-checkout-123</SKU><SellingStatus><QuantitySold>0</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus></Item></GetItemResponse>');
        }
        if (body.includes('<PageNumber>1</PageNumber>')) {
          return xml('<?xml version="1.0"?><GetItemTransactionsResponse><Ack>Success</Ack><Item><ItemID>120000000001</ItemID><SKU>wc-checkout-123</SKU></Item><ReturnedTransactionCountActual>1</ReturnedTransactionCountActual><HasMoreTransactions>true</HasMoreTransactions><TransactionArray><Transaction><QuantityPurchased>1</QuantityPurchased></Transaction></TransactionArray></GetItemTransactionsResponse>');
        }
        if (body.includes('<PageNumber>2</PageNumber>')) {
          return xml('<?xml version="1.0"?><GetItemTransactionsResponse><Ack>Success</Ack><Item><ItemID>120000000001</ItemID><SKU>wc-checkout-123</SKU></Item><ReturnedTransactionCountActual>0</ReturnedTransactionCountActual><HasMoreTransactions>false</HasMoreTransactions></GetItemTransactionsResponse>');
        }
      }
      if (url.startsWith('https://api.ebay.com/sell/fulfillment/v1/order?')) {
        const offset = new URL(url).searchParams.get('offset');
        if (offset === '0') {
          return json({ total: 2, orders: [{ orderId: 'order-pending', orderPaymentStatus: 'PENDING', lineItems: [{ legacyItemId: '120000000001', sku: 'wc-checkout-123', quantity: 1 }] }] });
        }
        if (offset === '1') {
          return json({ total: 2, orders: [{ orderId: 'other-order', orderPaymentStatus: 'PAID', lineItems: [{ legacyItemId: '120000000099', sku: 'other-sku', quantity: 1 }] }] });
        }
      }
      throw new Error(`unexpected fixture request ${url}`);
    }) as typeof fetch;

    const evidence = await client.saleEvidence('120000000001', 'wc-checkout-123', '2026-10-28T00:00:00.000Z');
    assert.equal(evidence.committed, true);
    assert.equal(evidence.quantitySold, 1);
    assert.equal(evidence.listingActive, true);
    assert.deepEqual(evidence.orderIds, ['order-pending']);
    assert.deepEqual(evidence.paymentStatuses, ['PENDING']);
    assert.equal(urls.filter((url) => url === 'https://api.ebay.com/ws/api.dll').length, 3);
    assert.deepEqual(urls.filter((url) => url.startsWith('https://api.ebay.com/sell/fulfillment/v1/order?')).map((url) => new URL(url).searchParams.get('offset')), ['0', '1']);
  } finally {
    restoreGlobals();
  }
});

test('seller setup requires exact seller policy records and verifiable free US shipping', { concurrency: false }, async () => {
  configureEnv();
  try {
    const connection = await establishConnection();
    const client = new EbayClient(async () => connection);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://api.ebay.com/identity/v1/oauth2/token') return json({ access_token: 'refresh-access-token', expires_in: 3600 });
      if (url.endsWith('/sell/inventory/v1/location/fixture-location')) {
        return json({ merchantLocationKey: 'fixture-location', merchantLocationStatus: 'ENABLED', location: { address: { country: 'US' } } });
      }
      if (url.includes('/fulfillment_policy?')) {
        return json({ fulfillmentPolicies: [{
          fulfillmentPolicyId: 'fulfillment-id', marketplaceId: 'EBAY_US', globalShipping: false,
          shipToLocations: { regionIncluded: [{ regionName: 'US' }], regionExcluded: [] },
          shippingOptions: [{ optionType: 'DOMESTIC', costType: 'FLAT_RATE', shippingServices: [{ freeShipping: true }] }],
        }] });
      }
      if (url.includes('/payment_policy?')) return json({ paymentPolicies: [{ paymentPolicyId: 'payment-id', marketplaceId: 'EBAY_US', immediatePay: true }] });
      if (url.includes('/return_policy?')) return json({ returnPolicies: [{ returnPolicyId: 'return-id', marketplaceId: 'EBAY_US', returnsAccepted: true }] });
      throw new Error(`unexpected fixture request ${url}`);
    }) as typeof fetch;

    assert.deepEqual(await client.validateSellerSetup(fixtureSettings()), { ok: true, issues: [] });

    const nonFree = await client.validateSellerSetup(fixtureSettings({ freeShippingPolicyConfirmed: false }));
    assert.equal(nonFree.ok, false);
    assert.ok(nonFree.issues.some((issue) => issue.includes('Free-shipping')));
  } finally {
    restoreGlobals();
  }
});
