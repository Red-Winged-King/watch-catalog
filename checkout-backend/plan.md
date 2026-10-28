# Watch catalog → eBay: checkout and automation plan

Author: Manus AI  
Prepared: 28 October 2026  
Status: Approved by the owner on 28 October 2026, including the stronger shipping-inclusive floor and Product Research imports; software implementation complete; seller onboarding and live activation remain gated. The enhanced storefront and backend are implemented in the companion project; no live eBay listings have been created. The existing GitHub Pages deployment remains unchanged pending the integration pull request and a confirmed published backend origin.

## The current buying journey

The published catalog is https://red-winged-king.github.io/watch-catalog/, served from the repository's `gh-pages` branch. Its storefront source matches `main`. A visitor opens the catalog, searches or filters, optionally inspects a watch image, and adds items with quantities to a local bag. The bag's final actions are Copy code and Open decoder. Neither leads to eBay payment. There is no current checkout funnel to shorten: the payment connection first has to be built.

The catalog contains 592 archive entries. Its stable SKU and shipping-weight fields are useful, but its category labels do not identify exact manufacturer references or variants. It has no commercial price, availability, supplier mapping, eBay listing ID, condition, or return-policy data. Watches and covers/accessories must remain visibly distinct.

## Recommended customer journey

Use the existing storefront as the browsing and bag interface. Use a secure companion backend to prepare a real, correctly described eBay fixed-price offer. For a single watch, the offer describes that watch. For a multi-item bag, the offer describes the complete selected bundle, including exact models, variants, quantities and any accessories. A mixed-watch bundle is not automatically an eBay lot: `lotSize` describes multiple units of the same product. [1]

**Single-watch path:** browse or search → see exact product and quoted selling price → Buy on eBay → the real eBay listing → Buy It Now → eBay's guest/sign-in and delivery/payment steps → Confirm and pay. A product already fully identified on its card should not require an additional detail-page visit.

**Multi-item path:** browse and Add to bag → review quantities, exact items and the quote in the bag drawer → Continue to eBay → one real listing for the complete bundle → Buy It Now → eBay checkout → Confirm and pay.

These are customer stages, not a guaranteed click count. eBay may require sign-in, address entry, payment entry, or an additional verification step. Eligible native Buy It Now purchases may allow guest checkout; do not promise it for every listing. [2] [3]

The backend must publish or reuse the correctly approved listing before returning its destination. It cannot pretend that the bag has moved to eBay while showing an ordinary empty cart. Use the exact eBay view-item URL or the verified listing-ID mapping; do not rely on undocumented cart/Buy It Now deep-link hacks. eBay's cart page only shows the buyer's existing cart. [4] [5]

There will be no storefront customer-account requirement, duplicate address form, code-copy requirement, or automatic multi-tab opening. Use a same-tab handoff with the local bag preserved for return/back navigation. The action will say “Continue to eBay,” with “You will review delivery, tax and payment on eBay” beside it. If preparation fails, keep the bag and show a retry state rather than an unexplained redirect.

A true embedded multi-item Checkout with eBay widget is a possible future alternative, but guest and member Order API access require separate eBay approval. Valid Production app credentials do not establish that access. It will not be shown as an available payment method until approved and integrated. [6]

## Changes aimed at reducing confusion and abandonment

Retain the current dark archive styling and supplied watch imagery rather than replace the site with an unrelated design. Keep the existing category navigation and image zoom. Make exact model, variant, condition and product type the primary purchase information; the archive SKU/page number becomes secondary.

Put the price and shipping treatment beside Buy and in the bag's sticky summary. If confirmed supplier shipping is included in the selling price and the corresponding eBay policy has no additional buyer shipping charge, say “Shipping included; tax calculated by eBay.” Otherwise state the known item price and explicitly identify delivery/import/tax amounts that remain unknown. Never label a partial price “all-in.” Earlier cost clarity is a supported usability improvement, but not evidence of a particular conversion uplift for this site. [7]

Buy is the primary single-item action; Add to bag is secondary. A drawer footer shows the selected items, quantities, total and one primary handoff. Keep BAG1 as an optional save/share utility, not the purchase outcome. Show truthful shipping/return terms only when supplied by the actual offer policies. Unmapped or unverified products remain browse-only, with a clear explanation—not a fake price, stock claim or working-looking Buy button.

Add accessible loading/error messages, retry controls, keyboard focus handling, safe saved-bag recovery, and a visible retained-bag state after an expired link. Separate an empty search from a failed catalog load. Do not add invented reviews, authentication badges, scarcity, or promises of maximum conversion.

Record privacy-conscious funnel events such as product view, add to bag, quote success/failure, handoff, expiry and recovery. An outbound click is not a purchase. Only verified eBay sale/order evidence will count as a sale, and a shared public listing cannot prove which visitor bought it. Use a baseline and small subsequent experiments to optimize actual results.

## Authoritative pricing and product readiness

