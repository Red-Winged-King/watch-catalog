export interface Product {
  sku: string; title: string; model: string; variant: string; brand: string;
  kind: 'watch' | 'accessory'; condition: 'NEW' | 'USED_EXCELLENT' | 'USED_GOOD';
  supplierCostCents: number; weightGrams: number; stock: number;
  accessoryMarginCents?: number; categoryId: string; description: string;
  imageUrls: string[]; aspects: Record<string, string[]>; compatibility?: string;
  supplierConfirmed: boolean; authenticConfirmed: boolean; fulfillmentAgreementConfirmed: boolean;
  enabled: boolean; updatedAt: string;
}
export interface SoldReference {
  sku: string; model: string; variant: string; condition: Product['condition'];
  currency: 'USD'; marketplaceId: 'EBAY_US'; averageSoldCents: number; sampleSize: number;
  windowStart: string; windowEnd: string; checkedAt: string;
  source: 'EBAY_PRODUCT_RESEARCH'; sourceUrl: string; priceBasis: 'ITEM_ONLY';
  comparableConfirmed: boolean; excludesPartsAndLots: boolean;
}
export interface Settings {
  marketplaceId: 'EBAY_US'; currency: 'USD'; liveEnabled: boolean;
  paymentPolicyId: string; fulfillmentPolicyId: string; returnPolicyId: string;
  merchantLocationKey: string; shippingCountry: 'US'; shippingOriginCountry: string;
  shippingSummary: string; returnsSummary: string; handlingDays: number;
  shippingConfirmed: boolean; freeShippingPolicyConfirmed: boolean;
  packageWeightGrams: number; shippingTiers: { maxGrams: number; costCents: number }[];
  maxCartUnits: number; maxDailyListings: number; maxDailyListingFeesCents: number;
  maxReferenceAgeDays: number; bundleAspects: Record<string, string[]>;
}
export const DEFAULT_SETTINGS: Settings = {
  marketplaceId: 'EBAY_US', currency: 'USD', liveEnabled: false,
  paymentPolicyId: '', fulfillmentPolicyId: '', returnPolicyId: '', merchantLocationKey: '',
  shippingCountry: 'US', shippingOriginCountry: '', shippingSummary: '', returnsSummary: '', handlingDays: 3,
  shippingConfirmed: false, freeShippingPolicyConfirmed: false, packageWeightGrams: 0, shippingTiers: [],
  maxCartUnits: 10, maxDailyListings: 10, maxDailyListingFeesCents: 0, maxReferenceAgeDays: 30, bundleAspects: {}
};
export interface CartLine { sku: string; quantity: number }
export interface QuoteLine { sku: string; title: string; model: string; variant: string; kind: Product['kind']; condition: Product['condition']; quantity: number }
export interface Quote {
  basketKey: string; currency: 'USD'; totalCents: number; shippingIncluded: true;
  taxDisclosure: string; shippingSummary: string; returnsSummary: string;
  lines: QuoteLine[]; calculatedAt: string; referenceCheckedAt: string;
}
export interface PriceResult { quote: Quote; supplierCents: number; shippingCents: number; retailCents: number; marginFloorCents: number }
export interface ListingPayload {
  sku: string;
  inventory: { availability: { shipToLocationAvailability: { quantity: number } }; condition: string; product: { title: string; description: string; imageUrls: string[]; aspects: Record<string, string[]> } };
  offer: { sku: string; marketplaceId: string; format: 'FIXED_PRICE'; availableQuantity: number; categoryId: string; merchantLocationKey: string; listingDuration: 'GTC'; listingDescription: string; pricingSummary: { price: { currency: string; value: string } }; listingPolicies: { paymentPolicyId: string; fulfillmentPolicyId: string; returnPolicyId: string } };
}
export interface Draft {
  id: string; basketKey: string; cart: CartLine[]; quote: Quote; payload: ListingPayload;
  payloadHash: string; contextHash: string; createdAt: string;
  approvedAt?: string; approvedBy?: string; approvedMaxListingFeeCents?: number;
}
export type CheckoutState = 'DRAFT' | 'PUBLISH_INTENT' | 'PUBLISH_UNCERTAIN' | 'ACTIVE' | 'COMMITTED' | 'EXPIRY_CLAIMED' | 'END_RETRY' | 'ENDED_UNSOLD' | 'RECONCILIATION_REQUIRED';
export interface Checkout {
  id: string; basketKey: string; draftId: string; payloadHash: string; cart: CartLine[];
  state: CheckoutState; sku: string; offerId?: string; listingId?: string; listingUrl?: string;
  createdAt: string; publishedAt?: string; expiresAt?: string;
  leaseUntil?: string; version: number; attempts: number; nextAttemptAt?: string;
  error?: string; saleEvidence?: SaleEvidence; estimatedFeeCents: number;
}
export interface SaleEvidence { committed: boolean; quantitySold: number; listingActive: boolean; listingId: string; sku: string; observedAt: string; orderIds: string[]; paymentStatuses: string[] }
export interface SellerConnection { sellerId: string; sellerName: string; refreshTokenEncrypted: string; scopes: string[]; connectedAt: string }
export interface ScheduleBinding { taskUid: string; enabled: boolean; lastSuccessAt?: string; lastAttemptAt?: string; lastError?: string }
