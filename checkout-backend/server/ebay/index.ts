import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ListingPayload, SaleEvidence, SellerConnection, Settings } from '../contracts.js';

const API_ROOT = 'https://api.ebay.com';
const IDENTITY_ROOT = 'https://apiz.ebay.com';
const TRADING_ENDPOINT = 'https://api.ebay.com/ws/api.dll';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_PAGES = 1_000;
const ACCESS_TOKEN_CACHE_MS = 10 * 60 * 1_000;

/**
 * These are deliberately the minimum scopes for this module's documented calls.
 * The base scope is eBay's OAuth scope used for the read-only Trading XML calls.
 */
const REQUIRED_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  'https://api.ebay.com/oauth/api_scope',
] as const;

type JsonRecord = Record<string, unknown>;

type EbayConfig = {
  clientId: string;
  clientSecret: string;
  ruName: string;
  callbackUrl: string;
  encryptionKey: Buffer;
};

type CachedAccessToken = {
  sellerId: string;
  accessToken: string;
  expiresAt: number;
};

/** A deliberately body-free representation of an eBay/API transport failure. */
class EbayApiError extends Error {
  readonly status?: number;
  readonly errorId: string;

  constructor(errorId: string, status?: number) {
    super(status === undefined ? `eBay error ${errorId}` : `eBay HTTP ${status} error ${errorId}`);
    this.name = 'EbayApiError';
    this.status = status;
    this.errorId = errorId;
  }
}

/**
 * Server-only eBay adapter. Constructing it has no I/O; all credentials are read
 * lazily immediately before they are needed.
 */
export class EbayClient {
  private cachedAccessToken: CachedAccessToken | null = null;

  constructor(private readonly getSellerConnection: () => Promise<SellerConnection | null>) {}

