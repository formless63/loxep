---
title: Integrations Status
---

:::caution[Keep this current]
This is the one table every agent and the owner can trust for "what actually works today" across every provider Loxep has adapted, cataloged, wired, or surveyed. **Update this page whenever an integration changes tier** — a new adapter package, a new catalog entry, new runtime wiring (a poll executor, a push task, an on-demand action), or a live-verification result. A stale row here is worse than no row: the next agent to touch this repo is expected to trust it over memory or a design doc's aspirational language. Every cell below is sourced from the repository at HEAD, not from a design doc's stated intent — where a design doc and the code disagree, the code wins and the doc should be corrected (see the [Weave Audit](../weave-audit-2026-08/)'s recurring finding on that pattern).
:::

## What the columns mean

- **Adapter package** — does `packages/integrations/<name>` (or the equivalent) exist and build? A "yes" here means a source-verified boundary adapter with the standard error taxonomy exists; it says nothing about whether anything calls it.
- **Catalog-connectable** — does `apps/web/src/features/settings/integrations-catalog.ts` carry an entry for this provider, with a guided form on `/settings/connections`? A pasted credential is only possible when this is "yes."
- **Runtime-wired** — does anything in `packages/app` or `apps/web/src/server` actually construct the adapter and call it on a schedule or on demand? `poll` = a Graphile Worker poll executor on the shared scheduling model; `push` = an outbound write on a schedule; `on-demand` = a request-scoped server action a human triggers; `none` = the adapter exists but nothing in production code ever constructs it, so a saved credential does nothing visible.
- **Live-verified** — has this integration's mapping been exercised against a real, non-fixture upstream account/instance? "blocked" names the specific precondition (an owner-side credential, app approval, etc.) rather than just saying no.
- **Guide** — the `/guides/connecting-*` walkthrough, if one exists. A guide can exist ahead of the wiring it describes; where that is currently true, the guide itself carries a `:::note` flagging it — this table is the second, redundant place that fact lives, on purpose.
- **Tracking bead** — the open `bd` issue that owns the next step, if any. A blank cell means either nothing remains open (fully shipped) or nothing has been filed (surveyed only, no bead yet).

## Marketplace and commerce providers

| Provider | Adapter package | Catalog-connectable | Runtime-wired | Live-verified | Guide | Tracking bead |
|---|---|---|---|---|---|---|
| eBay | yes — `packages/integrations/ebay` | yes | poll (watchlist, search, seller, `ebay_orders`, `ebay_purchases`) | yes for watchlist/search/seller/notifications (live-verified 2026-08-12 against sandbox); orders mapping is fixture-verified, not yet live; purchases (`WonList`) cannot be sandbox-verified at all — production-account-only | [Connecting eBay](../../guides/connecting-ebay/) | `loxep-62v` (remaining dev-artifact/order-scope step) |
| WooCommerce | yes — `packages/integrations/woo` | yes | poll (`woo_orders`) | yes — exercised against a live production store with read-only credentials | [Connecting WooCommerce](../../guides/connecting-woocommerce/) | — |
| Medusa | yes — `packages/integrations/medusa` | yes | **none** — no `medusa_orders` monitor target type and no poll executor exist; the adapter has no runtime caller | no — blocked on both a live Medusa v2 instance and the persistence wiring above (adapter shipped fixtures-only, `loxep-xh9.4`) | [Connecting Medusa](../../guides/connecting-medusa/) | — *(no open bead currently tracks wiring order persistence for Medusa; flagged here rather than filed, since no existing bead/notes call for it — see this page's audit trail)* |
| Etsy | yes — `packages/integrations/etsy` | yes | poll (`etsy_listing`, `etsy_shop`) | blocked — owner must register and get approval for an Etsy Developer Portal app (~24–48h) before any live call, including public reads | [Connecting Etsy](../../guides/connecting-etsy/) | `loxep-g4t.2` (orders), `loxep-g4t.5` (search + non-owned-shop, ToS-gated), `loxep-g4t.4` (listing write) |
| Reverb | yes — `packages/integrations/reverb` | yes | poll (`reverb_listing`, `reverb_shop`) | not stated in shipped docs — Personal Access Token is self-service/instant, but no record of a live-account exercise was found | [Connecting Reverb](../../guides/connecting-reverb/) | — |

## Billing, infrastructure, and mail providers

| Provider | Adapter package | Catalog-connectable | Runtime-wired | Live-verified | Guide | Tracking bead |
|---|---|---|---|---|---|---|
| Invoice Ninja | yes — `packages/integrations/invoiceninja` | yes | on-demand (`pushDraftInvoice` server action) | no — write mapping not independently confirmed against a live push in this environment | [Connecting Invoice Ninja](../../guides/connecting-invoice-ninja/) | — |
| ntfy | n/a — transport lives in `@loxep/notifications`, not `packages/integrations` | yes | push (notification delivery) | yes — delivered end to end 2026-08-12 (real sandbox price-drop event, two delivered pushes) | (settings-level, no dedicated connecting guide) | — |
| Cloudflare | yes — `packages/integrations/cloudflare` | yes | poll/reconcile (`infrastructure_domain_reconcile` task) | blocked — no Cloudflare token exists in this environment yet; every live verification is owner-gated | [Connecting Cloudflare](../../guides/connecting-cloudflare/) | — |
| Purelymail | yes — `packages/integrations/purelymail` | yes | poll/reconcile (mail reconciler tasks) | partially — one live probe established the adapter's DNS-record-set foundation, but no Purelymail API key exists yet for full verification | [Connecting Purelymail](../../guides/connecting-purelymail/) | — |

## Fleet observability providers

| Provider | Adapter package | Catalog-connectable | Runtime-wired | Live-verified | Guide | Tracking bead |
|---|---|---|---|---|---|---|
| Tailscale | yes — `packages/integrations/tailscale` | yes | **none** — no scheduled probe or on-demand action ever constructs `createTailscaleAdapter`; a saved connection's health is "unknown (never succeeded)" forever | no | [Connecting Tailscale](../../guides/connecting-tailscale/) (now flagged) | `loxep-rf4` |
| Termix | yes — `packages/integrations/termix` | yes | **none**, same shape as Tailscale | no | [Connecting Termix](../../guides/connecting-termix/) (now flagged) | `loxep-rf4` |
| Gatus (read) | yes — `packages/integrations/gatus` | yes | **none** for the read direction — no scheduled probe or on-demand action calls `createGatusAdapter` | no | [Connecting Gatus](../../guides/connecting-gatus/) (now flagged) | `loxep-rf4` |
| Gatus (push) | n/a — outbound-only job, no inbound adapter needed | n/a (config lives on `/settings/application`) | push — `gatus-push.ts`'s scheduled task, registered in `registry.ts` | not stated (owner-gated on the operator's own Gatus YAML) | [Publishing health to Gatus](../../guides/gatus-health-push/) | — |
| Beszel | yes — `packages/integrations/beszel` (`loxep-9j6`, 48 tests) | **no** — no catalog entry, no connection form; a credential cannot be pasted at all | none | no — cannot connect | [Connecting Beszel](../../guides/connecting-beszel/) (describes the intended flow; now flagged as not-yet-available) | `loxep-rf4`, `loxep-ovj.5` |
| Dockhand | yes — `packages/integrations/dockhand` (`loxep-9j6`) | **no** — no catalog entry, no connection form | none — `planContainerHostOperations` has no non-test caller | no — cannot connect | [Connecting Dockhand](../../guides/connecting-dockhand/) (describes the intended flow; now flagged as not-yet-available) | `loxep-rf4` |
| Cockpit | no — tier 2, link + unauthenticated `GET /ping` probe only, by design | no — link-only, deliberately no catalog card | none | n/a (no adapter planned) | none yet | `loxep-ovj.6` |
| Netdata | no — no credential to store (bearer auth needs Netdata Cloud claiming); tier 2 + optional embed, by design | no — link-only, deliberately no catalog card | none | n/a | none yet | `loxep-ovj.6` |
| Uptime Kuma | no — upstream explicitly disclaims third-party API support; tier 1, by design | no — link-only, deliberately no catalog card | none | n/a | none yet | `loxep-ovj.6` |

## Surveyed only — no adapter, no code

These were researched for a companion-integration design but nothing has been built. "Tracking bead" is blank where no bead exists yet, which is the expected state for a surveyed-only entry, not a gap.

| Provider | Adapter package | Catalog-connectable | Runtime-wired | Live-verified | Guide | Tracking bead |
|---|---|---|---|---|---|---|
| BookStack | no | no | none | n/a | none | `loxep-juk` (P4, blocked on owner pick vs. Outline) |
| Vikunja | no | no | none | n/a | none | `loxep-1wx` (P4) |
| Outline | no | no | none | n/a | none | `loxep-p1j` (P4, qualified — BUSL but self-host use permitted; blocked on owner pick vs. BookStack) |
| AFFiNE | no — **overturned**: no content API exists to build against (metadata/permissions only; content is a Yjs CRDT with no stable external surface), and the self-hostable server requires an Enterprise-license seat | no | none | n/a | none | none — recommendation is to stop carrying it as a pending evaluation |
| Alexandrie | no — watch-tier: no published API endpoint documentation found despite MIT license and RustFS-native storage fit | no | none | n/a | none | none |
| Databasus | no — guidance-doc concept only | no | none | n/a | none | `loxep-7kt` (backup deployment guide; its evidence webhook rides `loxep-ovj.7`) |
| Backrest / restic | no — guidance-doc concept only | no | none | n/a | none | `loxep-7kt` |
| Pangolin | no — reserved task name only (`infrastructure.sync-proxy-resource`, `hosting_targets.proxy_connection_id`); no `@loxep/integration-pangolin` package exists | no | none | n/a | none | none currently open |

## Notes on cells that might look wrong but aren't

- **Beszel and Dockhand have shipped adapters with zero way to connect them.** This is the fleet design's own "inverted split" finding — the read/write code exists before the GUI does, the reverse of every other provider in this table. `loxep-rf4` closes it.
- **Tailscale, Termix, and Gatus (read) are the opposite inversion**: fully connectable, and the pasted credential does nothing, because nothing in production code ever constructs the adapter on a schedule or a validate action. Their `connecting-*.md` guides describe real, shipped read behavior that currently never executes — each now carries a `:::note` saying so.
- **Reverb is the only marketplace adapter with genuine runtime parity to eBay's core loop** (poll executor wired, notifications flow through the same bridge) despite being the newest and smallest of the three marketplace integrations.
- **Medusa is fully adapter-complete and fully unwired** — no persistence layer was ever built for it, unlike WooCommerce and eBay, which share the same Phase 3 commerce schema. This is not a regression; the schema didn't exist yet when the Medusa adapter shipped, and nothing has revisited it since.
- **ntfy has no adapter package** because it is not a marketplace/fleet-style provider with a request/response API to wrap — it is the notification transport itself, implemented directly in `@loxep/notifications`.

## See also

- [Weave Audit (2026-08)](../weave-audit-2026-08/) — the whole-system finding this page's fleet-provider rows are drawn from (finding 4).
- [Fleet Observability Design (Phase 8)](../../architecture/fleet-observability-design/) — the per-tool tier verdicts behind the fleet rows.
- [Etsy Integration Design](../../architecture/etsy-integration-design/) — the marketplace landscape survey behind the Etsy row.
- [Reverb Integration Design](../../architecture/reverb-integration-design/) — the design behind the Reverb row.
- [Knowledge & Tasks Integration Design](../../architecture/knowledge-tasks-integration-design/) — the survey behind the "surveyed only" table.
