# Confirmed product and sold-price imports

The archive's 592 entries are not a verified sellable inventory feed. No products or prices are seeded as sellable. Start with one genuine watch whose exact manufacturer model, variant, condition, supplier agreement, photos, costs, stock and shipping can be substantiated. An archive SKU is not an exact eBay model identifier.

The owner dashboard imports JSON arrays using the `Product` and `SoldReference` shapes in `server/contracts.ts`. Importing products does not authorize any listing. Import references after the corresponding exact products are present. Use integer US cents for all currency amounts and grams for confirmed packed product weights. Accessory entries must use kind `accessory`, a separately configured accessory margin and exact compatibility; they must never be counted as a watch for the $10 floor.

## Product Research inputs

Use eBay Seller Hub → Research → Product Research. Search the exact model, variant and matching condition, choose the US marketplace and a recent 90-day window, and exclude parts-only listings, unrelated variations, lots and accessories. Record the actual arithmetic average sold item price, not the current asking price. Accepted Best Offer prices must use eBay's actual recorded sale information, not a crossed-out listing price. The initial import convention is ITEM_ONLY, excluding comparable shipping, in USD.

Each reference must carry its catalog SKU, exact model/variant/condition, averageSoldCents, positive sampleSize, windowStart/windowEnd, checkedAt, EBAY_PRODUCT_RESEARCH source, a genuine HTTPS eBay research source URL, priceBasis ITEM_ONLY, comparableConfirmed true and excludesPartsAndLots true. The backend rejects future, stale or mismatched records. Its initial maximum reference age is 30 days and can be shortened. A 90-day observation window must span 89–92 days to accommodate source date boundaries.

There is no automatic sold-history API enabled by this build. A business developer key does not by itself unlock restricted Marketplace Insights. Update imports when prices change; an economic or listing-policy change invalidates the old exact draft approval. Do not upload customer information or card details.

## Combined shipping and seller policies

Configure confirmed supplier shipping tiers by combined actual product weight plus package weight. Each tier is maxGrams and costCents; the first adequate tier is used. Outside a known tier, checkout fails closed rather than extrapolating. These settings are specific to US delivery in this initial version. The eBay listing must have matching delivery eligibility and no additional buyer shipping charge for the supported service before the UI says shipping included.

The shipping-inclusive floor is supplier cost + combined supplier shipping + $10 for every watch unit, plus any separately configured accessory margin. The selling total is the greater of that floor and the upward-rounded midpoint of landed supplier cost and the total sold-price references. This is not net profit after eBay fees or returns. Do not add estimated taxes into a fake all-in total; eBay determines applicable tax and final delivery eligibility.

## Exact listing review

Prepare a draft for a specific basket in the owner dashboard. Review its inventory item and offer payloads, model/variant/quantity breakdown, images, price, location, payment/return/fulfillment policies and fee ceiling. Approval authorizes that unchanged payload to be used by customer checkout; it does not immediately publish. A new basket, changed commercial terms or price requires a fresh approval. Keep live checkout off until seller authorization and the healthy durable scheduler are ready.