  authorizationUrl(state: string): string {
    if (!isNonEmptyString(state) || state.length > 2_048) {
      throw new EbayApiError('INVALID_OAUTH_STATE');
    }
    const config = readConfig();
    const url = new URL('https://auth.ebay.com/oauth2/authorize');
    url.searchParams.set('client_id', config.clientId);
    // eBay's OAuth endpoint expects the registered RuName, not the callback URL itself.
    url.searchParams.set('redirect_uri', config.ruName);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', REQUIRED_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<SellerConnection> {
    if (!isNonEmptyString(code) || code.length > 16_384) {
      throw new EbayApiError('INVALID_AUTHORIZATION_CODE');
    }

    const config = readConfig();
    const token = await this.requestToken(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.ruName,
      }),
      config,
    );

    // eBay's documented code-grant response does not include a scope member. The
    // authorization code is bound to the exact scope set requested in authorizationUrl.
    const scopes = token.scope === undefined ? [...REQUIRED_SCOPES].sort() : parseAndValidateScopes(token.scope);
    if (!isNonEmptyString(token.refresh_token) || !isNonEmptyString(token.access_token)) {
      throw new EbayApiError('INVALID_TOKEN_RESPONSE');
    }

    const identity = await this.getIdentity(token.access_token);
    const connection: SellerConnection = {
      sellerId: identity.sellerId,
      sellerName: identity.sellerName,
      refreshTokenEncrypted: encryptRefreshToken(token.refresh_token, config.encryptionKey),
      scopes,
      connectedAt: new Date().toISOString(),
    };

    this.cacheAccessToken(identity.sellerId, token.access_token, token.expires_in);
    return connection;
  }

  async refreshSeller(): Promise<{ accessToken: string; sellerId: string }> {
    const connection = await this.loadSellerConnection();
    const now = Date.now();
    if (
      this.cachedAccessToken !== null &&
      this.cachedAccessToken.sellerId === connection.sellerId &&
      this.cachedAccessToken.expiresAt > now
    ) {
      return { accessToken: this.cachedAccessToken.accessToken, sellerId: connection.sellerId };
    }

    const config = readConfig();
    const refreshToken = decryptRefreshToken(connection.refreshTokenEncrypted, config.encryptionKey);
    const token = await this.requestToken(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: REQUIRED_SCOPES.join(' '),
      }),
      config,
    );

    if (!isNonEmptyString(token.access_token)) {
      throw new EbayApiError('INVALID_TOKEN_RESPONSE');
    }
    this.cacheAccessToken(connection.sellerId, token.access_token, token.expires_in);
    return { accessToken: token.access_token, sellerId: connection.sellerId };
  }

  async createInventory(payload: ListingPayload): Promise<void> {
    validateListingPayload(payload);
    const { accessToken } = await this.refreshSeller();
    await this.restVoid(
      'PUT',
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(payload.sku)}`,
      accessToken,
      payload.inventory,
      true,
    );
  }

  async createOffer(payload: ListingPayload): Promise<{ offerId: string }> {
    validateListingPayload(payload);
    const { accessToken } = await this.refreshSeller();
    const response = await this.restJson<JsonRecord>(
      'POST',
      '/sell/inventory/v1/offer',
      accessToken,
      payload.offer,
      true,
    );
    const offerId = requiredString(response.offerId, 'INVALID_CREATE_OFFER_RESPONSE');
    return { offerId };
  }

  async getOffer(offerId: string): Promise<{
    offerId: string;
    sku: string;
    status: string;
    listingId?: string;
    /** The documented scheduled-listing timestamp, when eBay returned one. */
    listingStartDate?: string;
  }> {
    validateIdentifier(offerId, 'INVALID_OFFER_ID');
    const { accessToken } = await this.refreshSeller();
    const response = await this.restJson<JsonRecord>(
      'GET',
      `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
      accessToken,
    );
    const returnedOfferId = requiredString(response.offerId, 'INVALID_OFFER_RESPONSE');
    if (returnedOfferId !== offerId) throw new EbayApiError('OFFER_ID_MISMATCH');
    const sku = requiredString(response.sku, 'INVALID_OFFER_RESPONSE');
    const status = requiredString(response.status, 'INVALID_OFFER_RESPONSE');
    if (status !== 'PUBLISHED' && status !== 'UNPUBLISHED') {
      throw new EbayApiError('UNRECOGNIZED_OFFER_STATUS');
    }

    const listing = optionalRecord(response.listing);
    const listingId = listing === undefined ? undefined : optionalString(listing.listingId);
    if (status === 'PUBLISHED' && !listingId) throw new EbayApiError('INCONCLUSIVE_OFFER_STATUS');
    const listingStartDate = optionalString(response.listingStartDate);
    return {
      offerId: returnedOfferId,
      sku,
      status,
      ...(listingId ? { listingId } : {}),
      ...(listingStartDate ? { listingStartDate } : {}),
    };
  }

  async publish(offerId: string): Promise<{ listingId: string; listingUrl: string }> {
    validateIdentifier(offerId, 'INVALID_OFFER_ID');
    const { accessToken } = await this.refreshSeller();
    // This side-effecting request is intentionally made exactly once. Callers reconcile uncertainty.
    const response = await this.restJson<JsonRecord>(
      'POST',
      `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      accessToken,
    );
    const listingId = requiredString(response.listingId, 'INVALID_PUBLISH_RESPONSE');
    return { listingId, listingUrl: `https://www.ebay.com/itm/${encodeURIComponent(listingId)}` };
  }

  async withdraw(offerId: string): Promise<{ listingId: string }> {
    validateIdentifier(offerId, 'INVALID_OFFER_ID');
    const { accessToken } = await this.refreshSeller();
    // This side-effecting request is intentionally made exactly once. Callers reconcile uncertainty.
    const response = await this.restJson<JsonRecord>(
      'POST',
      `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
      accessToken,
    );
    return { listingId: requiredString(response.listingId, 'INVALID_WITHDRAW_RESPONSE') };
  }

  async estimateFees(offerId: string): Promise<number> {
    validateIdentifier(offerId, 'INVALID_OFFER_ID');
    const { accessToken } = await this.refreshSeller();
    const response = await this.restJson<JsonRecord>(
      'POST',
      '/sell/inventory/v1/offer/get_listing_fees',
      accessToken,
      { offers: [{ offerId }] },
      false,
    );

    const summaries = response.feeSummaries;
    if (!Array.isArray(summaries) || summaries.length !== 1 || !isRecord(summaries[0])) {
      throw new EbayApiError('AMBIGUOUS_FEE_RESPONSE');
    }
    const summary = summaries[0];
    if (summary.marketplaceId !== 'EBAY_US' || !Array.isArray(summary.fees) || summary.fees.length === 0) {
      throw new EbayApiError('AMBIGUOUS_FEE_RESPONSE');
    }
    if (Array.isArray(summary.warnings) && summary.warnings.length > 0) {
      throw new EbayApiError('AMBIGUOUS_FEE_RESPONSE');
    }

    let totalCents = 0;
    for (const fee of summary.fees) {
      if (!isRecord(fee) || !isNonEmptyString(fee.feeType) || !isRecord(fee.amount)) {
        throw new EbayApiError('AMBIGUOUS_FEE_RESPONSE');
      }
      const amount = usdToCents(fee.amount, 'AMBIGUOUS_FEE_RESPONSE');
      const discount = fee.promotionalDiscount === undefined
        ? 0
        : (isRecord(fee.promotionalDiscount)
            ? usdToCents(fee.promotionalDiscount, 'AMBIGUOUS_FEE_RESPONSE')
            : fail('AMBIGUOUS_FEE_RESPONSE'));
      if (discount > amount || !Number.isSafeInteger(totalCents + amount - discount)) {
        throw new EbayApiError('AMBIGUOUS_FEE_RESPONSE');
      }
      totalCents += amount - discount;
    }
    return totalCents;
  }

  async saleEvidence(listingId: string, sku: string, since: string): Promise<SaleEvidence> {
    validateIdentifier(listingId, 'INVALID_LISTING_ID');
    validateIdentifier(sku, 'INVALID_SKU');
    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) throw new EbayApiError('INVALID_SINCE_TIMESTAMP');

    const { accessToken } = await this.refreshSeller();
    const item = await this.getTradingItem(listingId, sku, accessToken);
    const transactions = await this.getItemTransactions(listingId, sku, sinceDate, accessToken);
    const orders = await this.getMatchingOrders(listingId, sku, sinceDate, accessToken);

    const transactionQuantity = transactions.reduce((sum, transaction) => sum + transaction.quantity, 0);
    const orderQuantity = orders.reduce((sum, order) => sum + order.quantity, 0);
    const quantitySold = Math.max(item.quantitySold, transactionQuantity, orderQuantity);
    const committed = quantitySold > 0 || orders.length > 0;
    const paymentStatuses = new Set<string>(transactions.map((transaction) => transaction.paymentStatus));
    const orderIds = new Set<string>();
    for (const order of orders) {
      paymentStatuses.add(order.paymentStatus);
      orderIds.add(order.orderId);
    }

    return {
      committed,
      quantitySold,
      listingActive: item.listingActive,
      listingId,
      sku,
      observedAt: new Date().toISOString(),
      orderIds: [...orderIds].sort(),
      paymentStatuses: [...paymentStatuses].sort(),
    };
  }

  async validateSellerSetup(settings: Settings): Promise<{ ok: boolean; issues: string[] }> {
    const issues = localSettingsIssues(settings);
    if (issues.length > 0) return { ok: false, issues };

    try {
      const { accessToken } = await this.refreshSeller();
      const encodedLocationKey = encodeURIComponent(settings.merchantLocationKey);
      const [location, fulfillmentPolicies, paymentPolicies, returnPolicies] = await Promise.all([
        this.restJson<JsonRecord>('GET', `/sell/inventory/v1/location/${encodedLocationKey}`, accessToken),
        this.restJson<JsonRecord>('GET', '/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US', accessToken),
        this.restJson<JsonRecord>('GET', '/sell/account/v1/payment_policy?marketplace_id=EBAY_US', accessToken),
        this.restJson<JsonRecord>('GET', '/sell/account/v1/return_policy?marketplace_id=EBAY_US', accessToken),
      ]);

      if (location.merchantLocationKey !== settings.merchantLocationKey) {
        issues.push('Configured merchant location was not returned by eBay.');
      }
      if (location.merchantLocationStatus !== 'ENABLED') {
        issues.push('Configured merchant location is not enabled.');
      }
      const address = optionalRecord(optionalRecord(location.location)?.address);
      if (address?.country !== settings.shippingOriginCountry) {
        issues.push('Configured merchant location does not match the configured shipping origin country.');
      }

      const fulfillment = findPolicy(fulfillmentPolicies.fulfillmentPolicies, 'fulfillmentPolicyId', settings.fulfillmentPolicyId);
      if (!fulfillment || fulfillment.marketplaceId !== 'EBAY_US') {
        issues.push('Configured fulfillment policy is not available for EBAY_US.');
      } else {
        issues.push(...fulfillmentShippingIssues(fulfillment));
      }

      const payment = findPolicy(paymentPolicies.paymentPolicies, 'paymentPolicyId', settings.paymentPolicyId);
      if (!payment || payment.marketplaceId !== 'EBAY_US') {
        issues.push('Configured payment policy is not available for EBAY_US.');
      } else if (payment.immediatePay !== true) {
        issues.push('Configured payment policy does not require immediate payment.');
      }

      const returns = findPolicy(returnPolicies.returnPolicies, 'returnPolicyId', settings.returnPolicyId);
      if (!returns || returns.marketplaceId !== 'EBAY_US') {
        issues.push('Configured return policy is not available for EBAY_US.');
      }
    } catch (error) {
      issues.push(error instanceof EbayApiError ? `eBay validation failed (${error.errorId}).` : 'eBay validation failed.');
    }

    return { ok: issues.length === 0, issues };
  }

  private async requestToken(form: URLSearchParams, config: EbayConfig): Promise<JsonRecord> {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64');
    return this.fetchJson<JsonRecord>(
      `${API_ROOT}/identity/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
      },
    );
  }

  private async getIdentity(accessToken: string): Promise<{ sellerId: string; sellerName: string }> {
    const identity = await this.fetchJson<JsonRecord>(
      `${IDENTITY_ROOT}/commerce/identity/v1/user/`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
    );

    const businessAccount = optionalRecord(identity.businessAccount);
    const individualAccount = optionalRecord(identity.individualAccount);
    const sellerId = optionalString(identity.userId) ?? optionalString(identity.username)
      ?? optionalString(businessAccount?.username) ?? optionalString(individualAccount?.username);
    const sellerName = optionalString(identity.username) ?? optionalString(businessAccount?.businessName)
      ?? optionalString(businessAccount?.username) ?? optionalString(individualAccount?.username);
    if (!sellerId || !sellerName) throw new EbayApiError('INVALID_IDENTITY_RESPONSE');
    return { sellerId, sellerName };
  }

  private async restJson<T extends JsonRecord>(
    method: string,
    path: string,
    accessToken: string,
    body?: unknown,
    contentLanguage = false,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (contentLanguage) headers['Content-Language'] = 'en-US';
    return this.fetchJson<T>(`${API_ROOT}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async restVoid(
    method: string,
    path: string,
    accessToken: string,
    body?: unknown,
    contentLanguage = false,
  ): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (contentLanguage) headers['Content-Language'] = 'en-US';
    const pending = await this.fetchResponse(`${API_ROOT}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      await pending.response.body?.cancel();
    } catch {
      // A successful empty/ignored response body is never surfaced to callers.
    } finally {
      pending.finish();
    }
  }

  private async fetchJson<T extends JsonRecord>(url: string, init: RequestInit): Promise<T> {
    const pending = await this.fetchResponse(url, init);
    try {
      const text = await this.readResponseText(pending.response);
      if (!text) throw new EbayApiError('INVALID_JSON_RESPONSE', pending.response.status);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new EbayApiError('INVALID_JSON_RESPONSE', pending.response.status);
      }
      if (!isRecord(parsed)) throw new EbayApiError('INVALID_JSON_RESPONSE', pending.response.status);
      return parsed as T;
    } finally {
      pending.finish();
    }
  }

  private async fetchResponse(url: string, init: RequestInit): Promise<{ response: Response; finish: () => void }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const finish = () => clearTimeout(timeout);
    try {
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: controller.signal });
      } catch {
        throw new EbayApiError('NETWORK_ERROR');
      }
      if (!response.ok) {
        const errorId = await errorIdFromResponse(response);
        throw new EbayApiError(errorId, response.status);
      }
      return { response, finish };
    } catch (error) {
      finish();
      throw error;
    }
  }

  private async readResponseText(response: Response): Promise<string> {
    return readBodyText(response);
  }

  private cacheAccessToken(sellerId: string, accessToken: string, expiresIn: unknown): void {
    const seconds = typeof expiresIn === 'number' ? expiresIn : Number(expiresIn);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new EbayApiError('INVALID_TOKEN_RESPONSE');
    const usableMs = Math.max(0, Math.min(ACCESS_TOKEN_CACHE_MS, Math.floor(seconds * 1_000) - 60_000));
    this.cachedAccessToken = { sellerId, accessToken, expiresAt: Date.now() + usableMs };
  }

  private async loadSellerConnection(): Promise<SellerConnection> {
    let connection: SellerConnection | null;
    try {
      connection = await this.getSellerConnection();
    } catch {
      throw new EbayApiError('SELLER_CONNECTION_UNAVAILABLE');
    }
    if (!connection || !isNonEmptyString(connection.sellerId) || !isNonEmptyString(connection.refreshTokenEncrypted)) {
      throw new EbayApiError('SELLER_NOT_CONNECTED');
    }
    if (!Array.isArray(connection.scopes) || !connection.scopes.every(isNonEmptyString)) {
      throw new EbayApiError('INVALID_SELLER_CONNECTION');
    }
    assertRequiredScopes(connection.scopes);
    return connection;
  }

  private async tradingXml(callName: 'GetItem' | 'GetItemTransactions', xml: string, accessToken: string): Promise<JsonRecord> {
    const pending = await this.fetchResponse(TRADING_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        Accept: 'text/xml',
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1231',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-IAF-TOKEN': accessToken,
      },
      body: xml,
    });
    try {
      const text = await this.readResponseText(pending.response);
      return parseTradingResponse(text, `${callName}Response`);
    } finally {
      pending.finish();
    }
  }

  private async getTradingItem(listingId: string, sku: string, accessToken: string): Promise<{ quantitySold: number; listingActive: boolean }> {
    const root = await this.tradingXml('GetItem', [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
      `<ItemID>${escapeXml(listingId)}</ItemID>`,
      '<DetailLevel>ReturnAll</DetailLevel>',
      '</GetItemRequest>',
    ].join(''), accessToken);
    const item = requiredRecord(root.Item, 'INVALID_GET_ITEM_RESPONSE');
    assertItemIdentity(item, listingId, sku);
    const selling = requiredRecord(item.SellingStatus, 'INVALID_GET_ITEM_RESPONSE');
    const quantitySold = requiredNonNegativeInteger(selling.QuantitySold, 'INVALID_GET_ITEM_RESPONSE');
    const listingStatus = requiredString(selling.ListingStatus, 'INVALID_GET_ITEM_RESPONSE');
    if (listingStatus === 'Active') return { quantitySold, listingActive: true };
    if (listingStatus === 'Ended' || listingStatus === 'Completed') return { quantitySold, listingActive: false };
    throw new EbayApiError('UNRECOGNIZED_LISTING_STATUS');
  }

  private async getItemTransactions(
    listingId: string,
    sku: string,
    since: Date,
    accessToken: string,
  ): Promise<Array<{ quantity: number; paymentStatus: 'PAID' | 'PENDING' }>> {
    const transactions: Array<{ quantity: number; paymentStatus: 'PAID' | 'PENDING' }> = [];
    let pageNumber = 1;
    let hasMore = true;
    while (hasMore) {
      if (pageNumber > MAX_PAGES) throw new EbayApiError('INCONCLUSIVE_TRANSACTION_PAGINATION');
      const root = await this.tradingXml('GetItemTransactions', [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<GetItemTransactionsRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
        `<ItemID>${escapeXml(listingId)}</ItemID>`,
        `<ModTimeFrom>${escapeXml(since.toISOString())}</ModTimeFrom>`,
        `<ModTimeTo>${escapeXml(new Date().toISOString())}</ModTimeTo>`,
        '<DetailLevel>ReturnAll</DetailLevel>',
        `<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination>`,
        '</GetItemTransactionsRequest>',
      ].join(''), accessToken);
      const item = requiredRecord(root.Item, 'INVALID_TRANSACTIONS_RESPONSE');
      assertItemIdentity(item, listingId, sku);
      const returnedCount = requiredNonNegativeInteger(root.ReturnedTransactionCountActual, 'INVALID_TRANSACTIONS_RESPONSE');
      const array = optionalRecord(root.TransactionArray);
      const pageTransactions = array === undefined ? [] : asArray(array.Transaction);
      if (pageTransactions.length !== returnedCount) throw new EbayApiError('INCONCLUSIVE_TRANSACTION_RESPONSE');
      for (const transaction of pageTransactions) {
        if (!isRecord(transaction)) throw new EbayApiError('INVALID_TRANSACTIONS_RESPONSE');
        const quantity = requiredPositiveInteger(transaction.QuantityPurchased, 'INVALID_TRANSACTIONS_RESPONSE');
        transactions.push({ quantity, paymentStatus: optionalString(transaction.PaidTime) ? 'PAID' : 'PENDING' });
      }
      hasMore = requiredBoolean(root.HasMoreTransactions, 'INVALID_TRANSACTIONS_RESPONSE');
      pageNumber += 1;
    }
    return transactions;
  }

  private async getMatchingOrders(
    listingId: string,
    sku: string,
    since: Date,
    accessToken: string,
  ): Promise<Array<{ orderId: string; quantity: number; paymentStatus: string }>> {
    const matches: Array<{ orderId: string; quantity: number; paymentStatus: string }> = [];
    let expectedTotal: number | null = null;
    let offset = 0;
    let pageCount = 0;

    do {
      if (++pageCount > MAX_PAGES) throw new EbayApiError('INCONCLUSIVE_ORDER_PAGINATION');
      const url = new URL(`${API_ROOT}/sell/fulfillment/v1/order`);
      // A listing-specific lookup is unavailable, so use the listing lifetime as the narrowest documented filter.
      url.searchParams.set('filter', `creationdate:[${since.toISOString()}..]`);
      url.searchParams.set('limit', '200');
      url.searchParams.set('offset', String(offset));
      const page = await this.restJson<JsonRecord>('GET', `${url.pathname}${url.search}`, accessToken);
      const total = requiredNonNegativeInteger(page.total, 'INVALID_ORDERS_RESPONSE');
      const orders = page.orders;
      if (!Array.isArray(orders) || (expectedTotal !== null && expectedTotal !== total)) {
        throw new EbayApiError('INCONCLUSIVE_ORDER_RESPONSE');
      }
      expectedTotal = total;
      if (orders.length === 0 && offset < total) throw new EbayApiError('INCONCLUSIVE_ORDER_PAGINATION');

      for (const order of orders) {
        if (!isRecord(order)) throw new EbayApiError('INVALID_ORDERS_RESPONSE');
        const orderId = requiredString(order.orderId, 'INVALID_ORDERS_RESPONSE');
        const paymentStatus = requiredOrderPaymentStatus(order.orderPaymentStatus);
        if (!Array.isArray(order.lineItems)) throw new EbayApiError('INVALID_ORDERS_RESPONSE');
        for (const lineItem of order.lineItems) {
          if (!isRecord(lineItem)) throw new EbayApiError('INVALID_ORDERS_RESPONSE');
          const itemIdMatches = optionalString(lineItem.legacyItemId) === listingId;
          const skuMatches = optionalString(lineItem.sku) === sku;
          if (itemIdMatches !== skuMatches) throw new EbayApiError('INCONCLUSIVE_ORDER_MATCH');
          if (itemIdMatches && skuMatches) {
            matches.push({
              orderId,
              quantity: requiredPositiveInteger(lineItem.quantity, 'INVALID_ORDERS_RESPONSE'),
              paymentStatus,
            });
          }
        }
      }
      offset += orders.length;
    } while (expectedTotal !== null && offset < expectedTotal);

    return matches;
  }
}

