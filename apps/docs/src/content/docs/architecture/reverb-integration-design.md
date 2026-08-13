---
title: Reverb Integration Design
---

Design for adding **Reverb** (musical-gear marketplace, Etsy-owned) as a Loxep marketplace integration, the follow-up survey/design pass `loxep-g4t.3` promised when [Etsy Integration Design](../etsy-integration-design/)'s landscape survey recommended Reverb as the strongest next candidate. This is intentionally the lighter "house form" of that document — Reverb's own API surface is smaller and its auth model genuinely simpler, so this doc records verdicts and divergences rather than re-deriving every section Etsy's design already worked through. Where Reverb matches an already-decided Loxep pattern, this doc says so and moves on; it only expands where Reverb's reality forces a different call.

**Implementation status: m1 (Reverb adapter + observation) is now implemented.** `packages/integrations/reverb` (config, error taxonomy, a per-connection rate budget, dev credentials, `money.ts`'s pass-through decimal-string normalization, the fetch-based adapter, and listing observation mapping) exists, along with the `reverb_credentials` bundle in `packages/domain`, the `reverb_listing`/`reverb_shop` monitor target types registered in BOTH `@loxep/market`'s closed list and `packages/app/src/registry.ts`'s routing, the per-connection adapter factory and poll executor in `@loxep/app`, and the catalog entry, guided PAT dialog, and setup guidance in `apps/web`. Fixtures and field-mapping provenance are recorded in each module's own doc comment; live verification is gated on the owner minting a PAT (see [Owner steps](#owner-steps-no-approval-queue)) and has not happened. Orders (`orders.ts`, `reverb_orders`) remain **design only** — see [Staged milestones](#staged-milestones).

## Verdict, restated from the survey

Reverb's [Personal Access Token](https://www.reverb-api.com/docs/authentication) model is self-service and **instant**: an operator mints a token from their own Reverb account settings, picks scopes, and starts calling the API immediately — no developer-portal review queue, no approval wait, no partnership gate. This is strictly simpler than Etsy's OAuth2+PKCE consent flow (`loxep-g4t.1`) and than eBay's app-keyset-plus-per-user-consent split. The trade-off is scope: Reverb is a musical-instruments/gear niche, not a general marketplace, which is why it was staged as a follow-up rather than folded into the Etsy-first decision.

## Reverb API reality (verified August 2026)

Verified directly against Reverb's own developer documentation at `reverb-api.com` (the canonical docs host linked from `reverb.com/page/api`), fetched during this survey. Reverb, like Etsy and WooCommerce, has no first-party maintained Node/TypeScript SDK — this package calls the REST surface directly with `fetch`, the same ADR-0009 choice already made for Etsy/Woo/Medusa/Invoice Ninja, never `@loxep/integration-ebay`'s `ebay-api` pattern.

### Auth — a single bearer token, no split

Every request carries `Authorization: Bearer <personalAccessToken>` ([Authentication](https://www.reverb-api.com/docs/authentication)). Reverb Personal Access Tokens **do not expire** — there is no refresh flow, no client secret, no keyset half at all. Reverb's docs recommend granting the scopes `public`, `read_listings`, `write_listings`, `read_orders`, `write_orders` for an e-commerce integration; Loxep's m1 guidance narrows that to the read-only subset it actually needs (`public`, `read_listings`) since Loxep does not write listings or orders. Scopes are chosen by the OPERATOR when minting the token in Reverb's own UI — Loxep cannot request or negotiate them programmatically the way it negotiates an eBay/Etsy OAuth consent, so the credential bundle stores no scope list; the guide instructs the operator on what to grant, and an insufficiently-scoped token simply surfaces as `auth`-kind 403s on the calls that need more.

This collapses the entire consent-flow apparatus Etsy/eBay both need (`oauth.ts`, `tokens.ts`, PKCE, consent-state CSRF binding, a callback route) into nothing — there is no `reverb-oauth.ts` in this design at all.

### Versioning — a mandatory header, unlike eBay or Etsy

Every request must carry `Accept-Version: 3.0` ([HTTP Headers](https://www.reverb-api.com/docs/http-headers), confirmed again on [Find and Update Listings](https://www.reverb-api.com/docs/updating-your-listing)'s examples) alongside `Content-Type`/`Accept: application/hal+json` ([Getting Started](https://www.reverb-api.com/docs/getting-started)). Neither eBay nor Etsy has a request-level version header — this is a genuine Reverb-specific divergence, and the adapter bakes all three headers onto every call rather than exposing them as configuration (mirroring how `@loxep/integration-etsy` hard-codes its base URL).

### Base URL — fixed, like Etsy

`https://api.reverb.com/api` ([Find and Update Listings](https://www.reverb-api.com/docs/updating-your-listing), [Retrieve Orders](https://www.reverb-api.com/docs/retrieve-orders)). One hosted API, no per-deployment base URL, no sandbox host — `config.ts` hard-codes it the way `@loxep/integration-etsy/config.ts` does, not the way Woo/Medusa accept a `baseUrl`.

### Pagination — HAL `_links`, same convention as Etsy expects but structurally different

Reverb is a genuine HATEOAS/HAL API: "All collection-based api calls will return `_links` that include `next` and `prev` keys. These hrefs should be followed" ([Getting Started](https://www.reverb-api.com/docs/getting-started)). Unlike Etsy's flat `{count, results[]}` envelope, Reverb's collection responses carry the resource-named array directly (`{listings: [...]}`, `{orders: [...]}`) plus `_links`, and the orders endpoint additionally reports `total`/`current_page`/`total_pages` ([Retrieve Orders](https://www.reverb-api.com/docs/retrieve-orders)). The adapter follows `_links.next.href` verbatim rather than reconstructing query parameters itself, per Reverb's own instruction not to assume anything about URL structure.

### Money — VERIFIED decimal string, the simplest of the three marketplaces

**Confirmed, not assumed** (the task's explicit ask): a listing's `price` is `{amount: "5000.00", currency: "USD"}` — `amount` is already a decimal STRING ([Create Listings](https://www.reverb-api.com/docs/create-listings), quoting the literal example). This is structurally the same shape as eBay's `Amount` (`{value, currency}` decimal string) and simpler than Etsy's integer-plus-divisor `Money`, which needs exact `BigInt` division to un-scale. Order-context money objects are richer — `{amount, amount_cents, currency, symbol, display}` ([Retrieve Orders](https://www.reverb-api.com/docs/retrieve-orders), [Manage Refund Requests](https://www.reverb-api.com/docs/manage-refund-requests)) — but `amount` is still the authoritative decimal string in every case observed; `amount_cents` is a convenience integer, not a second source of truth, and `symbol`/`display` are presentation strings Loxep never parses as data. `packages/integrations/reverb/src/money.ts` therefore does the same job eBay's `money.ts` does: validate the string shape and currency code, and pass the string through verbatim — never `parseFloat`, never JS `number` arithmetic on it, per the implementation contract.

### Error shape

`{"message": "<human summary>", "errors": {"<field>": ["<message>", ...]}}` on failure ([Error Handling](https://www.reverb-api.com/docs/error-handling)). `errors` is optional and only appears for field-level validation failures; `message` is always present. No structured error-code enum comparable to eBay's `errorId` — classification is HTTP-status-first, the same discipline `@loxep/integration-etsy`/`-medusa` already use:

```text
400                          -> invalid_request  ("Parameters are missing or invalid")
401                          -> auth             ("log in and obtain a new authorization token")
403                          -> auth             (insufficient PAT scope; Reverb does not
                                                   document a distinct code for this, so it
                                                   collapses into 401's kind, matching Etsy's
                                                   own "confirm the exact split live" caveat)
404                          -> not_found
412                          -> invalid_request  (missing required parameter; Reverb's docs
                                                   single this status out by name rather than
                                                   folding it into plain 400)
429                          -> rate_limited     ("wait and try again")
other 4xx                    -> invalid_request
5xx / network / unparseable  -> provider_unavailable
```

Reverb's own docs explicitly say to branch on the response CLASS (2xx/4xx/5xx), not hard-code every status — this taxonomy still keeps the specific codes it does document (400/401/404/412/429) and floors everything else to the class-level default, so an undocumented-but-4xx status still classifies safely.

### Rate limits — undocumented numerically; per-application, not per-shop

Reverb states only that a large request volume "may issue a Rate Limit response... HTTP status code of 429" and that raising the limit is a support request to `integrations@reverb.com`, not a self-service tier ([Rate Limiting and Terms of Service](https://www.reverb-api.com/docs/rate-limiting-and-terms-of-service)). No numeric QPS/daily figure is published — a genuine gap versus Etsy's documented 10 QPS / 10,000-per-day. No `Retry-After` header is documented on the 429 either.

**Budget-scoping choice, and why this is the eBay pattern, not the Etsy pattern.** Etsy forces a SHARED per-application budget because one Loxep installation holds exactly one Etsy developer-portal app (one keystring), and every connected Etsy shop's calls count against that single app's quota. Reverb has no equivalent installation-wide credential at all: each connection's Personal Access Token is minted independently, from a *different Reverb account's* own settings page, and — per Reverb's own rate-limiting language ("a particular application") — the qualifying unit for Reverb's own enforcement is the calling credential, i.e. the token itself. Two Loxep connections holding two different Reverb accounts' PATs are, from Reverb's perspective, two unrelated callers with two unrelated quotas — there is no shared ceiling to protect them from over-drawing together. This is exactly eBay's/Woo's per-connection shape, not Etsy's shared one, so `packages/app/src/reverb.ts` builds one `RateBudget` per connection, matching `woo.ts`/`ebay.ts`, not `etsy.ts`. Because Reverb publishes no numeric limit to size the bucket against, the chosen defaults are a deliberately conservative, documented GUESS (capacity 5, refill 1/s — identical to Woo's own undocumented-limit default) rather than a fabricated "verified" number. UNLIKE Woo/eBay, there is no registered `integration.reverb.rate_budget` setting yet — the same gap `cloudflare.ts`/`purelymail.ts` already carry ("no registered-setting resolver is wired yet — a documented follow-up") — so today an operator can only raise it by passing an explicit override to `createReverbAdapterFactory`, not from a settings UI; wiring a resolver is a one-line follow-up once real 429 behavior is observed.

### ToS — attribution requirement, not a use-restriction like Etsy's

Reverb's stated requirement is narrower than Etsy's ambiguous "market surveillance" language: "If your integration consumes Reverb data, you are required to link back to the original Reverb listings, price guides, and other content whenever possible... failure to link back... may result in the termination of your API access" ([Rate Limiting and Terms of Service](https://www.reverb-api.com/docs/rate-limiting-and-terms-of-service)). This is an attribution obligation, satisfiable by Loxep's existing "canonical URL" pattern (every observed item already carries `canonicalUrl` back to the provider's own listing page, the same field eBay/Etsy/Woo observations already populate for the notification templates and listing-context cache) — it is not a use-case gate the way Etsy's un-re-read terms page is. The full terms agreement (`reverb.com/page/reverb-api-terms-of-use`) was not fetched in this survey; unlike Etsy's m1, this document does not flag it as a ship-blocking gate, because the one concrete rule found (attribution) is already satisfied by existing design, not because the full document was read and cleared. If a stricter clause turns up on a human re-read, treat it the same way Etsy's ToS caution is treated — as a gate on the specific capability it restricts, not this whole package.

### Owner steps (no approval queue)

Unlike Etsy's multi-step Developer Portal registration/approval, minting a Reverb PAT is a single owner action with no wait:

1. Sign in to the Reverb account whose activity Loxep should observe.
2. Open **Settings → API tokens** (or the equivalent path in Reverb's current account settings — Reverb's own docs describe the token as generated "in your account settings" without a fixed URL, so this step names the destination rather than a URL that may move).
3. Create a new Personal Access Token, granting at minimum the `public` and `read_listings` scopes (add `read_orders` ahead of m2 if orders sync is planned soon; skip the `write_*` scopes entirely — m1 is observation-only and never sends a write call).
4. Copy the token immediately — Reverb, like most PAT systems, shows it once. Paste it into Loxep's "Add Reverb account" dialog; Loxep stores it encrypted (`reverb_credentials`, ADR-0019) and never displays it again.

No 2FA/captcha prerequisite, no redirect-URI registration, no environment (sandbox/production) choice — none of those Etsy/eBay steps apply.

## Adapter design — `packages/integrations/reverb/src/`

Following the skill's stations, narrower than Etsy's file set because there is no OAuth apparatus:

```text
index.ts        module doc naming the boundary + explicit re-exports
config.ts       zod-typed adapter config (personalAccessToken + timeoutMs);
                 fixed base URL; reads NO process.env
errors.ts       ReverbAdapterError + ReverbErrorKind, HTTP-status classification
rate-budget.ts  token bucket — PER CONNECTION (see Rate limits above); the
                 algorithm is duplicated from eBay/Etsy/Woo's, not imported
credentials.ts  dev/test env-file loader ONLY (~/.config/loxep/reverb.env)
money.ts        validate {amount, currency} and pass the decimal STRING
                 through verbatim — no eBay-money reuse (ADR-0009 boundary),
                 same discipline, structurally simplest of the three
adapter.ts       createReverbAdapter(config) — single-token bearer auth for
                 every call (there is no separate public/private tier the
                 way Etsy has one): getListing (public data, any scope),
                 getMyListings (needs read_listings), getAccount (whoami)
observation.ts   listing snapshot -> Loxep observation shape, aligned to
                 marketplace_items / marketplace_item_observations
probe.ts         GET /api/my/account — the cheapest authenticated call this
                 adapter has a shape for
```

No `connection.ts` file, following eBay's/Etsy's precedent of documenting the persistence contract in module docs rather than a separate file:

```text
provider              'reverb'
channel                'reverb'
marketplace              'reverb'  (Reverb has no sub-marketplace concept;
                                     fixed constant fills the required column,
                                     exactly like ETSY_MARKETPLACE)
credential_type 'reverb_credentials'   (NEW bundle, {personalAccessToken})
bundle purpose 'reverb_credentials'    (ADR-0019)
source_account_key 'reverb:<connectionId>'   (see below — no account
                                                identifier is available
                                                without a live call, so this
                                                mirrors Purelymail's
                                                connection-id fallback, not
                                                Etsy's shop-id key)
```

### Credential bundle — one field, no non-secret half

`reverb_credentials: { personalAccessToken: string }`, registered in `packages/domain/src/bundles.ts` alongside the existing purposes. There is no `reverb_keyset` the way Etsy has `etsy_keyset` — Reverb has no application-level credential at all, so there is nothing to bundle it with. There is also no non-secret connection config comparable to Woo's `baseUrl` or Etsy's `shopExternalId`: Reverb's API has no per-deployment host to record, and m1's `reverb_shop` target observes the CONNECTED account's own listings implicitly (see [Monitor target types](#monitor-target-types)), so no shop identifier needs to be typed in at connect time either. This makes Reverb's connection config the emptiest of any provider in the catalog — closer to Purelymail's "the token IS the account" shape than to Woo's or Etsy's.

One consequence worth stating plainly, mirroring Purelymail's own documented one: because no account identifier is readable without spending a live `/api/my/account` call, `source_account_key` derives from the Loxep connection id rather than any Reverb-reported fact. Two Reverb connections therefore never collide on this key by construction (each connection id is already unique), but the key does not by itself prove two connections point at two different Reverb accounts the way `woocommerce:<siteUrl>` proves two different stores — an operator who accidentally connects the same Reverb account's PAT twice gets two Loxep connections with two different `source_account_key`s pointed at the same underlying seller. This is flagged, not solved, in [Open questions](#open-questions).

### Rate budget — PER CONNECTION, the eBay/Woo pattern

Restated from above: unlike Etsy, Reverb has no shared installation-wide credential to force pooling, so `packages/app/src/reverb.ts` builds one `RateBudget` per connection — a `Map<connectionId, RateBudget>`, exactly like `woo.ts`. Defaults (capacity 5, refill 1/s) are a documented conservative guess, not a verified Reverb number; `packages/app/src/services.ts` wires the same `resolveRateBudget` seam Woo/eBay use so an operator can raise it from a registered setting once real 429 behavior is observed, without a code change.

## Monitor target types

Registered in `@loxep/market`'s `MONITOR_TARGET_TYPES` (`packages/market/src/monitors.ts`) and routed in `packages/app/src/registry.ts`'s router in the SAME change — learning from the `ebay_orders` split-registration gap the way Etsy's `etsy_listing`/`etsy_shop` already did, rather than repeating it:

```text
reverb_listing   single listing observation (GET /api/listings/{id}) —
                 the Reverb analogue of ebay_item/etsy_listing. Reachable
                 with just the `public` scope.
reverb_shop      the CONNECTED account's own listings (GET
                 /api/my/listings?state=all, needs read_listings) — the
                 Reverb analogue of ebay_seller/etsy_shop, but NARROWER:
                 it always observes the token owner's own shop, never an
                 arbitrary third party's. This survey did not find a
                 documented public by-slug shop-listings endpoint the way
                 Etsy's public /shops/{id}/listings/active exists — Reverb's
                 public search (GET /api/listings) accepts query filtering
                 but a dedicated "this shop's public listings" resource was
                 not confirmed. Observing a NON-owned Reverb shop is
                 therefore explicitly OUT of m1's `reverb_shop`, unlike
                 Etsy's (which supports it mechanically, gated only by the
                 ToS caveat) — this is a real capability gap versus Etsy's
                 design, not a policy choice, and is recorded as an open
                 question below rather than assumed away.
```

There is no `reverb_search` (Reverb's `GET /api/listings` public search endpoint exists per the API's resource index but was not exercised in this survey, and is out of scope until a search-across-the-market milestone is explicitly scoped, mirroring Etsy's own `etsy_search` deferral) and no `reverb_watchlist` (no evidence Reverb's API exposes a buyer-side saved-items list, the same gap Etsy has).

```text
reverb_listing config: { externalItemId: string, adaptive?: {...} }
reverb_shop config:    { maxItems?: number, adaptive?: {...} }   // no identity
                        of its own — the shop IS the target's connection,
                        the same "no identity, only cursor/cap" shape
                        woo_orders/etsy_orders use for their own connection-
                        scoped targets
```

## Orders ingestion (design only — m2)

Source: `GET /api/my/orders/selling/all` (`read_orders` scope), with `updated_start_date`/`updated_end_date` query filtering for incremental sync, plus `/unpaid` and `/awaiting_shipment` convenience sub-resources for narrower polls ([Retrieve Orders](https://www.reverb-api.com/docs/retrieve-orders)). The response envelope is `{total, current_page, total_pages, orders: [...]}` — Reverb's own pagination facts, not the `_links.next` HAL convention the listings endpoints use, so the sync walk follows `current_page`/`total_pages` directly rather than link-following.

### Field mapping (design-derived, unverified against a live payload — confirm during m2's live-verification leg the same way Etsy's own `orders.ts` module doc flags its mapping as a hypothesis)

```text
externalOrderId     <- order_number (Reverb calls its order identifier an
                        "order number", not "id" — confirm the exact JSON
                        key live; `order_number` is the value shown in every
                        endpoint URL example, e.g. .../selling/[order_number])
sourceAccountKey     <- reverb:<connectionId>  (see the divergence noted
                        above under Credential bundle)
currency              <- the order's Money objects' currency
totals.total           <- total (Money)
totals.subtotal         <- amount_product (Money)
totals.shipping          <- shipping (Money)
totals.tax                 <- amount_tax (Money)
placedAt                    <- created_at (field name assumed by convention;
                                unconfirmed — Reverb's docs did not surface
                                an explicit order-creation timestamp field
                                in this survey)
paymentStatus                 <- state, mapped from Reverb's own richer
                                enum (unpaid, payment_pending, pending_review,
                                blocked, paid, shipped, picked_up, received,
                                refunded, cancelled) rather than a boolean —
                                Reverb's state enum is ALREADY closer to
                                Loxep's fulfillment-plus-payment vocabulary
                                than Etsy's is_paid/is_shipped booleans, so
                                m2 should design its own explicit mapping
                                table rather than reuse Etsy's boolean-floor
                                pattern verbatim
fulfillmentStatus              <- state (same source field; Reverb conflates
                                payment and fulfillment into one state
                                machine rather than exposing two independent
                                booleans — an m2 design decision, not
                                assumed here)
```

### Fees

`fully_refundable_amount` and a `selling_fee` field were observed in the [Manage Refund Requests](https://www.reverb-api.com/docs/manage-refund-requests) example, but no itemized fee-type breakdown (Reverb's equivalent of Etsy's ledger-entries) was found in this survey. Whether Reverb itemizes seller fees (payment processing, referral/final-value fee, shipping-label cost) on the order object itself or on a separate statement/payout endpoint is an open question for m2 to resolve against a live account, the same "flagged, not answered" discipline Etsy's own fee-itemization question carries.

## Testing

Fixtures + a `test/http.ts` fetch stub cover every mapping without touching Reverb at all (the bulk of the suite, matching every sibling package). A `test/live-*.test.ts` leg skips cleanly, naming `~/.config/loxep/reverb.env`, when no dev PAT is configured — the owner-prerequisite in this design is a single self-service step (see [Owner steps](#owner-steps-no-approval-queue)), so unlike Etsy's m1 the live leg should be realistic to exercise soon after this design lands, not blocked on a multi-day approval wait.

## Staged milestones

```text
loxep-g4t.3.m1  Reverb adapter + observation  (THIS DOCUMENT'S IMPLEMENTED SCOPE)
   packages/integrations/reverb (config, errors, rate-budget [per-connection],
   credentials, money, adapter, observation, probe)
   reverb_credentials bundle registered in @loxep/domain
   Catalog entry ('reverb', category 'Marketplaces') + guided PAT form +
   setup guidance (account-settings token path, scope recommendation,
   "shown once" callout)
   reverb_listing + reverb_shop monitor target types, registered in BOTH
   @loxep/market's MONITOR_TARGET_TYPES/monitorTargetConfigSchemas and
   routed in packages/app/src/registry.ts in the same change
   Docs guide page: apps/docs/.../guides/connecting-reverb.md, sidebar-registered
   OWNER STEP (self-service, no wait): mint a Personal Access Token with
   public + read_listings scopes in the Reverb account's own settings.

loxep-g4t.3.m2  Reverb orders  (NOT SCOPED — design-only section above)
   orders.ts: my/orders/selling -> ReverbOrderFact, field-mapped per Reverb's
   live Reference (this document's mapping is a design-derived HYPOTHESIS,
   same caveat as Etsy's own orders.ts)
   read_orders PAT scope (owner re-mints or edits the existing token's scopes)
   reverb_orders monitor target type + poll executor route
   Fee-itemization scope decided once a live order/refund payload has
   actually been read

loxep-g4t.3.m3  Reverb search / non-owned-shop observation  (NOT SCOPED —
   this survey did not confirm a public by-shop-slug listings endpoint;
   resolving that is the FIRST step of this milestone, before any target
   type is designed against it)
```

## Open questions

1. **Numeric rate limit.** Reverb documents no QPS/daily figure. The chosen per-connection defaults (capacity 5, refill 1/s) are a deliberate conservative guess pending real 429 evidence — revisit once the owner's live leg has run for a while.
2. **Non-owned-shop observation.** Whether Reverb's public `GET /api/listings` search accepts a shop-scoping filter that would let `reverb_shop` (or a new `reverb_search`) observe a shop the connection does not own is unresolved — this survey found the endpoint exists but did not confirm its filter parameters against a live call.
3. **Order field names.** `order_number`/`created_at`/the fee-itemization shape are all design-derived hypotheses (see [Orders ingestion](#orders-ingestion-design-only--m2)) pending m2's live field walk.
4. **`source_account_key` collision.** The connection-id-derived key (see [Credential bundle](#credential-bundle--one-field-no-non-secret-half)) does not detect two Loxep connections pointed at the same underlying Reverb account. Whether this needs a live `/api/my/account` read at connect time to derive a real account-scoped key is left open, matching Purelymail's own unresolved version of the same question.
5. **Full ToS text.** Only the attribution clause on the rate-limiting page was read; the full terms-of-use document (`reverb.com/page/reverb-api-terms-of-use`) was not fetched in this survey. Low risk given the one located rule is already satisfied by existing design, but a human re-read before a search/discovery milestone (m3) is still prudent, mirroring Etsy's own caution.
