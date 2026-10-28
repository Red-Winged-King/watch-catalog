# Listing lifecycle operations

This backend never purchases watches, cancels orders or refunds customers. Supplier fulfillment remains the seller's responsibility. A public eBay listing is not a buyer-exclusive checkout reservation.

A customer checkout requires a current validated quote, exact owner-approved inventory/offer payload, available stock, authorized seller, confirmed policies, daily listing/fee budgets, enabled live mode and a healthy authenticated expiry schedule. Requests and canonical baskets are stored durably. Repeated requests reuse the same checkout record; uncertain side effects are reconciled, never blindly retried with a new listing.

Successful publication records the exact offer/listing ownership chain and an expiresAt deadline 600 seconds later. A one-minute sweep attempts no withdrawal before the deadline. It first checks listing sold quantity, transactions and seller orders. Any buyer commitment, including a pending payment, permanently suppresses expiry. A valid purchase remains a fulfillment obligation even if discovered during or after withdrawal.

There is no exact atomic 10:00 expiry primitive on eBay. The normal target is the first eligible worker run after ten minutes plus eBay processing. Outages or inconclusive sale evidence can leave a listing live longer; this is safer than expiring a valid order. The buyer handoff link stops being offered at the stored deadline even while backend reconciliation is incomplete. An expired listing does not clear the local bag.

## Published schedule

After successful backend publication, create a platform-owned HTTP schedule in the project's Dashboard, or run `manus-heartbeat create --name watch-listing-expiry --cron '0 * * * * *' --path /api/scheduled/expire --description 'Reconcile and end only app-owned unsold watch listings after 10 minutes'` in the bound project directory. Use its returned task UID, not its display name or the cron openId, to bind the schedule in the owner dashboard. Wait for an actual authenticated run and inspect its result. Registration is not evidence of successful execution.

The callback verifies the platform HS256 JWT signature, expiry, project ID and cron identity, then resolves GetUserInfoWithJwt and looks up the stored task UID binding. Body identifiers cannot select work. Retries are safe because rows, ownership, sale evidence and publication outcomes are persisted. Readiness stops new checkouts if the latest successful callback is older than three minutes or its latest run reports exceptions.

## Seller exceptions

PUBLISH_UNCERTAIN means a publication response was lost. Recover the same saved offer; do not create a replacement. If a previously unknown listing is confirmed published, record one full ten-minute window from its first recovered observation. This can end later than ten minutes after the original publication but never earlier. RECONCILIATION_REQUIRED means the seller must inspect the exact saved offer/listing, not unrelated inventory. END_RETRY preserves the same ownership and uses bounded backoff. The dashboard exposes these states and sale evidence; the service has no cancellation or refund operation.

Known ended offers can be reused only when their exact payload is unchanged and eBay confirms the old offer is unpublished. A basket that has recorded a purchase remains blocked for seller inventory review; committed reservations are not automatically released or treated as available stock. This conservative initial release does not implement automated supplier fulfillment, restocking or order settlement. Do not change database rows casually to re-enable a sold basket.

The MySQL schema is additive and migrations are explicit (`pnpm db:migrate`). Runtime and development share the same managed database; use pure fixtures for tests. All durability lives in MySQL, not a sandbox timer or container filesystem. Keep protected refresh-token encryption keys stable; rotation requires a deliberate token re-encryption procedure.

Before first live use, obtain explicit approval of one exact low-risk listing and verify publication, unsold ending, repeat-click handling, pending-payment protection and a purchase race with authorized participants. Real Sandbox tests require a separate Sandbox app/seller setup; the current adapter is Production-only and is not configured to misdirect Production credentials to Sandbox. Automated fixture tests are not a claim that live listing publication or payment was tested.