function readConfig(): EbayConfig {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RUNAME;
  const callbackUrl = process.env.EBAY_CALLBACK_URL;
  const keyValue = process.env.TOKEN_ENCRYPTION_KEY;
  if (
    !isNonEmptyString(clientId) ||
    !isNonEmptyString(clientSecret) ||
    !isNonEmptyString(ruName) ||
    !isNonEmptyString(callbackUrl) ||
    !isNonEmptyString(keyValue)
  ) {
    throw new EbayApiError('EBAY_CONFIGURATION_MISSING');
  }
  let parsedCallback: URL;
  try {
    parsedCallback = new URL(callbackUrl);
  } catch {
    throw new EbayApiError('INVALID_EBAY_CALLBACK_URL');
  }
  if (parsedCallback.protocol !== 'https:') throw new EbayApiError('INVALID_EBAY_CALLBACK_URL');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(keyValue) || keyValue.length % 4 !== 0) {
    throw new EbayApiError('INVALID_TOKEN_ENCRYPTION_KEY');
  }
  const encryptionKey = Buffer.from(keyValue, 'base64');
  if (encryptionKey.length !== 32) throw new EbayApiError('INVALID_TOKEN_ENCRYPTION_KEY');
  return { clientId, clientSecret, ruName, callbackUrl, encryptionKey };
}

