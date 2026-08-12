---
name: add-integration-provider
description: Add a new external provider to Loxep — a marketplace, store platform, or notification service — end to end: the packages/integrations/<name> adapter (error taxonomy, per-connection rate budget, credential bundle, normalization), the integrations-catalog registry entry, the guided Add-account dialog with setup guidance, executor/task routing in @loxep/app, and the docs guide page. Use when asked to integrate, connect, or support a provider such as Shopify, Etsy, Amazon, Discord, or any new API.
---

ADR-0009 fixes the boundary: **provider SDK/API shapes stop at the integration package.** Use a
maintained client only when it materially reduces protocol work (eBay uses `ebay-api` v10; the
WooCommerce and Medusa adapters use native `fetch` with no client dependency); either way it is
wrapped, and no provider type appears in an exported signature. Scaffold the package itself with
the `add-domain-package` skill, then follow this.

Closest reference: `packages/integrations/medusa/` (newest, fixtures-verified) and
`packages/integrations/woo/` (live-verified).

## 1. The adapter package — `packages/integrations/<name>/src/`

```
index.ts        module doc naming the boundary + explicit re-exports
config.ts       zod-typed adapter config; rejects http:; reads NO process.env
errors.ts       the error taxonomy
rate-budget.ts  per-connection token bucket
credentials.ts  dev/test env-file loader ONLY (~/.config/loxep/<name>.env)
connection.ts   the connection contract (may be documented-not-implemented)
adapter.ts      the one object the rest of Loxep holds
orders.ts / products.ts / observation.ts / money.ts / probe.ts
```

**Error taxonomy.** A small stable `kind` plus a sanitized `detail` record, and a
`<Name>AdapterError`. Keep the vocabulary aligned with the existing three (`auth`,
`not_found`, `rate_limited`, `invalid_request`, …) so callers branch on one vocabulary — but
**duplicate it, never share it**: integration packages must not depend on each other, and a
shared `@loxep/integration-core` would make every provider's error surface a common upgrade
hazard. Document the provider's real error envelope in the module doc with the source you
verified it against, and classify primarily by HTTP status.

**Rate budget.** A token bucket every request acquires from before hitting the network:
`capacity`, `refillPerSecond`, FIFO reservation, `acquire`/`tryAcquire`/`stats`, and a
`rate_limited` error with `detail.source = "local_rate_budget"` when the wait would exceed
`maxWaitMs`. Document the limitation explicitly: it is in-memory and per-process, matching the
single-worker default.

**Credentials never leak.** Runtime credentials come from the connection model
(ADR-0016/ADR-0019), never from env vars. Zod issues report paths and **codes only**, never
received values. Nothing is printed, logged, embedded in fixtures, put in job payloads, or
echoed in an error. The env-file helper is dev/test only and returns `null` when absent so live
tests skip cleanly. Apply the same discipline to PII in normalized records: carry only the
fields a Loxep-owned fact needs, and keep buyer/contact data out of logs and error details.

**Credential bundle.** Register a typed bundle purpose in `packages/domain/src/bundles.ts`
alongside `oauth_tokens` / `woo_credentials` / `medusa_credentials` — secret material only. The
base URL / store URL is **non-secret connection config**, not part of the bundle. Record the
contract in `connection.ts` the way Woo and Medusa do:

```text
provider  'medusa'   channel 'medusa'   marketplace null
credential_type 'medusa_api'   bundle purpose 'medusa_credentials'
source_account_key 'medusa:<baseUrl>'
```

**Tests.** Fixtures + a `test/http.ts` stub for every mapping; a `test/live-*.test.ts` that
skips with a message naming the expected credential file when none exists. If you could not
verify against a live instance, say so in the module doc, cite the upstream source files you
read (with the branch and fetch date), and file the live-verification follow-up.

## 2. Catalog registry entry

`apps/web/src/features/settings/integrations-catalog.ts` is the single source for both
`/settings/integrations` (cards) and `/settings/connections` (grouped accounts). Add one
`IntegrationService`: `id`, `name`, `category`, a description of the **service, not the
roadmap**, a `manage` action, an `accounts` block (`provider`, `kind`, `form`, `addLabel`,
`formHint`, `blockedReason`), and a `status` resolver reading only metadata the settings server
functions already return. Widen `IntegrationServiceId` and `IntegrationAccountForm`.
`provider`/`kind` are system-supplied from this entry — an operator never types either, and no
surface offers a raw JSON config box.

## 3. Guided form + setup guidance

Add a `<Name>AccountForm` to
`apps/web/src/features/settings/components/connection-add-dialog.tsx`: `useAppForm` with a zod
`onSubmit` schema, `form.AppField` + `field.TextField`/`SelectField` inside a `FieldGroup`, a
mutation that invalidates `connectionsQuery` and toasts both outcomes. Secret fields are
**write-only** — submitted once, stored encrypted, never read back.

Above the fields, add a `<Name>SetupGuidance` built from
`apps/web/src/features/settings/components/setup-guidance.tsx` (`SetupGuidance`,
`GuidanceSteps`/`GuidanceStep`, `GuidanceNote`, `GuidanceCallout`, `GuidanceLink`,
`CopyableValue`): the exact click path in the provider's own admin, the permission scope to
choose, and the one fact that blocks first attempts (a key shown once, an environment
mismatch). Use `CopyableValue` for deployment-specific facts like a callback URL.

Server side, extend the connection-creating server function in
`apps/web/src/server/admin-functions.ts` (`createStoreConnection` is the pattern) — zod input,
`requireAdmin`, metadata-only return.

## 4. Executor / task routing in `@loxep/app`

Scheduling is shared: register a target type against `monitor_targets` and route it in the
composition root `packages/app/src/registry.ts`, never in `@loxep/market`.

```text
ebay_item | ebay_watchlist | ebay_search | ebay_seller → createEbayPollExecutor
woo_orders                                            → createWooOrderPollExecutor
```

Write the branch as a `packages/app/src/<name>.ts` executor that resolves the connection's
adapter, calls the owning domain service, records success, and returns adaptive facts. Do not
add a second scheduler and do not create one cron entry per monitored item — a small number of
dispatcher jobs claim due targets. Handlers are at-least-once: make them idempotent, minting
batch identity once and reusing it for every derived write. Each domain owns its own
`config.*` namespace; the composition root reads none of them.

## 5. Docs

Add `apps/docs/src/content/docs/guides/connecting-<name>.md` following
`connecting-medusa.md` — what you need, the steps in the provider's admin, then the steps in
Loxep — and register it in the Guides sidebar group in `apps/docs/astro.config.mjs`. Keep it in
step with the catalog entry and the dialog copy. Extend the Provider ingestion section of
`apps/docs/src/content/docs/development/implementation-contract.md` with the new boundary, and
add an ADR if a rule changes. Verify with `bun run docs:build` (it fails on broken links).

## Done when

- [ ] No provider SDK type crosses the package boundary; raw payloads are `Record<string, unknown>` behind named aliases.
- [ ] Taxonomy + rate budget local to the package; no cross-integration import.
- [ ] Credentials in an ADR-0019 bundle, non-secret config on the connection, nothing logged or echoed.
- [ ] Catalog entry + guided form + setup guidance; secrets write-only.
- [ ] Target type routed in `packages/app/src/registry.ts`; handler idempotent.
- [ ] Guide page added and sidebar-registered; `bun run docs:build`, `bun run typecheck`, package tests green.
