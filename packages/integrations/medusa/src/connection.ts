/**
 * Connection glue — DOCUMENTED, NOT IMPLEMENTED.
 *
 * This module deliberately contains no code that reads or writes the
 * connection model, mirroring `packages/integrations/woo/src/connection.ts`.
 * It records the exact contract a later issue must implement, so the
 * decision is made once, in the open, next to the adapter that constrains
 * it — rather than improvised inside a server function.
 *
 * ## Why nothing is wired yet
 *
 * Same reason as WooCommerce: Phase 3 was pulled forward for the ADAPTER
 * only. **Persistence is deliberately excluded** pending the review of
 * `apps/docs/src/content/docs/architecture/commerce-schema-design.md`: none
 * of `orders`, `order_lines`, `order_refunds`, `catalog_items`, or
 * `channel_listings` exists, and that document's own "Before implementing
 * this schema" list still has unresolved items. This package's edit scope
 * (loxep-xh9.4) does not include editing that design document, so the
 * Medusa-specific findings that would normally extend its "Provider reality
 * findings" section (as the WooCommerce adapter's did) are recorded HERE
 * instead, for a future docs-authorized pass to fold in.
 *
 * ## The contract
 *
 * ```text
 * provider           'medusa'                matches design `orders.provider`
 * channel            'medusa'                Loxep's selling-surface name
 * marketplace         null                   a Medusa backend is a single market,
 *                                            same reasoning as WooCommerce
 * credential_type    'medusa_api'            on the connection credential record
 * bundle purpose     'medusa_credentials'    ADR-0019 encrypted bundle
 * source_account_key 'medusa:<baseUrl>'      see `medusaSourceAccountKey()`
 * ```
 *
 * ### What is secret, and what is not
 *
 * The encrypted bundle is **exactly one field** — simpler than WooCommerce's
 * two-field key pair, because Medusa's Admin API authenticates with a single
 * secret token rather than a key/secret pair:
 *
 * ```ts
 * medusa_credentials: { apiToken: string }
 * ```
 *
 * `baseUrl` is deliberately **NOT** in the bundle, for the identical three
 * reasons `woo_credentials` excludes it (see
 * `packages/integrations/woo/src/connection.ts`): it must stay readable
 * without a decryption round-trip (to render the connection, run a health
 * check, and compute `source_account_key`); ADR-0019 bundles exist so a
 * credential cannot be half-configured, and a URL is not part of that atom;
 * and it is not confidential — a backend's admin URL is not, on its own, a
 * secret.
 *
 * ### Ingestion identity (from the design doc)
 *
 * ```text
 * order upsert key    unique(connection_id, provider, external_order_id)
 * ```
 *
 * Connection-scoped for the same reason as WooCommerce and, per the design
 * doc's own words, "Medusa display IDs are per-store as well" — the design
 * explicitly anticipated this before either adapter existed. Note Medusa's
 * `external_order_id` should be the RAW `id` (`order_01…`), not `display_id`
 * — Medusa's own `id` is a store-scoped-but-globally-unique-looking ULID,
 * while `display_id` is the small sequential integer meant for humans and
 * is the design's `external_order_number` instead. The adapter additionally
 * supplies `sourceAccountKey` (`medusa:<baseUrl>`) on every
 * {@link import("./orders.ts").MedusaOrderFact}, confirming design item 5 of
 * "Before implementing this schema" for Medusa: it derives from
 * configuration alone, with no API call.
 *
 * ### Watermark
 *
 * `MedusaOrderFact.updatedAt` (from `updated_at`) is the design's
 * `orders.provider_updated_at`, and the incremental fetch filter this
 * adapter builds is `updated_at[$gte]=<cursor>`
 * (`buildMedusaOrdersQuery`/`FetchMedusaOrdersInput.updatedAfter` in
 * `orders.ts`). UNLIKE WooCommerce's confirmed-exclusive date filter, this
 * adapter could not confirm whether Medusa's `$gte` operator is inclusive or
 * exclusive against a live backend — it is used here as `$gte` (inclusive)
 * on the assumption that a re-included boundary row is a harmless duplicate
 * upsert, which is the safer failure direction when unconfirmed. Flagged for
 * the follow-up bead.
 *
 * ### Retained source facts (ADR-0009 #3)
 *
 * `MedusaOrderFact.raw` is destined for `provider_objects` with
 * `object_type = 'medusa.order'` — a new text value, not new DDL, exactly as
 * the design's migration sketch anticipates. A Medusa order payload MAY
 * carry buyer personal data (`email`, and `shipping_address`/
 * `billing_address` when those fields are requested) — the same open
 * question 8 (buyer data retention) the WooCommerce adapter's findings
 * raised applies here too.
 *
 * ## Medusa-specific provider-reality findings (fixtures/source-verified —
 * no live instance; the WooCommerce-adapter equivalent of this section lives
 * in commerce-schema-design.md's own "Provider reality findings" heading,
 * which this package's edit scope does not extend)
 *
 * - Medusa v2 stores and serializes money in MAJOR currency units (a plain
 *   JSON `number`, e.g. `10.5` for $10.50) — a real behavior change from v1,
 *   which used integer minor units. See `money.ts` for the full citation
 *   trail and the deliberate choice NOT to round to the currency's nominal
 *   decimal-digit count (a filed upstream precision defect makes rounding
 *   riskier than passing the value through exactly).
 * - Medusa reports order `subtotal` directly — unlike WooCommerce, no
 *   line-sum derivation is needed for the design's `subtotal_amount`.
 * - Medusa has NO fee concept at all, stronger than WooCommerce's finding
 *   (which at least had buyer-facing `fee_lines`). The design's `order_fees`
 *   has no Medusa source until a payment-provider integration exists.
 * - Medusa's Admin API order-detail type exposes no order-level
 *   `cancelled_at`, and no `paid_at` at all — see `orders.ts` for the
 *   documented gap and this adapter's derived-diagnostic `paidAt`.
 * - No per-fulfillment, per-line quantity breakdown was found — the
 *   design's `order_fulfillment_lines` has no confirmed Medusa source at the
 *   `fields` depth this research reached.
 * - Medusa's own list-endpoint DEFAULTS omit `payment_status`,
 *   `fulfillment_status`, `items`, `payment_collections`, and `fulfillments`
 *   even though the TypeScript response type declares the first two as
 *   non-optional — this adapter always overrides `fields` for orders (see
 *   `MEDUSA_DEFAULT_ORDER_FIELDS`), unlike the WooCommerce adapter, which
 *   never needed to.
 * - Medusa's own currency-precision table (extracted into
 *   `MEDUSA_CURRENCY_DECIMAL_DIGITS`) genuinely diverges from strict ISO
 *   4217 in places (e.g. `IQD` is listed with 0 decimal digits, not 3) —
 *   Loxep mirrors Medusa's OWN assumption, not an external standard, because
 *   that is the precision Medusa itself used when it produced the number.
 */
export {};