function encryptRefreshToken(refreshToken: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(refreshToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptRefreshToken(value: string, key: Buffer): string {
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new EbayApiError('INVALID_ENCRYPTED_REFRESH_TOKEN');
  }
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error('invalid encrypted token shape');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (!isNonEmptyString(token)) throw new Error('empty token');
    return token;
  } catch {
    throw new EbayApiError('INVALID_ENCRYPTED_REFRESH_TOKEN');
  }
}

async function readBodyText(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The response has already exceeded the enforced maximum.
        }
        throw new EbayApiError('RESPONSE_TOO_LARGE', response.status);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof EbayApiError) throw error;
    throw new EbayApiError('RESPONSE_READ_ERROR', response.status);
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function errorIdFromResponse(response: Response): Promise<string> {
  try {
    const text = await readBodyText(response);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return 'UNKNOWN';
    if (typeof parsed.errorId === 'number' || typeof parsed.errorId === 'string') return String(parsed.errorId);
    const errors = parsed.errors;
    if (Array.isArray(errors) && isRecord(errors[0]) && (typeof errors[0].errorId === 'number' || typeof errors[0].errorId === 'string')) {
      return String(errors[0].errorId);
    }
  } catch {
    // Error response bodies are intentionally not retained or surfaced.
  }
  return 'UNKNOWN';
}

