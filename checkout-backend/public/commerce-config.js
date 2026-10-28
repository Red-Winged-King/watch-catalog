/*
 * Public browser configuration only. In the managed app this remains empty so API
 * requests are same-origin. For the GitHub Pages storefront, set this to the
 * published HTTPS backend origin (for example, https://checkout.example.com).
 * Never put credentials, seller tokens, or private costs in this file.
 */
window.WATCH_CHECKOUT_API_ORIGIN = window.WATCH_CHECKOUT_API_ORIGIN || '';
