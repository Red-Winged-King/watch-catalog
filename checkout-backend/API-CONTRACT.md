# Implementation contracts

Server TypeScript shared shapes are in `server/contracts.ts`. All API responses are JSON. Errors: `{error: string, code: string, details?: unknown}`, errors must not expose secrets/private supplier cost. Prices are USD integer cents. Initial supported market is EBAY_US, delivery to US only; eBay confirms eligibility. Missing data is unavailable, never demo commerce.

## Public

- GET /api/commerce → `{products: {sku,title,model,variant,kind,condition,priceCents?:number,available:boolean,reason?:string,shippingSummary?:string,returnsSummary?:string}[], currency:'USD', shippingCountry:'US', checkoutEnabled:boolean, message:string}`. No private costs or credentials.
- POST /api/quote body `{items:[{sku,quantity}]}` → `{quote: Quote, readyToCheckout:boolean, message:string}`; 422 if unverified/incompatible; no approval/publication side effect. Eligibility includes exact approval, live readiness and expiry-scheduler health.
- POST /api/checkout body `{items:[{sku,quantity}], idempotencyKey:string}` → `{id,state,quote,listingUrl?:string,expiresAt?:string,accessToken:string,message:string}`. Approvals absent → 409 `APPROVAL_REQUIRED`, not a fake listing. Backend never publishes without exact owner approval.
- GET /api/checkout/:id with `Authorization: Bearer <accessToken>` → `{id,state,listingUrl?,expiresAt?,message}`. Local checkout id and accessToken remain only on this device. An expired record disables handoff; request fresh quote and keep bag.
- POST /api/events body `{type,sku?:string,checkoutId?:string}` → 202; predefined privacy-conscious event names only. No session/user/payment data.

## Authentication and admin

- GET /api/auth/me → `{authenticated:boolean,isAdmin:boolean,openId?:string,name?:string,csrfToken?:string,ownerConfigured:boolean}`.
- POST /api/auth/start body `{origin:location.origin}` → `{url}` (real Manus OAuth); GET /auth/callback processes code and state, redirects only /admin.html. POST /api/auth/logout with X-CSRF-Token logs out.
- All mutation admin endpoints require real authorized owner session, allowed Origin, X-CSRF-Token from auth/me. Unauthorized 401/403. No Preview bypass. ADMIN_OPEN_ID environment pin; fail closed when not configured.
- GET /api/admin/dashboard → `{settings:Settings,products:Product[],references:SoldReference[],drafts:Draft[],checkouts:Checkout[],readiness:{ready:boolean,checks:{key,label,ok,detail}[]},seller:{connected:boolean,sellerName?:string},schedule:ScheduleBinding|null,metrics:{events:Record<string,number>,verifiedSales:number}}`.
- PUT /api/admin/settings `{settings:Settings}` → saved settings. Server validates. Live enabled cannot bypass prerequisites.
- POST /api/admin/products/import `{products:Product[]}` → `{imported:number}`. JSON import with atomic validation and catalog SKU matching. Preserve unchanged data and reservations.
- POST /api/admin/references/import `{references:SoldReference[]}` → `{imported:number}`. Actual eBay Product Research only; exact match, valid 90-day window, sample metadata.
- POST /api/admin/drafts `{items:[{sku,quantity}]}` → `{draft:Draft}` includes exact inventory+offer payloads with hash; no eBay mutation.
- POST /api/admin/drafts/:id/approve `{payloadHash:string,maxListingFeeCents:number,confirm:true}` → `{draft}`. UI shows exact payload/price/terms plus fee ceiling and 10-min unsold expiry; explicit owner confirm. New/changed basket context needs fresh approval. Does not publish by itself.
- POST /api/admin/ebay/connect `{origin:location.origin}` → `{url}`; GET /api/ebay/callback handles state and exchanges seller OAuth. eBay client + secret + EBAY_RUNAME + EBAY_CALLBACK_URL + TOKEN_ENCRYPTION_KEY are protected env. Seller tokens encrypted DB. Registered callback exact HTTPS URL.
- POST /api/admin/schedule `{taskUid:string,enabled:boolean}` → binding, for a platform schedule UID created in Dashboard/CLI. Authenticated scheduled callback resolves and matches identity, not body IDs.
- POST /api/scheduled/expire ignores body; platform app_session_id JWT HS256 + appId + cron identity + authoritative GetUserInfoWithJwt taskUid → binding → sweeper.

## Commerce module (agent-owned)

`server/commerce/index.ts` exports `parseCart(input):CartLine[]`, `validateProducts(input, catalogSkus:Set<string>):Product[]`, `validateReferences(input, products:Product[], now?:Date):SoldReference[]`, `validateSettings(input):Settings`, `calculatePrice(cart,products,references,settings,now?:Date):PriceResult`, `buildListing(cart,products,settings,price):ListingPayload`, `buildDraft(cart,products,references,settings,now?:Date):Draft`. Can throw normal Error with useful message. Canonical content hash via stable JSON object key order (export `stableHash(value)`). Deterministic basketKey depends canonical SKU+quantity only; contextHash includes all data affecting quote/payload/supplier/stock and listing policies, excluding timestamps that do not change economics. Draft id equals payloadHash+contextHash stable hash (<=64 hex).

## eBay module (agent-owned)

`server/ebay/index.ts` exports class EbayClient with constructor `(getSellerConnection:()=>Promise<SellerConnection|null>)`; adapter uses process env only server-side. Methods:
- authorizationUrl(state:string):string
- exchangeCode(code:string):Promise<SellerConnection> (use actual seller identity; encrypt refresh token; confirm required scopes)
- refreshSeller():Promise<{accessToken:string,sellerId:string}>
- createInventory(payload:ListingPayload):Promise<void>
- createOffer(payload:ListingPayload):Promise<{offerId:string}>
- getOffer(offerId:string):Promise<{offerId:string,sku:string,status:string,listingId?:string}>
- publish(offerId:string):Promise<{listingId:string,listingUrl:string}>
- withdraw(offerId:string):Promise<{listingId:string}>
- estimateFees(offerId:string):Promise<number> (integer cents, fail closed if fee response cannot be verified)
- saleEvidence(listingId:string,sku:string,since:string):Promise<SaleEvidence> (both read-only listing/GetItem and transactions plus fully paginated narrow getOrders; missing/inconclusive fails closed, no getOrders-only safety).
- validateSellerSetup(settings:Settings):Promise<{ok:boolean,issues:string[]}> checks configured location and policies incl zero extra buyer shipping.
No order cancellation/refund/purchase endpoints. Errors sanitized, token response never printed. Side-effecting publication/withdrawal never automatic retry; caller reconciles.

Main agent owns DB, auth, lifecycle, jobs, Express, dependencies and docs. Frontend agent owns `public/*` including admin pages. Commerce/eBay agents own their module directories and tests uniquely named. Do not edit another owner's files.