function parseAndValidateScopes(value: unknown): string[] {
  const scopes = typeof value === 'string'
    ? value.split(/\s+/).filter(Boolean)
    : (Array.isArray(value) && value.every(isNonEmptyString) ? [...value] : []);
  if (scopes.length === 0) throw new EbayApiError('INVALID_TOKEN_SCOPE_RESPONSE');
  assertRequiredScopes(scopes);
  return [...new Set(scopes)].sort();
}

function assertRequiredScopes(scopes: readonly string[]): void {
  const granted = new Set(scopes);
  if (!REQUIRED_SCOPES.every((scope) => granted.has(scope))) {
    throw new EbayApiError('REQUIRED_SCOPE_NOT_GRANTED');
  }
}

function parseTradingResponse(xml: string, rootName: string): JsonRecord {
  if (Buffer.byteLength(xml, 'utf8') > MAX_RESPONSE_BYTES || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) {
    throw new EbayApiError('UNSAFE_XML_RESPONSE');
  }
  if (XMLValidator.validate(xml) !== true) throw new EbayApiError('INVALID_XML_RESPONSE');
  let parsed: unknown;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
      htmlEntities: false,
      trimValues: true,
      parseTagValue: false,
    }).parse(xml);
  } catch {
    throw new EbayApiError('INVALID_XML_RESPONSE');
  }
  if (!isRecord(parsed)) throw new EbayApiError('INVALID_XML_RESPONSE');
  const root = optionalRecord(parsed[rootName]);
  if (!root) throw new EbayApiError('INVALID_XML_RESPONSE');
  const ack = optionalString(root.Ack);
  if (ack === 'Success' || ack === 'Warning') return root;
  const errors = optionalRecord(root.Errors);
  const errorId = errors ? optionalString(errors.ErrorCode) : undefined;
  throw new EbayApiError(errorId ?? 'TRADING_CALL_FAILED', 200);
}

