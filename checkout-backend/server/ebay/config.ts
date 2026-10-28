// Public application metadata, not a credential. eBay must register this exact
// Accepted URL for the Production RuName before seller authorization can complete.
export const DEFAULT_EBAY_CALLBACK_URL = 'https://watchbuy-ko4chrlv.manus.space/api/ebay/callback';
export function ebayCallbackUrl(): string {
  return process.env.EBAY_CALLBACK_URL || DEFAULT_EBAY_CALLBACK_URL;
}
