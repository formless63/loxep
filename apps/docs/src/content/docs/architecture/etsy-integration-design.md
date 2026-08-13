---
title: Etsy Integration Design
---

Design for adding **Etsy** as a Loxep marketplace integration (epic `loxep-g4t`), written per the [`add-integration-provider`](../../development/implementation-contract/) task path. It stands in the same relationship to the Etsy adapter that [Commerce Schema Design](../commerce-schema-design/) stands in to Phase 3's tables: a concrete build target written before the package exists, scoped to one integration rather than a whole phase. Nothing here changes an already-implemented table or convention — Etsy orders land in the *existing* `orders`/`order_lines`/`order_fees` tables from Commerce Schema Design, unchanged.

**Implementation status: m1 (Etsy adapter + observation) is now implemented.** `packages/integrations/etsy` (config, error taxonomy, the SHARED-PER-APPLICATION rate budget, dev credentials, OAuth2+PKCE consent with the `<userId>.<accessToken>` bearer split, `money.ts`'s exact BigInt divisor conversion, the fetch-based adapter, and listing/shop observation mapping) exists, along with the `etsy_keyset` bundle in `packages/domain`, the `etsy_listing`/`etsy_shop` monitor target types registered in BOTH `@loxep/market`'s closed list and `packages/app/src/registry.ts`'s routing (learning from the `ebay_orders` split-registration gap rather than repeating it), the shared-installation adapter factory and poll executor in `@loxep/app`, and the catalog entry, guided consent dialog, and PKCE consent routes in `apps/web`. Fixtures and field-mapping provenance are recorded in each module's own doc comment; live verification is gated on the owner prerequisite below and has not happened. `orders.ts` (m2), `etsy_search`/non-owned-shop observation (m3, ToS-gated), and listing write (m5) remain **design only** — the sections below describing them are still the draft, not a record of what shipped. The eBay integration (`packages/integrations/ebay`) remains the load-bearing reference throughout — its error taxonomy, rate budget, keyset/consent split, and order-fact mapping are the pattern this document adapts, not reinvents.

## Marketplace landscape survey (verified August 2026)

Owner directive: *"Etsy is a likely desirable marketplace to add. Open to other common ones."* Before committing to Etsy-first, the flipping-relevant marketplace landscape was checked against current (not remembered) API reality — access policy and developer-approval processes are exactly the kind of fact that goes stale silently.

| Marketplace | API today | Auth | Individual-seller accessible? | Loxep legs possible | Verdict |
|---|---|---|---|---|---|
| **Etsy** | Open API v3 (REST/JSON), actively maintained | OAuth2 + **mandatory PKCE**, plus a per-app keystring | **Yes** — self-service Developer Portal registration, ~24–48h review | Observation (public auth, no consent needed), Orders (OAuth, own shop), Listing write (OAuth, own shop, later) | **Recommend — build first** |
| **Reverb** (musical gear, Etsy-owned) | Public REST/HAL+JSON API | **Personal Access Token**, self-service, instant, no approval queue | **Yes, trivially** — token minted in account settings with scoped grants (`read_listings`, `read_orders`, …) | Observation, Orders, Listing write — same three legs as Etsy, simpler auth | **Recommend — strong m3+ candidate**, follow-up survey/design pass |
| **Amazon** (SP-API) | Yes, current, well-documented | OAuth2 (LWA) + AWS SigV4-signed requests | Gated: requires a **Professional** selling plan ($39.99/mo) to register a developer app at all; full order data (buyer name/address) needs a separate **Restricted Data Token** approval, scoped to specific declared use-cases, reported as slow/opaque for small developers | Orders (once RDT approved), Listing write; **no general public-catalog observation leg** (SP-API is seller-account-scoped, not a market-browse API) | **Defer** — real API, high integration cost and an approval gate this owner does not currently clear |
| **Whatnot** | Seller API (GraphQL), broader in scope than most competitors (products, auctions, orders, shipments, livestreams) | Undisclosed (access-gated) | **No** — explicitly in Developer Preview; Whatnot states it is *"not accepting new applicants at this time"* | Unknown — moot while closed | **Defer** — watch for GA, do not implement |
| **Depop** | Selling API exists (`partnerapi.depop.com`) | API key | **No** — docs state the API is *"private and not available to the general public"*; access is by request/partnership | Would cover inventory + orders if granted | **Defer** |
| **Mercari** | Only "Mercari Shops" (a distinct B2C storefront product) has an API; the C2C resale app does not | Bearer token issued **per commercial contract** | **No** — contract-based, not self-serve, and it is not even the same product as the resale marketplace | None today for the marketplace Loxep would actually want | **Defer** |
| **Poshmark** | No official API; only unofficial reverse-engineered wrappers exist | — | No | None via any sanctioned path | **Manual-only** |
| **Facebook Marketplace** | No API for peer-to-peer Marketplace listings. Meta's Commerce Platform API is a restricted-alpha catalog/orders product for merchants selling through Meta's own commerce surfaces — a different product from Marketplace C2C | — | No, for an ordinary individual reseller | None via API | **Manual-only** — confirms the split with `loxep-dgf`, below |
| **Craigslist** | No general API; ToS bars scraping/automation. The only carve-out is a dealer-only bulk-posting feed for auto inventory | — | No | None | **Manual-only** |

**The manual/offline split is deliberate, not a gap.** `loxep-dgf` (Flipping lifecycle epic) already owns "manually logged local/offline listings (FBMP etc.)" as a first-class path — a listing an operator lists on Facebook Marketplace, Poshmark, or Craigslist is recorded the same way a garage-sale or Craigslist purchase is: entered by the operator, not synced from a provider. This survey confirms that split is the *correct* one for all three, not a placeholder pending an API that might appear — Facebook Marketplace and Craigslist have no realistic path to one at all; Poshmark's total absence of any developer program makes it the same. This document does not touch `loxep-dgf` or its manual-listing model.

**Ordering rationale.** Etsy is the only marketplace surveyed that is simultaneously (a) genuinely API-accessible to an individual seller today, self-service, with no partnership gate, and (b) a common venue for the kind of resale/handmade/vintage inventory this product's flipping workflow targets. Reverb is the strongest next candidate — its Personal Access Token model is *simpler* than Etsy's OAuth+PKCE flow and equally individual-accessible — but it is a narrower niche (musical instruments/gear) and is recommended as a **follow-up survey and design pass**, not folded into this Etsy-scoped document. Amazon and Whatnot have real APIs but a hard current access gate for this owner; they are parked, not ruled out permanently. Depop and Mercari have real *partner* APIs that are simply closed to individual sellers today.

Evidence (fetched/searched August 2026 against official sources where available):
[Etsy Open API v3 docs](https://developer.etsy.com/documentation/) · [Etsy Authentication](https://developer.etsy.com/documentation/essentials/authentication/) · [Etsy Rate Limits](https://developer.etsy.com/documentation/essentials/rate-limits/) · [Etsy Request Standards](https://developers.etsy.com/documentation/essentials/requests/) · [Etsy Payments Tutorial](https://developer.etsy.com/documentation/tutorials/payments/) · [Etsy sandbox/testing discussion](https://github.com/etsy/open-api/discussions/1619) · [Reverb Authentication](https://www.reverb-api.com/docs/authentication) · [Reverb OAuth Scopes](https://www.reverb-api.com/docs/oauth-scopes) · [SP-API registration overview](https://developer-docs.amazon/sp-api/docs/sp-api-registration-overview) · [SP-API Restricted Data Token](https://spapi.vip/en/use-other/authorization-with-the-restricted-data-token.html) · [Whatnot Seller API](https://developers.whatnot.com/) · [Depop Partner API docs](https://partnerapi.depop.com/api-docs/) · [Mercari Shops API docs](https://api.mercari-shops.com/docs/index.html) · [Meta Commerce Platform API overview](https://api2cart.com/api-technology/facebook-marketplace-api/) · [Craigslist bulk-posting scope](https://www.redwoodtechnologysolutions.com/all-you-need-to-know-about-craigslists-bulk-posting-api/).

## Owner-action prerequisites (do these before m1 can start)

These are **not** engineering tasks and cannot be done by an agent:

1. **Register an Etsy app** in the [Etsy Developer Portal](https://www.etsy.com/developers/register) as a **Personal App** (not yet Commercial Access — see below). Requires two-factor authentication enabled on the Etsy account first, and a captcha identity-verification step.
2. **Wait for approval.** Etsy reviews every new app before its API key is active — typically 24–48h, longer if the description is vague. This blocks *all* calls, including public/observation-only ones; there is no "unapproved but read-only" tier.
3. **Record the keystring and shared secret** from the approved app's "Your Apps" page — this is the credential pair `credentials.ts`/the `etsy_keyset` bundle need.
4. **Register a redirect URI** for the OAuth PKCE flow (must be HTTPS in production; Etsy allows an `http://127.0.0.1` loopback for local development) — the Etsy analogue of eBay's RuName step, but simpler: Etsy takes the literal callback URL, not an indirection name.
5. **Decide the "Commercial Access" question early.** Etsy's Personal App tier is scoped to "your own use, or tools other sellers may use at limited scale" — see below for why this matters for the `etsy_shop`/`etsy_search` monitor types and needs an owner call, not an engineering default.
6. **No sandbox exists.** Etsy removed its sandbox; every live-verification test in m1/m2 runs against a real shop (the owner's own, or a disposable test shop) with no isolated environment to fall back to. Budget for this when scheduling live-test work — see [Testing](#testing).

## Etsy API reality (Open API v3)

Verified against current Etsy developer documentation (fetched August 2026); Etsy's docs are somewhat inconsistent between `developer.etsy.com` and `developers.etsy.com` (both resolve to the same content as of this writing) and, unlike eBay's OpenAPI-typed client, there is no first-party maintained Node/TypeScript SDK equivalent to `ebay-api` — Etsy publishes an OpenAPI spec but Loxep will call the REST surface directly with `fetch`, the same choice already made for WooCommerce and Medusa (ADR-0009: a client is adopted only when it materially reduces protocol work, and Etsy's REST+OAuth2 surface does not clear that bar the way eBay's Trading/Buy split did).

### Auth: two tiers, mirroring eBay's app-token/user-token split

- **Public auth** — every request carries `x-api-key: <keystring>:<sharedSecret>`. This alone is enough for endpoints that read public marketplace data: active listing search, a shop's active listings, one listing's detail, shop profile. No OAuth, no shop-owner consent — the direct analogue of eBay's application-token Browse calls.
- **Private auth** — adds `Authorization: Bearer <etsyUserId>.<accessToken>`. Required for anything shop-management-scoped: receipts/orders, ledger entries, listing writes, draft/inactive listings. Etsy's bearer value is **not** just the token — it is `<numericUserId>.<accessToken>`, so the credential bundle must retain the Etsy user id alongside the token (eBay's bundle carries only the token pair; this is a genuine format divergence, not an oversight if omitted).

### OAuth2 PKCE flow — the load-bearing divergence from eBay

Etsy **requires PKCE on every authorization-code request** (RFC 7636, S256 challenge method); eBay's traditional-era `ebay-api` client flow does not use PKCE at all. Concretely:

```text
1. Loxep generates a high-entropy code_verifier (43-128 chars, [A-Za-z0-9._~-])
   and derives code_challenge = base64url(sha256(code_verifier)).
2. Authorize:  GET https://www.etsy.com/oauth/connect
                 ?response_type=code&client_id=<keystring>&redirect_uri=<uri>
                 &scope=<space-separated>&state=<csrf-binding>
                 &code_challenge=<challenge>&code_challenge_method=S256
3. Callback carries `code` + `state`; Loxep verifies `state` the same way
   `verifyConsentState` does for eBay (nonce cookie + hashed binding — that
   logic is provider-agnostic and can be reused as-is, only the URL differs).
4. Token exchange: POST https://api.etsy.com/v3/public/oauth/token
                 grant_type=authorization_code, client_id, code,
                 code_verifier (the ORIGINAL verifier, not the challenge),
                 redirect_uri.
5. Refresh: POST the same endpoint, grant_type=refresh_token,
                 client_id, refresh_token — no code_verifier needed here.
```

The `code_verifier` must be generated and **held across the request/callback boundary** (Etsy's flow has no client-secret-authenticated alternative for the token exchange the way some OAuth providers do) — it is short-lived, server-side state exactly like eBay's consent nonce, and should live alongside it in the same short-lived httpOnly-cookie mechanism, not be reinvented.

### Scopes

Sixteen scopes, read/write pairs per resource (`listings_r`/`listings_w`, `shops_r`/`shops_w`, `transactions_r`/`transactions_w`, …). Unlike eBay's traditional Trading calls (which use no OAuth scope at all) and Sell Fulfillment (which enforces exactly one narrow scope), **every** Etsy private-auth call is scope-checked. This maps cleanly onto the eBay `EbayConsentTier` pattern:

```text
tier         scopes                          unlocks
'shop'       shops_r, listings_r             read the connected shop's full listing set
                                              (including drafts/inactive — public auth
                                              only sees active listings)
'orders'     shops_r, listings_r,            + read receipts/transactions/ledger
             transactions_r
```

A `'listing_write'` tier (`+listings_w`) is deliberately **not** in m1/m2 scope — see [Staged milestones](#staged-milestones).

### Rate limits

Application-based, enforced **per API key** (not per connected shop) — the opposite of eBay's per-connection budget. Default new-app allocation is **10,000 queries/24h and 10 queries/second**, evaluated QPS-first-then-QPD, with a rolling (not calendar-day) window. A `429` response carries a `retry-after` header. Higher limits require emailing `developer@etsy.com` with a usage justification; there is no self-service tier upgrade.

**This changes the rate-budget shape versus eBay.** eBay's `createRateBudget` is deliberately per-connection (documented as an in-memory, per-process limitation to revisit for multi-worker). Etsy's limit is per-*application* (i.e., per Loxep installation, since one installation holds one Etsy app registration) and must be shared across every Etsy connection the installation has — a single shared budget instance keyed by the installation's keystring, not one per connection. The adapter's `rate-budget.ts` reuses eBay's token-bucket algorithm verbatim but the composition root (`packages/app/src/registry.ts`) must construct **one** Etsy rate budget and hand it to every Etsy connection's adapter, not one per connection the way `buildAppServices` does for eBay today. Flag this explicitly in the m1 bead — it is the one place a copy-paste of the eBay wiring pattern would silently be wrong.

### Money: integer + divisor, not a decimal string

Etsy's `Money` object is `{ amount: <integer>, divisor: <integer>, currency_code: <ISO 4217> }` — e.g. `{"amount": 2999, "divisor": 100, "currency_code": "USD"}` means $29.99. This is **structurally different** from eBay's `{value: "29.99", currency: "USD"}` decimal-string `Amount`, and from WooCommerce's decimal-string prices. `packages/integrations/etsy/src/money.ts` cannot reuse eBay's `money.ts` as-is; it needs its own `decimalFromEtsyMoney(money): string` that divides the integer amount by the divisor using exact decimal arithmetic (never floating-point division — `divisor` is occasionally not a power of ten for some legacy currencies, so this must go through a decimal library or manual scaled-integer math, not `amount / divisor` in JS `number`). The design's `numeric(20,6)` columns and "money is never JS `number` arithmetic" rule (implementation contract) apply with extra force here because the raw wire format *is* a number, unlike eBay/Woo where it already arrives as a string.

### Error shape

`{"error": "<message>"}` JSON body; no structured `errorCode` enum comparable to eBay's Browse `errorId` or WooCommerce's `code` field. Classification is therefore **HTTP-status-only**, following the pattern the skill recommends when a provider gives no richer envelope (closer to Medusa's error taxonomy than eBay's exception-class-based one):

```text
401                          → auth
403                          → auth   (Etsy uses 403 for scope/permission failures,
                                        not just 401 — confirm exact split live; both
                                        map to the same Loxep kind so this is safe
                                        either way)
404                          → not_found
429                          → rate_limited  (detail.retryAfterSeconds from the header)
other 4xx                   → invalid_request
5xx / network / unparseable → provider_unavailable
```

`EtsyAdapterError` mirrors `EbayAdapterError` exactly: `kind` + sanitized `detail` (the raw `{error: "..."}` message only — there is nothing else in the envelope that could carry credential material, unlike eBay's richer error body).

### ToS caution — flagged, not resolved, by this document

Historical Etsy API Terms of Use language (the current 2026 terms page returned HTTP 403 to automated fetch during this survey and must be re-read directly by a human before m1 ships) prohibited using the API "to determine information about Etsy's internal systems or to perform marketing analytics... without permission" and to "track or surveil Etsy members... in a manner that would otherwise require... permission from the affected members." eBay's Buy Browse API is unambiguously a public buyer-facing browse surface Loxep is licensed to poll; Etsy's public-auth search/shop-listing endpoints are less clearly scoped for third-party market-intelligence use against *other sellers'* shops specifically, versus the operator's own shop.

**This document does not resolve that question — it is an explicit owner/legal review item before `etsy_search` or observation of a non-owned shop ships**, and is called out again in [Staged milestones](#staged-milestones) as a milestone gate, not a default. Observing the operator's own connected shop (their own listings, their own orders) is uncontroversial under any reading and is exactly what m1/m2 build.

## Adapter design — `packages/integrations/etsy/src/`

Following the skill's stations, mirroring `packages/integrations/ebay/src/` file-for-file where the shape matches:

```text
index.ts        module doc naming the boundary + explicit re-exports
config.ts       zod-typed adapter config; rejects http: (except the documented
                 127.0.0.1 OAuth loopback exception for local dev); reads NO
                 process.env
errors.ts       EtsyAdapterError + EtsyErrorKind, HTTP-status classification
rate-budget.ts  token bucket — SHARED PER APPLICATION, not per connection (see
                 Rate limits above); reuses eBay's bucket algorithm
credentials.ts  dev/test env-file loader ONLY (~/.config/loxep/etsy-sandbox.env
                 — named for parity with eBay's file even though Etsy has no
                 sandbox; the file holds a dev keystring/secret + a manually
                 obtained user token for live-test convenience)
oauth.ts        PKCE consent URL + code/verifier exchange + refresh, tier
                 model ('shop' | 'orders'), consent-state CSRF binding
                 (reuses the eBay verifyConsentState logic, not the URL)
money.ts        decimalFromEtsyMoney(amount, divisor, currencyCode) → string;
                 no eBay money.ts reuse (see Money above)
adapter.ts       createEtsyAdapter(config) — public-auth calls (search, shop
                 listings, single listing); withUserToken(bundle) → private-
                 auth calls (receipts, transactions, own-shop listings incl.
                 drafts)
observation.ts   listing/shop snapshot → Loxep observation shape, aligned to
                 marketplace_items / marketplace_item_observations
orders.ts        receipts/transactions → EtsyOrderFact aligned to Commerce
                 Schema Design's orders/order_lines/order_fees/order_refunds
```

No connection.ts file — following eBay's actual precedent (which documents the persistence contract in module docs rather than a separate file):

```text
provider  'etsy'    channel 'etsy'    marketplace null   (Etsy has no
                                                           sub-marketplace
                                                           concept like
                                                           eBay's EBAY_US)
credential_type 'oauth_tokens'  (reused, same shape as eBay's — accessToken +
                 refreshToken; the Etsy-specific userId prefix for the Bearer
                 header is non-secret and belongs on connections.config, not
                 the encrypted payload — same split eBay uses for scopes)
bundle purpose 'oauth_tokens'    (reused — see Credential bundle below)
source_account_key 'etsy:<shopId>'
```

### Credential bundle — app keyset + OAuth tokens, split like eBay's

Two purposes, registered in `packages/domain/src/bundles.ts` alongside the existing six:

```ts
// One per Loxep installation — the approved Developer Portal app.
// Stored as the application secret `integration.etsy.keyset`, the Etsy
// analogue of `ebay_keyset`.
etsy_keyset: z.strictObject({
  keystring: z.string().min(1),
  sharedSecret: z.string().min(1),
}),

// One per connected Etsy shop. REUSES the existing `oauth_tokens` purpose —
// no new schema needed: Etsy's access/refresh token pair is structurally
// identical to eBay's. The Etsy user id that the Bearer header format
// requires (`<userId>.<accessToken>`) is NOT secret and is stored on
// `connections.config.etsyOAuth`, alongside the granted scopes — exactly the
// split `credentialWriteForBundle` already uses for eBay's scopes.
```

`etsy_keyset` is new (Etsy's shared secret has no eBay equivalent to reuse — eBay's `certId` plays a related role but the bundle shapes differ enough that a shared schema would be a false economy). `oauth_tokens` is reused unchanged.

### Rate budget — the one place NOT to copy eBay's wiring verbatim

Restated from above because it is the single highest-risk copy-paste error: eBay gets one `RateBudget` per connection (`buildAppServices` constructs it per-connection because eBay's limit genuinely is per app+user pair). Etsy's limit is per **application** — i.e., a Loxep installation, however many Etsy shops it connects, shares one 10-second/10,000-day budget. `packages/app/src/services.ts`'s Etsy equivalent must construct **one shared `RateBudget`** at composition-root scope and pass the same instance into every connection's adapter, or a two-shop install will silently believe it has 2x the actual quota and get rate-limited in ways that look like a bug in the budget rather than a wiring mistake.

## Monitor target types

Registered in `@loxep/market`'s `MONITOR_TARGET_TYPES` (`packages/market/src/monitors.ts`) and routed in `packages/app/src/registry.ts`'s router, following the `ebay_item | ebay_watchlist | ... → createEbayPollExecutor` pattern:

```text
etsy_listing   single listing observation (public auth) — analogue of ebay_item
etsy_shop      one shop's active listings (public auth) — analogue of ebay_seller.
               Own-shop use is the m1 default. Observing a NON-owned shop is
               mechanically identical but is the ToS-flagged case above —
               ship the capability but gate its use in the guided-form/docs
               copy behind an explicit "you are responsible for compliance
               with Etsy's API terms" acknowledgment, the way a raw feature
               flag would, rather than defaulting it on.
etsy_search    keyword/category search across all of Etsy (public auth) —
               analogue of ebay_search. Broadest market-surveillance surface
               and the least clearly ToS-safe; NOT in m1. See milestones.
etsy_orders    the connected shop's receipts (private auth, 'orders' tier) —
               analogue of ebay_orders / woo_orders. Reuses monitor_targets
               exactly as ebay_orders does (see the REGISTRATION CAVEAT in
               packages/app/src/registry.ts's module doc — ebay_orders is
               live but not yet in @loxep/market's closed list; etsy_orders
               should learn from that gap and land in BOTH the list and the
               config schema together, not split across two changes).
```

Etsy has **no equivalent of eBay's Trading watchlist** (a buyer's saved-items list) — Etsy's "favorites" are not exposed by Open API v3 at all as of this survey. There is therefore no `etsy_watchlist` target type; `etsy_listing`/`etsy_shop`/`etsy_search` cover the full observation surface Etsy's API makes available.

## Orders ingestion

Source: `GET /v3/application/shops/{shop_id}/receipts` (`transactions_r` scope) for the order-level record, plus the shop's ledger-entries endpoints for payment/fee detail (`GET .../payment-account/ledger-entries` and its `/payments` sub-resource). Etsy calls the order object a **receipt**; its line items are **transactions** (Etsy's `Transaction` object, not to be confused with Loxep's `order_lines`).

### Field mapping (design-derived; confirm exact field names against the live Reference during m2 the way eBay's `orders.ts` module doc documents its own provenance — Etsy's OpenAPI reference was not exhaustively walked field-by-field in this survey)

```text
externalOrderId       ← receipt_id
sourceAccountKey      ← etsy:<shop_id>
currency               ← the receipt's Money objects' currency_code
totals.total           ← grandtotal (Money)
totals.subtotal        ← subtotal (Money)
totals.shipping        ← total_shipping_cost (Money)
totals.tax              ← total_tax_cost (Money)
totals.discount        ← discount_amt (Money), if present
placedAt                ← created_timestamp
updatedAt               ← updated_timestamp   (sync watermark, same role as
                                                 eBay's lastModifiedDate)
paymentStatus            ← is_paid (boolean) → paid | unpaid  (Etsy reports a
                                                 boolean here, not a rich
                                                 enum like eBay's — the
                                                 design union still applies;
                                                 anything Etsy can't
                                                 distinguish floors to the
                                                 nearest safe value, same
                                                 discipline as eBay's
                                                 EBAY_UNKNOWN_STATUS_MAPPING)
fulfillmentStatus         ← is_shipped (boolean) → fulfilled | unfulfilled
buyerExternalId            ← buyer_user_id  (a numeric id, not a handle —
                                               confirm whether Etsy exposes a
                                               buyer display name/handle
                                               separately; if not,
                                               buyerDisplayName stays null
                                               rather than inventing one)
lineItems[]                 ← transactions[] on the receipt
  externalLineId             ← transaction_id
  quantity                     ← quantity
  lineSubtotal                  ← price (Money) × quantity
  externalItemId                 ← listing_id
```

### Fees and `fee_direction`

Etsy, unlike eBay's single aggregate `totalMarketplaceFee`, itemizes fees on the shop's **ledger** (transaction fee, listing fee, processing fee, Etsy Ads spend, offsite-ads fee, VAT-on-fees in some regions) rather than folding them all into the receipt object. This is closer to what a payout/statement API gives than what eBay's Sell Fulfillment gives — the ledger-entries endpoint is closer in shape to the *Finances API* territory eBay's `orders.ts` explicitly defers ("Itemization requires the Finances API... Phase 5 payout territory and deliberately out of scope"). Recommended treatment, matching that same discipline:

```text
fee_type                     fee_direction     provider_fee_code
marketplace_final_value      seller_charge     'transaction_fee'
marketplace_insertion        seller_charge     'listing_fee'
payment_processing           seller_charge     'processing_fee'
promoted_listing_ad          seller_charge     'etsy_ads_fee' | 'offsite_ads_fee'
other                        seller_charge     (VAT-on-fees, currency-conversion
                                                 fee, or anything unrecognized)
```

All Etsy seller-side fees observed so far are `seller_charge` — Etsy does not appear to expose a buyer-paid surcharge line comparable to eBay's `pricingSummary.fee` (unlike eBay, Etsy's buyer-facing checkout total is fully inside the order `grandtotal` with no separate buyer-fee container reported to the seller). If m2's live verification finds one, it gets `buyer_surcharge` the same way eBay's does; absent evidence, this document does not invent one. Every fee lacking a stable Etsy id gets a deterministic natural key exactly as `EBAY_MARKETPLACE_FEE_ID` does (`etsy:<ledger-entry-type>-<charged_at-iso>` is the recommended shape — confirm against a real ledger response, since Etsy may or may not expose a stable `entry_id`).

**Whether order-level fee ingestion belongs in m2 at all, or is a distinct `etsy_fees`/ledger-sync leg deferred to m3+, is an open question this document flags rather than answers** — see below.

## Testing

No sandbox (confirmed above) means the eBay pattern of `test/live-sandbox.test.ts` skipping cleanly without credentials still applies, but "live" here means the *operator's real shop*, not an isolated sandbox account. Fixtures + a `test/http.ts` stub cover every mapping without touching Etsy at all (the bulk of the suite, same as eBay/Woo/Medusa); the live leg is read-only in m1/m2 (observation + order *reads*), which is safe against a real shop — no listing-write tests exist until a `listing_write` milestone is scoped, and that milestone should design its own safe-test strategy (a disposable low-stakes draft listing, deleted after) rather than assume one.

## Staged milestones

```text
loxep-g4t.m1  Etsy adapter + observation
   packages/integrations/etsy (config, errors, rate-budget [shared-per-app],
   credentials, oauth PKCE, money, adapter, observation)
   etsy_keyset credential bundle registered in @loxep/domain
   Catalog entry ('etsy', category 'Marketplaces') + guided consent-style
   form + setup guidance (Developer Portal steps, 2FA/captcha prerequisite,
   24-48h approval wait, redirect-URI registration)
   etsy_listing + etsy_shop monitor target types, registered in BOTH
   @loxep/market's MONITOR_TARGET_TYPES/monitorTargetConfigSchemas and
   routed in packages/app/src/registry.ts (avoid the ebay_orders split-
   registration gap noted in that file's module doc)
   Docs guide page: apps/docs/.../guides/connecting-etsy.md, sidebar-registered
   OWNER PREREQUISITE (blocking, cannot be automated): Etsy Developer Portal
   app registration, 2FA + captcha verification, approval wait, redirect URI
   decision. Nothing in m1 can be live-tested until this is done.

loxep-g4t.m2  Etsy orders
   orders.ts: receipts/transactions → EtsyOrderFact, field-mapped per Etsy's
   live Reference (this document's mapping above is design-derived and
   UNVERIFIED against a live payload — treat every field name as a hypothesis
   to confirm, the same caveat eBay's orders.ts module doc carries for its
   own design-derived status enums)
   'orders' consent tier (shops_r + listings_r + transactions_r)
   etsy_orders monitor target type + poll executor route
   Fee mapping per the table above; ledger-entries itemization is a SEPARATE
   decision — land order-level totals first, decide itemized fee ingestion
   scope once a live receipt/ledger pair has actually been read
   commerce.sync-etsy-orders on-demand task, mirroring
   commerce.sync-ebay-orders in packages/app/src/registry.ts

loxep-g4t.m3  Etsy search + non-owned-shop observation  (FLAGGED — do not
   start until the ToS question above gets an explicit owner/legal answer)
   etsy_search monitor target type
   etsy_shop use against non-owned shops, with the compliance
   acknowledgment noted above
   Depends on m1's adapter; independent of m2

loxep-g4t.m4  Reverb marketplace survey + design  (separate epic follow-up,
   not a child of the Etsy adapter work — Reverb is a different provider
   package; this bead exists to make sure the "next candidate" recommendation
   from the landscape survey doesn't get lost)

loxep-g4t.m5  Etsy listing write  (NOT scoped by this document — needs its
   own design once Loxep has a Loxep-managed-listing model to write FROM;
   the same "Later — Phase 3 ingestion is read-only against providers" rule
   Commerce Schema Design already states applies here verbatim)
```

## Open questions

1. **Rate-limit sharing mechanics.** A single shared `RateBudget` per installation is recommended above, but where it lives in the composition root (a new `services.etsyRateBudget` alongside the existing per-connection `getEbayAdapterForConnection`) needs to be worked out in m1, not assumed — `buildAppServices`'s current per-connection-adapter-factory shape was built for eBay's per-connection semantics and may need a small refactor to express "one budget, many adapters" cleanly.
2. **ToS scope of `etsy_shop`/`etsy_search` against non-owned shops** — flagged as an m3 gate above, needs an actual human re-read of Etsy's current API Terms of Use (this survey's automated fetch of the terms page 403'd) before any code ships.
3. **Ledger/fee itemization depth** — order-level totals are clearly m2 scope; whether itemized per-fee-type ledger rows are also m2 or a separate `etsy_fees` sync leg is left to m2 implementation once a live receipt/ledger pair has been read (mirrors eBay's own "reviewer-pushback item" pattern in `orders.ts`, where the aggregate-vs-itemized fee shape was flagged rather than pre-decided).
4. **`is_paid`/`is_shipped` boolean granularity** — Etsy's receipt object may or may not expose finer payment/fulfillment sub-states elsewhere (a separate payments/ledger read); if it does, `paymentStatus`/`fulfillmentStatus` mapping should use the richer source rather than the coarse booleans assumed above. Confirm during m2's live field walk.
5. **Buyer display name** — confirm whether any Etsy endpoint exposes a buyer-facing handle (the way eBay's `buyer.username` does) separate from the numeric `buyer_user_id`, for the `buyerDisplayName` column.
