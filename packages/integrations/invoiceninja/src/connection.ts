/**
 * Connection glue — DOCUMENTED, NOT IMPLEMENTED (adapter-only, matching
 * `packages/integrations/medusa/src/connection.ts` and
 * `packages/integrations/woo/src/connection.ts`).
 *
 * This module deliberately contains no code that reads or writes the
 * connection model. It records the exact contract the settings UI wiring in
 * this same issue (`apps/web/src/features/settings/**`) implements against,
 * so the decision is made once, in the open, next to the adapter that
 * constrains it.
 *
 * ## The contract
 *
 * ```text
 * provider           'invoiceninja'          connections.provider
 * kind               'billing_account'       connections.kind — new; no prior
 *                                             catalog entry is a billing
 *                                             companion rather than a
 *                                             marketplace/store account
 * credential_type    'invoiceninja_credentials'   on the connection credential record
 * bundle purpose     'invoiceninja_credentials'   ADR-0019 encrypted bundle
 * ```
 *
 * ### What is secret, and what is not
 *
 * The encrypted bundle is **exactly one field** — the same shape as
 * `medusa_credentials`, for the identical reason: Invoice Ninja's API
 * authenticates with a single company token, so there is no second part to
 * keep atomic with it.
 *
 * ```ts
 * invoiceninja_credentials: { apiToken: string }
 * ```
 *
 * `baseUrl` is deliberately **NOT** in the bundle, for the same three
 * reasons `medusa_credentials`/`woo_credentials` exclude their base URLs: it
 * must stay readable without a decryption round-trip (to render the
 * connection, run a health check, and compute
 * {@link import("./config.ts").invoiceNinjaSourceAccountKey}); ADR-0019
 * bundles exist so a credential cannot be half-configured, and a URL is not
 * part of that atom; and it is not confidential — a self-hosted instance's
 * admin URL is not, on its own, a secret.
 *
 * ### No commerce identity here — and that is the point
 *
 * Medusa's and WooCommerce's `connection.ts` also document a `channel`,
 * `marketplace`, and an `orders.source_account_key` ingestion identity,
 * because those adapters feed the Commerce Schema Design's `orders` table.
 * Invoice Ninja does not: per the Services & Billing Schema Design's "Owner
 * answers" section, Invoice Ninja is a Phase 6 billing companion, linked
 * through `external_resources`/`resource_links`
 * (`provider='invoiceninja'`), never through `orders`. There is deliberately
 * no `channel`/`marketplace` field in this contract, and Phase 6 "adds no
 * provider-specific column to any table" — `connections` itself gains no
 * columns for this provider either (the design's own words: "Invoice Ninja,
 * Vikunja, and Outline are ordinary connections with ordinary credentials").
 *
 * ### The push flow this connection will drive (not wired in this issue)
 *
 * ```text
 * counterparty  --(create/update client)------>  invoiceninja client
 *    resource_links purpose='billing_client'
 *
 * invoice (status=approved, numbering_source='external')
 *    --(createInvoice)-------------------------->  invoiceninja invoice (draft)
 *    <--(number, portalUrl)-----------------------
 *    resource_links purpose='delivery_document'
 *    --(markInvoiceSent)-------------------------->  invoiceninja invoice (sent)
 *    set invoices.status='issued', external_number, external_balance_amount
 * ```
 *
 * The design states this is **on-demand, server-function-driven**, not a
 * polled/scheduled sync target — so, unlike the eBay/WooCommerce/Medusa
 * adapters, this package registers NO `monitor_targets` target type and
 * `packages/app/src/registry.ts` gains no branch for it. The follow-up bead
 * for the actual push server function is filed against the parent epic
 * (`loxep-v5r`) — see this issue's closing notes.
 *
 * ### Idempotency, per the design
 *
 * "Has this invoice been pushed" is the existence of a `resource_links` row
 * with `purpose = 'delivery_document'`, not a boolean on `invoices` — the
 * design's own words, which also flag that `resource_links` needs the
 * `unique(external_resource_id, resource_type, resource_id, purpose)`
 * constraint added before this is safe to rely on. That constraint is
 * `packages/db` migration work, out of this package's scope.
 */
export {};