function assertItemIdentity(item: JsonRecord, listingId: string, sku: string): void {
  if (requiredString(item.ItemID, 'INVALID_TRADING_ITEM_RESPONSE') !== listingId) {
    throw new EbayApiError('LISTING_ID_MISMATCH');
  }
  if (requiredString(item.SKU, 'INVALID_TRADING_ITEM_RESPONSE') !== sku) {
    throw new EbayApiError('SKU_MISMATCH');
  }
}

function requiredOrderPaymentStatus(value: unknown): string {
  const status = requiredString(value, 'INVALID_ORDERS_RESPONSE');
  const known = new Set(['PAID', 'PENDING', 'FAILED', 'FULLY_REFUNDED', 'PARTIALLY_REFUNDED']);
  if (!known.has(status)) throw new EbayApiError('UNRECOGNIZED_ORDER_PAYMENT_STATUS');
  return status;
}

function localSettingsIssues(settings: Settings): string[] {
  const issues: string[] = [];
  if (settings.marketplaceId !== 'EBAY_US') issues.push('Only EBAY_US is supported.');
  if (settings.shippingCountry !== 'US') issues.push('Shipping destination must be US.');
  if (!/^[A-Z]{2}$/.test(settings.shippingOriginCountry)) issues.push('Shipping origin country must be a configured ISO country code.');
  if (!isNonEmptyString(settings.merchantLocationKey)) issues.push('Merchant location key is required.');
  if (!isNonEmptyString(settings.fulfillmentPolicyId)) issues.push('Fulfillment policy ID is required.');
  if (!isNonEmptyString(settings.paymentPolicyId)) issues.push('Payment policy ID is required.');
  if (!isNonEmptyString(settings.returnPolicyId)) issues.push('Return policy ID is required.');
  if (!settings.shippingConfirmed) issues.push('Shipping terms have not been confirmed.');
  if (!settings.freeShippingPolicyConfirmed) issues.push('Free-shipping policy has not been confirmed.');
  return issues;
}

