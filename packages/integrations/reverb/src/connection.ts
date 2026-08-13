/**
 * Connection glue — DOCUMENTED, NOT IMPLEMENTED (adapter-only, matching
 * `packages/integrations/{ebay,etsy,medusa,woo}/src/connection.ts`).
 *
 * This module deliberately contains no code that reads or writes the
 * connection model. It records the exact contract
 * `packages/app/src/reverb.ts` (the composition-root adapter factory) and
 * `apps/web/src/server/admin-functions.ts` (the guided "Add Reverb account"
 * form) implement against.
 *
 * ## The contract
 *
 * ```text
 * provider              'reverb'
 * channel                'reverb'
 * marketplace              'reverb'   (fixed constant — see
 *                                       observation.ts's REVERB_MARKETPLACE;
 *                                       Reverb has no sub-marketplace
 *                                       concept)
 * credential_type 'reverb_credentials'   (NEW bundle, {personalAccessToken})
 * bundle purpose 'reverb_credentials'    (ADR-0019)
 * source_account_key 'reverb:<connectionId>'   (see below)
 * ```
 *
 * ## The credential bundle — one field, no keyset
 *
 * `reverb_credentials` (`{personalAccessToken}`) is registered in
 * `packages/domain/src/bundles.ts` alongside the existing purposes. There
 * is no application-level `reverb_keyset` the way Etsy/eBay have one —
 * Reverb has no application-level credential at all; the Personal Access
 * Token IS the whole credential, and it does not expire.
 *
 * ## No non-secret connection config
 *
 * UNLIKE every other marketplace/store adapter in the catalog, this
 * provider's `connections.config` carries NOTHING: no `baseUrl` (Reverb has
 * one fixed host), no shop identifier (m1's `reverb_shop` target always
 * means "the connection's own account" — there is no operator-entered shop
 * id to store). This is closer to Purelymail's "the token IS the account"
 * shape than to Woo's or Etsy's connection config.
 *
 * ## `source_account_key` — a documented divergence, not an oversight
 *
 * Because Reverb exposes no account identifier without spending a live
 * `/my/account` call, `source_account_key` derives from the LOXEP
 * connection id (`reverb:<connectionId>`) rather than a Reverb-reported
 * fact, mirroring Purelymail's own documented fallback. See the binding
 * design's "Credential bundle" section for the collision caveat this
 * implies (two connections holding the same underlying Reverb account's PAT
 * are not detected as duplicates by this key).
 *
 * ## Rate budget — PER CONNECTION, the eBay/Woo pattern
 *
 * See `rate-budget.ts`'s module doc for the full reasoning. The consequence
 * for `packages/app/src/reverb.ts`: it builds one `RateBudget` PER
 * CONNECTION (a `Map<connectionId, RateBudget>`), exactly like
 * `woo.ts`/`ebay.ts` — never a single shared instance the way `etsy.ts`
 * deliberately is.
 *
 * ## Monitor target types this provider registers
 *
 * `reverb_listing` (single listing, any PAT scope that grants public read)
 * and `reverb_shop` (the connected account's own listings, needs
 * `read_listings`) — both in `@loxep/market`'s `MONITOR_TARGET_TYPES` AND
 * `monitorTargetConfigSchemas` from the same change that adds the
 * `packages/app/src/registry.ts` route, learning from the `ebay_orders`
 * split-registration gap the way Etsy's `etsy_listing`/`etsy_shop` already
 * did. `reverb_orders`/`reverb_search` are NOT part of this contract —
 * m2/m3, out of this package's current scope.
 */
export {};