The retail reference must be actual sold prices for comparable genuine products, not current asking prices. The proposed default is the recent 90-day arithmetic average for the exact model, variant, condition and marketplace/currency, with parts, accessories and unrelated lots excluded. Store the source, observation window, sample size and update time. Define shipping treatment consistently rather than mixing item-only and delivered comparable prices.

Automatic sold-history lookup is currently a prerequisite, not a delivered capability. eBay states that Marketplace Insights is restricted and closed to new users. If this app lacks approved access, provide a clearly labelled admin import/input for actual Product Research averages. Product Research exposes actual accepted Best Offer prices as well as average sold prices. It is not a documented public API. Manual supplied averages are a fallback requiring the owner's agreement; do not silently substitute active listings, guessed prices, or model-family averages. [8] [9]

For a bag, let `C` be supplier costs multiplied by quantities, `S` the confirmed combined supplier shipping cost, `R` the total comparable sold-price references multiplied by quantities, and `N` the number of watch units. The proposed selling-price rule is:

```text
candidate = (C + S + R) / 2
selling total = max(candidate, C + S + $10 × N)
```

Round to cents without lowering the chosen minimum. This proposed minimum is $10 per watch above supplier cost **plus shipping**, before eBay fees and other expenses. It is stronger than the user's original supplier-only floor and was approved on 28 October 2026. If the owner instead wants the original minimum, use `max(candidate, C + $10 × N)` and clearly acknowledge that it need not cover shipping. Accessory margin treatment must be configured separately; do not silently count a cover as a watch. Neither formula guarantees $10 net profit after marketplace fees, returns, taxes/duties, or fulfillment costs.

The uploaded one-watch sheet is an input aid, not a complete supplier feed. It includes estimates and an example shipping tier from another tool. Do not infer all 592 SKU costs, stock or multi-item shipping from it. Selling controls become available only for confirmed supplier mappings with exact product facts, inventory/fulfillment rights, shipping origin/service/destinations and required eBay item details. eBay allows wholesale-based dropshipping under the stated agreement conditions and prohibits counterfeit branded watches. [10] [11]

## Ten-minute generated-listing expiry

There is no native 10-minute eBay listing duration. The backend will store the generated offer ID and listing ID and set `expiresAt = successful publication time + 600 seconds`. The storefront displays that server-derived deadline. The timer is operational link availability, not invented scarcity or a buyer-exclusive reservation. eBay's private-listing option hides buyer identities; it does not make a listing exclusive to one visitor. [12] [13]

Only generated, application-owned listings are eligible for automatic ending. Never end unrelated seller listings or a persistent listing merely because one visitor abandoned it. Prevent repeated requests and simultaneous identical fixed-price listings using durable idempotency and a canonical bundle hash. Identical baskets reuse or serialize the same valid offer; changing insignificant details is not a duplicate-policy workaround. [14]

At or after the deadline, a durable scheduled worker claims the record, checks eBay listing/transaction state and reconciles seller orders, then calls `withdrawOffer` only when it is still unsold. Store and verify the result. A sale, a buyer purchase commitment, or a pending payment stops expiry permanently; the system will not cancel, refund or relist that order. Fulfillment API results alone cannot prove that no sale exists, because some pending-payment purchases are omitted. Add read-only listing/transaction checks as a safety layer. [15] [16] [17]

Use the managed database and platform-owned scheduled HTTP callbacks, not a browser timer or sandbox `sleep`. A one-minute recovery sweep finds overdue records, uncertain publication/withdrawal outcomes and stale claims. Normal target: first eligible sweep after 10:00, generally within the following minute plus API processing. Never attempt early withdrawal. Retry safely after transient errors; keep an “ending/reconciliation” state and seller alert when completion is uncertain. Network outages and eBay races mean an exact 10:00 guarantee cannot be made. A completed purchase discovered during or after withdrawal remains a fulfillment obligation.

If the owner wants a tighter normal-time target than a one-minute sweep, implement a supported durable delayed-job service as a separate infrastructure choice. Do not pretend an in-process timer provides durable exact expiry.

Show “This generated listing may be withdrawn if unsold after [time]. A completed purchase remains valid.” Do not claim the item is reserved solely for this customer. Upon expiration, retain the bag and offer a fresh validated quote/listing request. Frequent short-lived listings can consume free-listing allowances and incur non-refundable insertion fees, so production mode needs rate limits and a seller-configured daily budget. These listings are meant for handoff traffic, not guaranteed exposure through eBay search. [18]

## Secure backend and project structure

Keep GitHub Pages for the public catalog and deploy a companion Node/Express TypeScript backend using the initialized Manus-managed server and MySQL database. Reuse plain JavaScript/CSS on the storefront. The companion project can serve the same catalog for Preview, while a public, non-secret API-origin configuration connects the original Pages site after backend publication. Allow only the configured storefront origins for browser API requests.

Suggested folders:

- `public/`: existing catalog HTML, JavaScript, CSS, images, data and the new checkout/status UI.
- `server/commerce/`: validated product mapping, combined shipping and integer-cent price calculation.
- `server/ebay/`: app/seller OAuth, exact inventory/offer payload preparation, publication, read-only sales reconciliation and withdrawal.
- `server/checkout/`: immutable basket snapshots, idempotency, ownership, approval gates and public status responses.
- `server/jobs/`: authenticated scheduled callbacks, durable outbox/recovery sweep and expiry state transitions.
- `server/admin/`: seller-only product/import/configuration and exact offer review controls.
- `db/`: additive schema/migrations for products, reference prices, checkouts, offer approvals, sale evidence and job state.
- `tests/`: pricing, input-validation, duplicate-request and lifecycle checks using controlled API fixtures; real eBay API verification remains explicitly separate.
- `docs/`: deployment, Pages changes, seller connection and operational instructions.

Protected project secrets hold app credentials and seller refresh credentials; they must never be embedded in frontend files, GitHub, build output or logs. Session connector credentials are verified but are not automatically provisioned into a published backend. Use the project's protected input form, with the existing eBay connection offered as a reuse source. Store any database-held OAuth credentials encrypted with an application-specific protected key. Protect seller controls with authenticated owner access and validate OAuth state/callbacks; buyers should not have to log into this application.

Use rate limits, bounded cart quantities, canonical SKU lookup, inventory validation, a daily listing cap and server-side prices. Never accept a client-supplied price, seller account, arbitrary eBay endpoint, listing description or expiry time. A copied BAG1 code is untrusted SKU/quantity input, not a payment authorization.

## Build, release and production boundaries

After this plan is approved, record its concrete outcomes in `TODO.md`, configure language diagnostics, implement the storefront and backend, add durable schema and expiry callbacks, and exercise the lifecycle with controlled tests. Save a managed checkpoint and prepare a feature branch/pull request for the existing GitHub repo, preserving its `main` and `gh-pages` histories. Publishing the companion backend and updating the Pages publishing branch are distinct operations; do not claim the live catalog changed merely because a feature branch exists.

Seller OAuth requires a registered callback/RuName and the seller's official consent. App authentication is already verified, but seller permissions, policies, inventory location, marketplace/category requirements and exact products remain unconfigured. Request only necessary scopes, including inventory mutation and read-only order/transaction reconciliation. Never use the seller token as a buyer token or call buyer purchase endpoints.

Production listing creation remains gated on approval of each exact listing payload, including products, quantities, price, shipping/return/payment policies, images, location and fees. Prepare drafts and expose exact approval; preapproved unchanged offers can be reused. A changed price or novel bundle is not covered by an old payload approval. Build and test the mechanics first without speculative Production listing creation. Sandbox credentials are separate if real Sandbox listing tests are required. Do not simulate a production success message when configuration/data is missing.

The planned outcome is an implemented, testable lower-friction bridge with explicit live-readiness controls—not a promise of automatic sold-history access, unsupported checkout shortcuts, zero marketplace fees, exact atomic expiry or guaranteed maximum buys.

## References

[1]: https://developer.ebay.com/api-docs/sell/static/inventory/pbse-special-listings.html "eBay special listings and bundles"
[2]: https://www.ebay.com/help/buying/buy-now/buying-guest?id=4035 "Buying as a guest"
[3]: https://www.ebay.com/help/buying/paying-items/checkout?id=4036 "eBay checkout"
[4]: https://www.ebay.com/help/buying/paying-items/shopping-cart?id=4360 "eBay shopping cart"
[5]: https://developer.ebay.com/api-docs/buy/static/api-browse.html "Browse API item destinations and identifiers"
[6]: https://developer.ebay.com/api-docs/buy/static/buy-requirements.html "Buy API production and checkout requirements"
[7]: https://baymard.com/research-articles/show-shipping-costs-on-product-pages "Showing estimated shipping costs on product pages"
[8]: https://developer.ebay.com/api-docs/buy/static/ref-marketplace-supported.html "Marketplace Insights access restrictions"
[9]: https://www.ebay.com/help/selling/selling-tools/product-research?id=4853 "Product Research actual sold-price averages"
[10]: https://export.ebay.com/en/services-tools/shipping/shipping-tips-and-best-practice/drop-shipping/ "eBay wholesale dropshipping policy"
[11]: https://www.ebay.com/help/policies/prohibited-restricted-items/fake-items-policy?id=4276 "eBay counterfeit policy"
[12]: https://developer.ebay.com/api-docs/sell/metadata/resources/marketplace/methods/getListingTypePolicies "Listing duration policies"
[13]: https://www.ebay.com/help/selling/listings/listing-tips/private-listings?id=4161 "Private listings hide buyer identities"
[14]: https://www.ebay.com/help/policies/listing-policies/duplicate-listings-policy?id=4255 "Duplicate fixed-price listings policy"
[15]: https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/withdrawOffer "Inventory API withdrawOffer"
[16]: https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders "Seller order reconciliation"
[17]: https://developer.ebay.com/devzone/xml/docs/reference/ebay/types/SellingStatusType.html "Listing-level quantity sold and status"
[18]: https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4822 "eBay selling fees"
