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
| Medusa | yes — `packages/integrations/medusa` | yes | poll (`medusa_orders`) | yes — exercised against a real, throwaway-provisioned Medusa 2.18.0 backend (2026-08-12); the live suite proves facts a fixture cannot: `total_amount` stays `original_total` and does not fall to the refund-reduced `total`, `refunded_amount` matches the summed refunds with nothing double-subtracting, subtotal plus shipping never exceeds the total, fee rows are zero, and a second poll re-delivers the inclusive-boundary order without creating a duplicate | [Connecting Medusa](../../guides/connecting-medusa/) | `loxep-xxz` |
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
| Tailscale | yes — `packages/integrations/tailscale` | yes | probe — `health.sweep` dispatches Tailscale connections to `createTailscaleAdapter` through the fleet-aware `connection` health-subject registry (`createFleetHealthSubjectRegistry`, `packages/app/src/fleet-health.ts`); the probe calls `adapter.probe()`, is the sole writer of `connections.last_success_at`/`last_error_at`/`last_error_code` for this provider, and returns `degraded` ahead of a recorded API-access-token expiry rather than waiting for the token to fail outright. No poll executor — there is nothing to sync, only a credential to prove. | no | [Connecting Tailscale](../../guides/connecting-tailscale/) | `loxep-50t` (per-device `resource_links` identity and the unmatched-device candidates panel — later slice, not yet built) |
| Termix | yes — `packages/integrations/termix` | yes | probe — same registry dispatches to `createTermixAdapter`'s `probe()` (`POST /users/login` + `GET /users/me`, Termix's only credential-proving call); host/session counts enrich `detail` best-effort and never affect `status`. No poll executor. | **yes** — 2026-08-14 against the owner's instance, with a local non-admin account. Observed `{ name, ip, lastSeenAt }` present and `online` **null**, confirming the design's warning that `/status` is the weakest-provenance signal in the fleet. Login limiter behaviour deliberately NOT exercised (that would mean failing logins against a live account) | [Connecting Termix](../../guides/connecting-termix/) | `loxep-wvm` (per-host `resource_links` identity — later slice, not yet built) |
| Gatus (read) | yes — `packages/integrations/gatus` | yes | probe — same registry dispatches to `createGatusAdapter`'s three-posture probe (`probeConfig()`, then `listEndpointStatuses()` in `open`/`basic` posture or `health()` in `oidc` posture), plus a heartbeat mirror that does one extra unauthenticated GET to detect a `gatusPushSetting.endpointKey` mismatch with the outward push (previously a silent no-op). No poll executor. | **yes** — 2026-08-14 against the owner's instance: unauthenticated health and config probes answer with the documented shapes, statuses read cleanly, one probe per `capabilities()` call. Only ONE posture was exercised, so the three-way `open`/`basic`/`oidc` inference stays copy-only | [Connecting Gatus](../../guides/connecting-gatus/) | `loxep-1au` (per-endpoint `resource_links` identity and the witness fleet panel — later slice, not yet built; no longer blocked, since `loxep-uhs`'s idempotency index shipped) |
| Gatus (push) | n/a — outbound-only job, no inbound adapter needed | n/a (config lives on `/settings/application`) | push — `gatus-push.ts`'s scheduled task, registered in `registry.ts` | not stated (owner-gated on the operator's own Gatus YAML) | [Publishing health to Gatus](../../guides/gatus-health-push/) | — |
| Beszel | yes — `packages/integrations/beszel` (`loxep-9j6`, 48 tests) | yes — catalog entry + guided "Beszel readonly user" form (`beszel-login`) | probe — `health.sweep` calls `adapter.health()` then `adapter.listSystems()` (the credential-proving, discovery-yielding read) via `createBeszelAdapterFactory`. No poll executor. | **yes** — 2026-08-14 against the owner's hub. All four fields the adapter called UNVERIFIED (`name`, `host`, `port`, `updated`) are actually sent, and it authenticated as an ordinary readonly user rather than a superuser. One hub is not a schema guarantee, so the defensive parsing stays | [Connecting Beszel](../../guides/connecting-beszel/) | `loxep-y64`, `loxep-ovj.5` (per-system `resource_links` identity and the witness fleet panel — later slice, not yet built) |
| Dockhand | yes — `packages/integrations/dockhand` (`loxep-9j6`) | yes — catalog entry + guided "Dockhand login" form (`dockhand-login`) | probe — `health.sweep` calls `adapter.probeSession()` then `adapter.listHosts()` via `createDockhandAdapterFactory`. The host-registration WRITE leg (`planContainerHostOperations`) still has no non-test caller — read-and-probe only shipped, not host-intent reconciliation. | **yes** — 2026-08-14, and it found a real bug: the session cookie is `dockhand_session`, not the transcribed `session`, so no live login could ever have worked while 62 stub tests passed. Environment, container AND stack schemas all now observed against a real instance (33 containers, 18 stacks), with presence checked across every returned row rather than the first | [Connecting Dockhand](../../guides/connecting-dockhand/) | `loxep-hb7` (host-registration reconciler wiring and per-host identity — later slice, not yet built) |

