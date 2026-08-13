/**
 * Connection glue — DOCUMENTED, NOT IMPLEMENTED (adapter-only, matching
 * `packages/integrations/{ebay,medusa,woo,invoiceninja}/src/connection.ts`).
 *
 * This module deliberately contains no code that reads or writes the
 * connection model. It records the exact contract
 * `packages/app/src/etsy.ts` (the composition-root adapter factory) and
 * `apps/web/src/server/etsy-oauth*.ts` (the consent UX) implement against,
 * following the binding design's "No connection.ts file" note verbatim —
 * eBay's own `connection.ts` documents rather than implements the contract,
 * and this package does the same.
 *
 * ## The contract
 *
 * ```text
 * provider              'etsy'
 * channel                'etsy'
 * marketplace              null    (see observation.ts's ETSY_MARKETPLACE —
 *                                   the DB column itself needs a non-empty
 *                                   string, so a fixed 'etsy' constant fills
 *                                   it; conceptually Etsy has no
 *                                   sub-marketplace the way eBay does)
 * credential_type 'oauth_tokens'   (REUSED from eBay's slot — same
 *                                   {accessToken, refreshToken} shape;
 *                                   Etsy's user id is NOT secret and rides
 *                                   on connections.config.etsyOAuth instead,
 *                                   the same split eBay uses for its scopes)
 * bundle purpose 'oauth_tokens'    (reused, ADR-0019)
 * source_account_key 'etsy:<shopId>'
 * ```
 *
 * ## The application keyset — a SEPARATE, new bundle purpose
 *
 * `etsy_keyset` (`{keystring, sharedSecret}`) is registered in
 * `packages/domain/src/bundles.ts` alongside the existing seven, stored as
 * the APPLICATION secret `integration.etsy.keyset` — one per Loxep
 * installation, the direct analogue of `ebay_keyset`. It is new (not
 * reused) because Etsy's shared secret has no eBay equivalent to fold into
 * an existing schema — eBay's `certId` plays a related role, but the bundle
 * shapes differ enough that sharing one would be a false economy, per the
 * design.
 *
 * ## Non-secret consent facts — `connections.config.etsyOAuth`
 *
 * ```ts
 * {
 *   etsyUserId: string;               // needed to reassemble the Bearer header
 *   scopes: string[];                 // what was actually granted
 *   refreshTokenExpiresAt: string | null;
 *   consentedAt: string;              // ISO-8601, set by the callback
 * }
 * ```
 *
 * matching `EbayCredentialWrite.connectionConfig`'s split exactly (see
 * `oauth.ts`'s `credentialWriteForBundle`/`bundleFromCredential`).
 *
 * ## Rate budget — SHARED, not per-connection (the one place this contract
 * genuinely differs from every other provider in the codebase)
 *
 * See `rate-budget.ts`'s module doc for the full reasoning. The consequence
 * for `packages/app/src/etsy.ts`: it builds exactly ONE `RateBudget` at
 * composition-root scope (`buildAppServices`) and threads the SAME instance
 * into every Etsy connection's adapter — there is no per-connection budget
 * map the way `packages/app/src/ebay.ts`/`woo.ts` keep one.
 *
 * ## Monitor target types this provider registers
 *
 * `etsy_listing` (single listing, public auth) and `etsy_shop` (one shop's
 * active listings, public auth) — both in `@loxep/market`'s
 * `MONITOR_TARGET_TYPES`/`monitorTargetConfigSchemas` from day one (m1
 * learns from the `ebay_orders` split-registration gap the design and
 * `packages/app/src/registry.ts`'s module doc both call out: register a
 * target type in the closed list and its config schema TOGETHER, never
 * split across changes). `etsy_orders`/`etsy_search` are NOT part of this
 * contract — m2/m3, out of this package's current scope.
 */
export {};