function findPolicy(value: unknown, idKey: string, id: string): JsonRecord | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((candidate): candidate is JsonRecord => isRecord(candidate) && candidate[idKey] === id);
}

function fulfillmentShippingIssues(policy: JsonRecord): string[] {
  const issues: string[] = [];
  if (policy.globalShipping !== false) issues.push('Fulfillment policy must not enable global shipping.');
  const topLevelLocations = optionalRecord(policy.shipToLocations);
  const included = topLevelLocations?.regionIncluded;
  if (!Array.isArray(included) || included.length === 0 || included.some((region) => !isRecord(region) || region.regionName !== 'US')) {
    issues.push('Fulfillment policy must explicitly ship only to US.');
  }

  const shippingOptions = policy.shippingOptions;
  if (!Array.isArray(shippingOptions) || shippingOptions.length === 0) {
    issues.push('Fulfillment policy has no verifiable domestic shipping service.');
    return issues;
  }
  const domestic = shippingOptions.filter((option): option is JsonRecord => isRecord(option) && option.optionType === 'DOMESTIC');
  if (domestic.length === 0 || shippingOptions.length !== domestic.length) {
    issues.push('Fulfillment policy must expose domestic US shipping only.');
    return issues;
  }

  for (const option of domestic) {
    if (option.costType !== 'FLAT_RATE' || isNonEmptyString(option.rateTableId) || !Array.isArray(option.shippingServices) || option.shippingServices.length === 0) {
      issues.push('Fulfillment policy has unverifiable buyer shipping charges.');
      continue;
    }
    const handling = optionalZeroUsd(option.packageHandlingCost);
    if (handling !== true) issues.push('Fulfillment policy has a non-zero or unknown handling charge.');
    for (const service of option.shippingServices) {
      if (!isRecord(service)) {
        issues.push('Fulfillment policy has invalid shipping service data.');
        continue;
      }
      const free = service.freeShipping === true;
      const itemShipping = free ? optionalZeroUsd(service.shippingCost) : knownZeroUsd(service.shippingCost);
      const additionalShipping = optionalZeroUsd(service.additionalShippingCost);
      if (!itemShipping || additionalShipping !== true) {
        issues.push('Fulfillment policy does not verify zero additional buyer shipping.');
      }
      const serviceLocations = optionalRecord(service.shipToLocations);
      const serviceIncluded = serviceLocations?.regionIncluded;
      if (serviceIncluded !== undefined && (!Array.isArray(serviceIncluded) || serviceIncluded.some((region) => !isRecord(region) || region.regionName !== 'US'))) {
        issues.push('Shipping service is not limited to US.');
      }
    }
  }
  return [...new Set(issues)];
}

