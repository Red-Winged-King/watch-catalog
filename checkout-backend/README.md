# Watch Catalog · eBay Checkout Bridge

Companion backend and enhanced storefront for [Red-Winged-King/watch-catalog](https://github.com/Red-Winged-King/watch-catalog). The original archive imagery, categories, zoom and saved BAG1 selections are retained. Buyer payment always happens on a real eBay listing; this application does not process cards or place purchases.

## Start and check

Node 22 and pnpm 11.25.0 are pinned. Run `pnpm install`, `pnpm db:migrate`, then `pnpm dev` from this project directory. `pnpm typecheck`, `pnpm test` and `pnpm build` exercise source and isolated fixtures. `/health` checks the managed database schema, and `/manus-routes.json` lists real pages. Runtime secrets and MySQL come from the managed environment, not committed `.env` files. The container reads all secrets at runtime.

The storefront is available in Preview. `/admin.html` is the owner dashboard. No live supplier records, sold prices, seller tokens or Production eBay listings are seeded. Archive-only items show no invented buyable price.

## Owner authentication

The dashboard uses real Manus account login with `webdev_app_session`, HS256 project validation and CSRF protection. The owner must be explicitly pinned through protected project settings as `ADMIN_OPEN_ID`. Sign in first: the dashboard can show the authenticated account's own Open ID even before owner privileges are configured. Copy that ID into the protected setting. There is no first-visitor owner claim, fake Preview user, or customer-account requirement.

The published companion origin https://watchbuy-ko4chrlv.manus.space is explicitly allowlisted for owner login and browser API calls, alongside the current managed Preview and existing GitHub Pages origin. Use `APP_PUBLIC_ORIGIN` only to add an actual additional custom-domain origin. Update Preview-origin configuration if the sandbox Preview address changes; it is not the published backend URL. The callback uses the browser's actual origin, never an internal request Host.

## eBay protected setup

In protected project settings, supply `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` using the existing eBay connector as the input-card reuse source where available. Connector health verification is not seller authorization and does not automatically persist keys into a published project. Do not paste credentials into chat, code, public config or GitHub.

Register the eBay Production RuName's OAuth Accepted URL as `https://watchbuy-ko4chrlv.manus.space/api/ebay/callback`. This verified public address is the application default; `EBAY_CALLBACK_URL` is needed only for an explicitly configured custom-domain override. If an existing RuName serves another app, create a separate redirect entry rather than changing its callback unexpectedly. Save the corresponding Production value as protected `EBAY_RUNAME`.

For first-time token encryption setup, sign into the owner dashboard, click **Copy new encryption key**, and paste the clipboard value into the protected `TOKEN_ENCRYPTION_KEY` card. The owner-only helper uses browser cryptographic randomness to generate 32 bytes and base64-encode them. It never displays the key, sends it to the application API, logs it or stores it in browser storage. Once configured, the helper is hidden. Do not rotate that key casually: it encrypts seller refresh tokens already stored in the database. The owner can then click **Connect eBay seller** and grant the official seller scopes. Seller tokens remain server-side and encrypted.

Configure actual seller payment, fulfillment and return policies, an enabled location with accurate shipping origin, confirmed US combined supplier shipping tiers and a zero-additional-buyer-charge delivery service. Seller API validation still occurs immediately before publication. The initial release supports USD / EBAY_US and US delivery only; international and mixed-category/condition bundles fail closed.

## Price and exact approvals

Read [confirmed inputs and Product Research imports](docs/PRODUCT-DATA.md). The selling price is the greater of the rounded-up supplier-landed/sold-reference midpoint and supplier cost + combined supplier shipping + $10 per watch unit, plus separately configured accessory margins. The floor is before marketplace fees, not a guarantee of net profit.

Actual 90-day comparable sold-price imports are required. Active asking prices and model-family guesses are not substitutes. Prepare an exact basket draft in the owner dashboard and review the inventory and offer payloads, descriptions, images, policies, price and maximum listing fee. Approval alone does not publish. Only a customer handoff with unchanged approved context and every readiness gate satisfied can publish/reuse it. New baskets or changed economics/terms require review.

## Ten-minute expiry and launch

Read [listing lifecycle operations](docs/OPERATIONS.md). Publish the checkpoint, create and bind the one-minute platform HTTP schedule, and verify an actual authenticated run. Enable live checkout only after the owner/seller/policy/data/approval gates are met. The app stores `expiresAt = successful publication time + 600 seconds`; the next eligible durable worker run checks all sale evidence and withdraws only unsold app-owned listings. A buyer commitment, including pending payment, suppresses expiry. No order cancellation/refund code exists. Outages can make withdrawal late; exact atomic 10:00 expiry is not supported.

A completed purchase remains a fulfillment obligation and its stock reservation is not automatically released. Automated supplier ordering, fulfillment and restocking are outside this initial bridge. A sold canonical basket is blocked pending seller inventory review rather than silently relisted. The owner dashboard distinguishes verified sale evidence from outbound click counts; no conversion uplift or per-visitor attribution is invented.

## Existing GitHub Pages site

The companion project serves `public/` for Preview and can serve it after deployment. The original GitHub Pages site continues using its existing `gh-pages` branch. A feature branch/PR contains the enhanced static files and a separate `checkout-backend/` source copy, preserving the original repository history. It is not automatically live.

After the companion backend is successfully published, set the non-secret `WATCH_CHECKOUT_API_ORIGIN` in `commerce-config.js` to that confirmed permanent HTTPS origin, then deploy the reviewed static changes to the existing Pages branch. Never point Pages at an ephemeral sandbox Preview URL. Backend publication, schedule activation, GitHub Pages deployment and a successfully paid order are four different outcomes and must be verified separately.