### Link-only tools, removed from the app (owner decision, 2026-08-14)

Cockpit, Netdata and Uptime Kuma were previously listed here as tier-1/tier-2 link-only tools. They are no longer represented in the application at all — their entries were removed from the fleet-tool registry and the tier-2 probe. The owner's rule: *"remove the link-only stuff from within the app. If it doesn't integrate we don't mention it."*

They remain surveyed in the [Fleet Observability Design](../../architecture/fleet-observability-design/)'s per-tool verdicts, because a recorded decision *not* to integrate is worth keeping. What changed is that the product no longer advertises a tool it cannot read. `loxep-ovj.6`, which scoped their registry entries and guides, is closed as won't-do.

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

- **The fleet inversion `loxep-rf4` was filed against is closed for connection-level health.** Beszel and Dockhand now have catalog entries and guided forms, and all five fleet providers (Beszel, Dockhand, Gatus, Tailscale, Termix) get a real connection health probe from `health.sweep` (`createFleetHealthSubjectRegistry`, `packages/app/src/fleet-health.ts`) that proves the credential and writes `connections.last_success_at`/`last_error_at` — a pasted fleet credential no longer sits behind a permanent `unknown (never succeeded)`. **What is still open:** per-resource discovery and linking — one row per Beszel system, per Dockhand host, per Gatus endpoint, per Tailscale device, per Termix host, joined to a `hosting_target` through `resource_links` and projected into `integration_health` as its own subject — is design-complete (`loxep-y64`/`loxep-hb7`/`loxep-1au`/`loxep-50t`/`loxep-wvm`) but unbuilt; so is Dockhand's host-registration write leg. The connection-level probe is real; the per-tool fleet panel is not.
- **Reverb is the only marketplace adapter with genuine runtime parity to eBay's core loop** (poll executor wired, notifications flow through the same bridge) despite being the newest and smallest of the three marketplace integrations.
- **Medusa's persistence leg has landed.** The adapter, the `@loxep/commerce` translator, the `medusa_orders` monitor target type, and the poll executor all exist and are wired — WooCommerce, eBay, and Medusa now share the same Phase 3 commerce ingestion shape. What remains open for Medusa is the same "later slice" every provider shares: no dedicated `/commerce/orders` surface exists yet for any provider (see the [Weave Audit](../weave-audit-2026-08/), finding 7).
- **ntfy has no adapter package** because it is not a marketplace/fleet-style provider with a request/response API to wrap — it is the notification transport itself, implemented directly in `@loxep/notifications`.

## See also

- [Weave Audit (2026-08)](../weave-audit-2026-08/) — the whole-system finding this page's fleet-provider rows are drawn from (finding 4).
- [Fleet Observability Design (Phase 8)](../../architecture/fleet-observability-design/) — the per-tool tier verdicts behind the fleet rows.
- [Etsy Integration Design](../../architecture/etsy-integration-design/) — the marketplace landscape survey behind the Etsy row.
- [Reverb Integration Design](../../architecture/reverb-integration-design/) — the design behind the Reverb row.
- [Knowledge & Tasks Integration Design](../../architecture/knowledge-tasks-integration-design/) — the survey behind the "surveyed only" table.