function knownZeroUsd(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    return usdToCents(value, 'INVALID_AMOUNT') === 0;
  } catch {
    return false;
  }
}

function optionalZeroUsd(value: unknown): boolean | undefined {
  if (value === undefined) return true;
  return knownZeroUsd(value);
}

function usdToCents(amount: JsonRecord, errorId: string): number {
  if (amount.currency !== 'USD' || typeof amount.value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(amount.value)) {
    throw new EbayApiError(errorId);
  }
  const [whole, fractional = ''] = amount.value.split('.');
  const cents = Number(whole) * 100 + Number((fractional + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents < 0) throw new EbayApiError(errorId);
  return cents;
}

function validateListingPayload(payload: ListingPayload): void {
  if (!payload || !isNonEmptyString(payload.sku) || !payload.inventory || !payload.offer || payload.offer.sku !== payload.sku) {
    throw new EbayApiError('INVALID_LISTING_PAYLOAD');
  }
  if (payload.offer.marketplaceId !== 'EBAY_US' || payload.offer.format !== 'FIXED_PRICE') {
    throw new EbayApiError('INVALID_LISTING_PAYLOAD');
  }
}

function validateIdentifier(value: string, errorId: string): void {
  if (!isNonEmptyString(value) || value.length > 256 || /[\u0000-\u001F]/.test(value)) throw new EbayApiError(errorId);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character] ?? character);
}

function requiredRecord(value: unknown, errorId: string): JsonRecord {
  if (!isRecord(value)) throw new EbayApiError(errorId);
  return value;
}

function optionalRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function requiredString(value: unknown, errorId: string): string {
  if (!isNonEmptyString(value)) throw new EbayApiError(errorId);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function requiredNonNegativeInteger(value: unknown, errorId: string): number {
  const parsed = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new EbayApiError(errorId);
  return parsed;
}

function requiredPositiveInteger(value: unknown, errorId: string): number {
  const parsed = requiredNonNegativeInteger(value, errorId);
  if (parsed === 0) throw new EbayApiError(errorId);
  return parsed;
}

function requiredBoolean(value: unknown, errorId: string): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new EbayApiError(errorId);
}

function asArray(value: unknown): unknown[] {
  return value === undefined ? [] : (Array.isArray(value) ? value : [value]);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(errorId: string): never {
  throw new EbayApiError(errorId);
}
