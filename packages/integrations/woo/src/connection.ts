/**
 * Connection glue — DOCUMENTED, NOT IMPLEMENTED.
 *
 * This module deliberately contains no code that reads or writes the
 * connection model. It records the exact contract a later issue must
 * implement, so the decision is made once, in the open, next to the adapter
 * that constrains it — rather than improvised inside a server function.
 *
 * ## Why nothing is wired yet
 *
 * Phase 3 was pulled forward for the ADAPTER only. **Persistence is
 * deliberately excluded** pending the review of
 * `apps/docs/src/content/docs/architecture/commerce-schema-design.md`: none of
 * `orders`, `order_lines`, `order_fees`, `order_refunds`, `catalog_items`, or
 * `channel_listings` exists, and that document's own "Before implementing this
 * schema" list still has unresolved items (notably open question 6, which
 * decides WHICH PACKAGE owns the sync job). Writing a connection wiring path
 * now would either presuppose those answers or create a second one later.
 *
 * ## The contract
 *
 * ```text
 * provider           'woocommerce'          matches design `orders.provider`
 * channel            'woocommerce'          Loxep's selling-surface name
 * marketplace         null                  a Woo store is a single market
 * credential_type    'woo_api'              on the connection credential record
 * bundle purpose     'woo_credentials'      ADR-0019 encrypted bundle
 * source_account_key 'woocommerce:<siteUrl>'  see `wooSourceAccountKey()`
 * ```
 *
 * ### What is secret, and what is not
 *
 * The encrypted bundle is **exactly two fields**:
 *
 * ```ts
 * woo_credentials: { consumerKey: string; consumerSecret: string }
 * ```
 *
 * `baseUrl` is deliberately **NOT** in the bundle. It is non-secret connection
 * configuration and belongs in `connections.config` alongside the other
 * non-secret provider settings, for three reasons:
 *
 * 1. it must be readable to render the connection in the UI, to build a
 *    health check, and to compute `source_account_key` — none of which should
 *    require a decryption round-trip against the root key;
 * 2. ADR-0019 bundles exist so a credential cannot be half-configured. A key
 *    pair is atomically useful or useless; a URL is not part of that atom
 *    (the same key pair never becomes valid by changing the URL);
 * 3. it is not confidential. A shop's URL is public by construction.
 *
 * The contrast with `ebay_keyset` is intentional and worth stating: that
 * bundle DOES carry `environment` and `ruName` even though neither is secret,
 * because a sandbox keyset pointed at production fails in ways that look like
 * credential corruption. WooCommerce has no such coupling — a key pair is
 * issued by one store and is meaningless anywhere else, and pointing it at the
 * wrong URL produces a clean HTTP 401, not a confusing one.
 *
 * ### Ingestion identity (from the design doc)
 *
 * ```text
 * order upsert key    unique(connection_id, provider, external_order_id)
 * ```
 *
 * Connection-scoped on purpose: a WooCommerce order id is a per-store integer,
 * so order `1042` exists in every Woo installation and a global
 * `(provider, external_order_id)` key would collide the day a second store is
 * connected. The adapter additionally supplies `sourceAccountKey`
 * (`woocommerce:<siteUrl>`) on every {@link import("./orders.ts").WooOrderFact},
 * which is what makes the design's cross-connection duplicate DETECTION index
 * work. Design item 5 of "Before implementing this schema" — "confirm that
 * each provider adapter can compute `source_account_key` deterministically" —
 * is **confirmed for WooCommerce**: it derives from configuration alone, with
 * no API call and no provider-reported field.
 *
 * ### Watermark
 *
 * `WooOrderFact.updatedAt` (from `date_modified_gmt`) is the design's
 * `orders.provider_updated_at`, and the incremental fetch filter is
 * `modified_after` + `dates_are_gmt=true`. WordPress's date query is
 * EXCLUSIVE (`>`), so the stored cursor is replayed as-is; adding a
 * millisecond would skip orders modified within the same second.
 *
 * ### Retained source facts (ADR-0009 #3)
 *
 * `WooOrderFact.raw` is destined for `provider_objects` with
 * `object_type = 'woocommerce.order'` — a new text value, not new DDL, exactly
 * as the design's migration sketch anticipates. Note that a Woo order payload
 * contains buyer personal data (billing/shipping address, email, phone, IP,
 * user agent) that a marketplace observation payload does not; the design's
 * open question 8 flags retention policy for this object class specifically,
 * and it is still open.
 */
export {};
