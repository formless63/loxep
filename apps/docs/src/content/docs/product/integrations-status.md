---
title: Integrations Status
---

:::caution[Keep this current]
This is the status of record for provider support in the tracked repository. Update it whenever
an adapter, catalog entry, runtime path, or verification tier changes. Record only reproducible
capability evidence here; private installation topology, credentials, connection names, object
counts, and other operator-specific observations belong in local issue tracking.
:::

## What the columns mean

- **Adapter package** — a provider-boundary package exists and builds. This alone does not mean
  production code calls it.
- **Catalog-connectable** — the provider appears in the integration catalog with a guided
  connection flow.
- **Runtime-wired** — production code constructs and invokes the adapter. `poll` is a Graphile
  Worker executor, `push` is an outbound write, `on-demand` is a request-scoped action, and
  `probe` is a health/discovery read.
- **Verification** — `fixture` means deterministic adapter tests; `live read` means a bounded,
  non-destructive call reached a non-fixture upstream; `live write` means a write mapping was
  independently exercised. A package or catalog card is never evidence of live verification.
- **Tracking bead** — the local issue owning a remaining step. Beads is private and local, so
  these identifiers are useful to maintainers but are not public links.

## Marketplace and commerce providers

| Provider | Adapter package | Catalog-connectable | Runtime-wired | Verification | Guide | Tracking bead |
|---|---|---|---|---|---|---|
| eBay | yes — `packages/integrations/ebay` | yes | poll: watchlist, search, seller, `ebay_orders`, `ebay_purchases` | watchlist/search/seller/notifications have live sandbox-read evidence; order mapping is fixture-verified; purchases require production-account verification | [Connecting eBay](../../guides/connecting-ebay/) | `loxep-62v` |
| WooCommerce | yes — `packages/integrations/woo` | yes | poll: `woo_orders` | order mapping and polling have live read-only evidence | [Connecting WooCommerce](../../guides/connecting-woocommerce/) | — |
| Medusa | yes — `packages/integrations/medusa` | yes | poll: `medusa_orders` | order, refund, fulfillment, inclusive-boundary, and idempotent re-poll behavior have live disposable-instance evidence | [Connecting Medusa](../../guides/connecting-medusa/) | — |
| Etsy | yes — `packages/integrations/etsy` | yes | poll: `etsy_listing`, `etsy_shop` | fixture/source verified; live calls require an approved Developer Portal application | [Connecting Etsy](../../guides/connecting-etsy/) | `loxep-g4t.2`, `loxep-g4t.4`, `loxep-g4t.5` |
| Reverb | yes — `packages/integrations/reverb` | yes | poll: `reverb_listing`, `reverb_shop` | fixture/source verified; no durable live-verification record | [Connecting Reverb](../../guides/connecting-reverb/) | — |

## Billing, infrastructure, and mail providers

| Provider | Adapter package | Catalog-connectable | Runtime-wired | Verification | Guide | Tracking bead |
|---|---|---|---|---|---|---|
| Invoice Ninja | yes — `packages/integrations/invoiceninja` | yes | on-demand: `pushDraftInvoice` | auth-failure behavior has live evidence; draft-write mapping remains fixture/source verified | [Connecting Invoice Ninja](../../guides/connecting-invoice-ninja/) | — |
| ntfy | transport lives in `@loxep/notifications` | yes | push: notification delivery | end-to-end sandbox delivery has live evidence | settings-level | — |
| Cloudflare | yes — `packages/integrations/cloudflare` | yes, including the estate browser and DNS drill-in | poll/reconcile: `infrastructure_domain_reconcile` | zone and record reads have bounded live-read evidence; apply remains fixture verified | [Connecting Cloudflare](../../guides/connecting-cloudflare/) | `loxep-47o.2` |
| Purelymail | yes — `packages/integrations/purelymail` | yes | poll/reconcile: mail tasks | one bounded probe has live evidence; the complete adapter and write flow remain fixture/source verified | [Connecting Purelymail](../../guides/connecting-purelymail/) | — |
| Pangolin | yes — `packages/integrations/pangolin` | yes, including estate browsing and adopt/retire actions | probe, reconcile, policy-gated writes, alias fan-out, and provisioning templates | org/site/resource/rule/target reads have bounded live-read evidence; every write tier remains fixture verified | [Connecting Pangolin](../../guides/connecting-pangolin/) | `loxep-acj.9`, `loxep-pq2` |

