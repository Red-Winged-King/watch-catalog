# Live activation gates

This build is an implemented bridge, not a live eBay seller launch. Keep liveEnabled false until the following dependencies are real and verified.

First, the owner signs into the real Manus owner dashboard, obtains their own authenticated Open ID and pins ADMIN_OPEN_ID in protected project settings. Supply the Production app credentials through the protected project input surface, reusing the saved eBay connector where offered. The published origin https://watchbuy-ko4chrlv.manus.space is explicitly allowlisted; an additional custom domain needs APP_PUBLIC_ORIGIN. Never send the public GitHub storefront to an ephemeral Preview API URL.

Second, publish the companion backend to obtain its permanent HTTPS origin, register the exact eBay /api/ebay/callback URL and RuName, provision a 32-byte base64 TOKEN_ENCRYPTION_KEY, then authorize the seller using official eBay OAuth. Confirm actual seller policies and location. App credentials alone cannot create listings for a seller.

Third, import at least one fully confirmed genuine watch and its actual Product Research sold-price reference. Confirm supplier fulfillment agreement, actual stock, packed weight, shipping origin, combined shipping cost, category/aspects, photos and matching eBay delivery/return policies. An archive photo and broad family name are not enough to identify a sellable genuine model.

Fourth, prepare and explicitly approve the exact inventory and offer payload for that watch/basket, including price, quantity, policies and fee ceiling. Validated new bag quotes can enter the owner's draft queue; that is not authorization to publish. New bundles or changed listing terms remain unavailable until approved.

Fifth, publish the version containing the expiry callback, create the one-minute platform schedule, bind its actual task UID and verify an authenticated callback. The worker's durable stored health must be current before new listings can be created. Callback code alone is not a running schedule.

Finally, authorize a specific low-risk live listing for real end-to-end verification. The build's isolated tests are not proof of eBay listing publication, payment, pending-payment handling or automatic ending on this seller. Do not buy items as part of setup, and never end unrelated seller listings. Once those launch gates are verified, enable live checkout and deploy the frontend changes to the existing gh-pages branch with the confirmed backend API origin.