## Fleet observability providers

| Provider | Adapter package | Catalog-connectable | Runtime-wired | Verification | Guide | Tracking bead |
|---|---|---|---|---|---|---|
| Tailscale | yes — `packages/integrations/tailscale` | yes | probe + device discovery, linking, per-resource health, estate browser | credential and discovery reads have bounded live evidence; persistence/linking paths also have deterministic coverage | [Connecting Tailscale](../../guides/connecting-tailscale/) | `loxep-50t`, `loxep-47o.6` |
| Termix | yes — `packages/integrations/termix` | yes | probe + host/session discovery, linking, estate browser | credential, host, session, and discovery reads have bounded live evidence; linking gates have deterministic coverage | [Connecting Termix](../../guides/connecting-termix/) | `loxep-wvm`, `loxep-47o.7` |
| Gatus (read) | yes — `packages/integrations/gatus` | yes | probe + endpoint discovery, linking, heartbeat quarantine, estate browser | open-posture health/config/status and discovery have live-read evidence; Basic/OIDC postures remain fixture verified | [Connecting Gatus](../../guides/connecting-gatus/) | `loxep-1au`, `loxep-47o.5` |
| Gatus (push) | outbound job, no adapter package | settings-level | push: aggregate or per-fact Loxep health | runtime and failure behavior are deterministic-test verified; no durable live-push record | [Publishing health to Gatus](../../guides/gatus-health-push/) | — |
| Beszel | yes — `packages/integrations/beszel` | yes | probe + system discovery, linking, per-resource health, estate browser | connection and system reads have bounded live evidence; per-system linking/witness behavior has deterministic coverage | [Connecting Beszel](../../guides/connecting-beszel/) | `loxep-47o.7` |
| Dockhand | yes — `packages/integrations/dockhand` | yes | probe + environment discovery, container/stack panels, reconciliation, estate browser | authentication and environment/container/stack reads have bounded live evidence; auto-link and write paths have deterministic coverage | [Connecting Dockhand](../../guides/connecting-dockhand/) | `loxep-47o.4` |

### Link-only tools removed from the app

Cockpit, Netdata, and Uptime Kuma were removed from the fleet-tool registry because Loxep does
not integrate with them. The product rule is simple: a tool without an actual integration is not
advertised inside the application. Their survey remains in the
[Fleet Observability Design](../../architecture/fleet-observability-design/).

## Surveyed only — no adapter or runtime code

| Provider | Status | Tracking bead |
|---|---|---|
| BookStack | surveyed; selection versus Outline is deferred | `loxep-juk` |
| Vikunja | surveyed only | `loxep-1wx` |
| Outline | surveyed; self-host use is permitted under its license, and selection versus BookStack is deferred | `loxep-p1j` |
| AFFiNE | rejected for this boundary: no stable external content API and self-host server access requires an Enterprise seat | — |
| Alexandrie | watch tier: no published API endpoint documentation was found | — |
| Databasus | guidance concept only; no adapter | `loxep-7kt` |
| Backrest / restic | guidance concept only; no adapter | `loxep-7kt` |

## Notes

- Fleet providers share connection-level health, discovery, `external_resources`, and
  `integration_health`, but intentionally differ in their linking rules. See the design document
  and provider tests before generalizing one provider's behavior to another.
- Reverb has runtime parity with eBay's listing-observation loop, but not its order-ingestion path.
- WooCommerce, eBay, and Medusa share the Commerce order-ingestion shape, and normalized orders
  render on `/commerce/orders`.
- ntfy has no adapter package because it is the notification transport rather than a polled
  provider boundary.

## See also

- [Weave Audit (2026-08)](../weave-audit-2026-08/)
- [Fleet Observability Design (Phase 8)](../../architecture/fleet-observability-design/)
- [Etsy Integration Design](../../architecture/etsy-integration-design/)
- [Reverb Integration Design](../../architecture/reverb-integration-design/)
- [Knowledge & Tasks Integration Design](../../architecture/knowledge-tasks-integration-design/)
