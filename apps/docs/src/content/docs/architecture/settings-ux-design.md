---
title: Settings UX Overhaul Design
---

This document designs the schema-driven replacement for `/settings/application`'s raw-JSON editor (loxep-8ja, owner ask 2026-08-16: *"lots of places in the app are settings done with json or similar rather than standard looking easy fields/toggle/selections. worth a good pass to upgrade to a solid looking and feeling UI/UX flow."*).

**Status: DRAFT. Design work only.** No renderer, form, or migration code is authorized by this page — see [Decomposition](#5-decomposition-into-child-beads) for what ships it.

## 0. Ground truth: every registered setting today

`packages/domain/src/settings-defaults.ts` registers **19 settings** through `defineSetting()` (`registeredApplicationSettings`, the module's own diagnostics array). Every one carries a Zod schema, a `description` string, a `schemaVersion`, and a `defaultValue` — the registry already gives a generic renderer everything except **per-field** descriptions and machine-readable field kinds (see [section 2.4](#24-descriptions-and-per-field-metadata)).

Today, exactly **one** editing surface exists for all 19: `/settings/application`'s "Registered settings" table (`apps/web/src/features/settings/components/application-settings/index.tsx`) lists every key, and its row **Edit** action opens `SettingEditDialog` (`.../edit-dialog.tsx`) — a single `<Textarea>` bound to `z.string().trim().min(1)`, pretty-printed JSON in, raw JSON text out. Client validation is deliberately shallow ("is this JSON at all" — the component's own comment); `updateApplicationSetting` (`apps/web/src/server/admin-functions.ts`) is the *only* validator, because **the registry, and therefore every setting's Zod schema, lives server-side** and the browser cannot run it. That constraint, stated verbatim in that server function's own doc comment, is the reason the JSON textarea exists at all, and it is the constraint [section 2.1](#21-the-json-schema-dto--the-browser-never-runs-a-zod-schema) resolves.

Two settings already escaped the generic editor into hand-built forms because their real shape crosses a boundary the generic editor cannot express: `GatusPushCard` (a setting plus a write-only secret token) and `ProvisioningCard` (a composite with cross-field warning banners). One setting — `infrastructure.provider_write_policy` — is edited nowhere near `/settings/application` at all: it has a per-row `Select` on the **connections table** (`WritePolicyCell`), keyed by connection id, because the map's keys come from a list the settings page itself has no access to. These three are the house's only precedent for "when a setting outgrows the generic form," and the design below treats them as reference implementations, not problems to fix.

The one other place raw JSON leaks to an operator-facing surface is `apps/web/e2e/document-line-drag.spec.ts`, which flips `documents.parser_id` to `ocr_tesseract` by filling the same `Value (JSON) *` textarea. It is covered in [section 5](#5-decomposition-into-child-beads).

## 1. Inventory and classification

Class **(a)** = renderable today by a generic schema-driven form (see [section 2](#2-the-schema-driven-renderers-contract)). Class **(b)** = needs its own hand-built composite (a boundary the generic renderer cannot or should not cross). Class **(c)** = genuinely free-form / not an operator-typed value at all; stays behind the raw JSON editor.

| # | Key | Zod shape | Class | Why |
| --- | --- | --- | --- | --- |
| 1 | `monitors.defaults` | `{ intervalSeconds: number }` | a | single bounded int |
| 2 | `monitors.observation_caps` | `{ watchlistItemsPerPoll, searchItemsPerPoll: number }` | a | two bounded ints |
| 3 | `integration.ebay.rate_budget` | `{ capacity: number, refillPerSecond: number }` | a | rate-budget shape (×4, see below) |
| 4 | `integration.woo.rate_budget` | same | a | rate-budget shape |
| 5 | `integration.cloudflare.rate_budget` | same | a | rate-budget shape |
| 6 | `integration.gatus.rate_budget` | same | a | rate-budget shape |
| 7 | `commerce.order_payload_retention` | `{ mode: enum['redact','keep'], afterDays: number }` | a | enum + bounded int |
| 8 | `infrastructure.caa_policy` | `{ reviewed: boolean, issuers: string[], wildcardIssuers: string[], iodef: string\|null }` | a | bool + two tag lists + nullable string; the "not reviewed yet" warning is a banner slot on top of an otherwise generic form, not a reason to hand-build it (see [2.5](#25-conditional-bannersslots-inside-a-generic-form)) |
| 9 | `documents.media_limits` | `{ maxBytes: number, allowedMimeTypes: string[] }` | a | bounded int + tag list |
| 10 | `inventory.media_limits` | same shape | a | bounded int + tag list |
| 11 | `inventory.default_sale_mode` | `{ saleMode: enum[5] }` | a | single closed enum |
| 12 | `documents.parser_id` | `{ parserId: string }` | a | schema is a bare non-empty string (the registry for valid ids lives in `@loxep/documents`, which `@loxep/domain` must not depend on — see the setting's own doc). Renders as a `TextField` from the generic contract alone; a follow-up (flagged, not required) can special-case this ONE key to a `SelectField` sourced from a UI-side id list, the same way `apps/web` already owns the integrations catalog without `@loxep/domain` knowing about it |
| 13 | `auth.onboarding_oidc_prompt_dismissed` | `boolean` (bare, not an object) | a | the generic renderer's one non-object case — a lone `Switch`, no `Card` fields wrapper needed. Operator-facing only incidentally (it is normally flipped by dismissing the onboarding card, not by hand) |
| 14 | `infrastructure.gatus_push` | `{ enabled, baseUrl, endpointKey, mode }` | b | **existing hand-built** `GatusPushCard` — the form also carries a write-only secret token that is not part of this setting's schema at all (ADR-0019: secrets are never settings). A generic renderer must never be handed a schema-plus-secret composite; keep as-is, use as the reference for "setting + secret" composites |
| 15 | `auth.provisioning` | nested composite, 3 field groups | b | **existing hand-built** `ProvisioningCard` — cross-field derived warnings (`form.Subscribe`) that read live values from two different sub-objects at once. Keep as-is, use as the reference for "composite with cross-field warnings" |
| 16 | `infrastructure.provider_write_policy` | `Record<connectionId, tier-enum>` | b | **existing hand-built** row editor, but embedded on `/settings/connections`' table (`WritePolicyCell`), not on `/settings/application` — the map's keys are connection ids, a list only the connections page already has. `/settings/application`'s registered-settings row for this key should link out rather than open a JSON dialog (see [3](#3-groupingnavigation-redesign-for-settingsapplication)) |
| 17 | `integrations.enabled` | `Record<catalogId, boolean>` | b | same "keys come from a list the settings page doesn't have" reasoning as #16. `apps/web`'s own `integrations-catalog.ts` is that list (14+ entries) — a per-provider visibility `Switch` belongs on `/settings/integrations`' catalog grid, mirroring `WritePolicyCell`'s pattern exactly, not on `/settings/application` |
| 18 | `infrastructure.ip_aliases` | `Record<aliasName, { address, source: enum, hostname\|null, connectionId\|null, siteId\|null, previousAddress\|null, observedAt\|null, confirmedAt\|null, autoApply: boolean }>` | b | operator-CHOSEN keys (alias names), but each value is a rich composite with conditional fields (`hostname` only for `source: 'dns'`; `connectionId`/`siteId` only for `source: 'pangolin_site'`) and several system-written fields (`previousAddress`, `observedAt`, `confirmedAt`) an operator must never hand-edit. **SHIPPED (loxep-8ja.5):** a dedicated add/edit/retire list at `/infrastructure/aliases` (`infrastructure/components/ip-aliases-table/`, `ip-alias-dialog.tsx`), not a generic map row editor; the edit dialog shows the system-written fields in a read-only block, never as inputs. `/settings/application` links out to it under "Managed elsewhere" |
| 19 | `integration.tailscale.ignored_devices` | `Record<deviceNodeId, isoInstant>` | c | keys are opaque tailnet device ids and values are system-written timestamps; there is no operator-typed form here at all. The real UI is the fleet page's "Ignore" action, which writes single map entries directly. Leave behind the raw JSON editor unconditionally — building a form for it would be inventing an editing affordance nobody should use |

**Totals: 19 settings — 13 class (a), 5 class (b) (2 already shipped as reference forms, 1 already shipped as a foreign-table row editor, 2 net-new hand-built surfaces), 1 class (c).**

The four **rate-budget** settings (`ebay`/`woo`/`cloudflare`/`gatus`) share one literal shape (`{ capacity: number, refillPerSecond: number }`) and near-identical descriptions by design (each module doc says so explicitly — "duplicated as literals the way `ebayRateBudgetSetting`'s are"). This is the generic renderer's best evidence that one field-mapping engine, not per-setting bespoke code, is the correct shape for class (a): four settings, zero hand-written form code, once the mapping exists.

## 2. The schema-driven renderer's contract

### 2.1 The JSON Schema DTO — the browser never runs a Zod schema

`updateApplicationSetting`'s own comment is the load-bearing constraint: *"The browser cannot run a setting's Zod schema — the registry lives in `@loxep/domain`, server-side."* Every `@loxep/domain` value import that currently reaches `apps/web`'s **browser** bundle is type-only (`import type`); every value import is confined to `apps/web/src/server/*.ts` (server functions only — grep confirms this split holds today with zero exceptions). Shipping a setting's live `z.ZodType` object into the client bundle would break that boundary and risk dragging `@loxep/db`'s Drizzle/pg dependency chain (re-exported from the same `@loxep/domain` barrel) into the browser. So the renderer does not do that.

Instead: **Zod 4 (`4.4.3`, already pinned) ships `z.toJSONSchema()`.** The server function that lists settings converts each `SettingDefinition.schema` to a plain JSON Schema object — ordinary serializable data, no functions, no classes — and includes it in the DTO:

```ts
// apps/web/src/server/admin-functions.ts, fetchApplicationSettings — additive field
export interface RegisteredSettingDto {
  key: string;
  description: string;
  schemaVersion: number;
  isSet: boolean;
  value: JsonValue;
  updatedAt: string | null;
  jsonSchema: JsonValue; // NEW — z.toJSONSchema(definition.schema), computed server-side
}
```

The **client never re-declares a mirrored Zod schema**. The generic renderer walks `jsonSchema` (an object's `properties`, each property's `type`/`enum`/`minimum`/`maximum`/`items`/`description`) to choose a widget and its constraints. This is the "no duplication" answer the epic asks for: today `GatusPushCard` and `ProvisioningCard` each hand-write a parallel Zod object that must be kept in sync with the domain schema by eye — the generic renderer for class (a) settings has **zero** such shadow schema, because the shape ships as data instead of code.

**Validation authority does not move.** The server's `settings.set()` → `schema.safeParse()` remains the single source of truth exactly as it is today (`SettingsService.write`'s `parseIncoming`); the client's use of `jsonSchema` is for widget selection and UX-level constraints (`min`/`max` on a number input, `maxLength` on a tag), never a claim of full validation. A submission still round-trips to the server, and a rejection still returns a Zod issue list — the one change from today's dialog is that those issues now map to **per-field** errors (`issue.path` picks the field, e.g. `afterDays`) instead of one shared textarea error, because a class (a) setting is now rendered as N fields, not one JSON blob.

### 2.2 Zod shape → field mapping

| JSON Schema shape (from `z.toJSONSchema`) | Zod source | Widget |
| --- | --- | --- |
| `{ type: 'boolean' }` | `z.boolean()` | `field.SwitchField` |
| `{ type: 'string', enum: [...] }` | `z.enum([...])` | `field.SelectField` (options = the enum values, labelled via a small per-setting label map where the enum isn't already human-readable — see `PROVIDER_WRITE_POLICY_TIER_LABELS` for the existing pattern) |
| `{ type: 'integer' \| 'number', minimum?, maximum? }` | `z.number().int().min().max()` | `field.TextField` with `type='number'`, `min`/`max` from the schema, plus a **unit** suffix and description sourced per [2.4](#24-descriptions-and-per-field-metadata) — `TextField` already coerces `''→undefined` and digit strings to `Number(...)` at the DOM edge (`apps/web/src/components/forms/fields/text-field.tsx`), so no new number-coercion code is needed |
| `{ type: 'array', items: { type: 'string' } }` | `z.array(z.string())` | `field.TagsField` (the existing `mode='array'` pattern `ProvisioningCard` already uses for `magicLinkEmailDomains`/`adminValues`) |
| `{ type: 'string' }` (no enum) | `z.string()` | `field.TextField` |
| `['string', 'null']` / `anyOf` with a null branch | `z.string().nullable()` | `field.TextField`, empty input ⇒ submit `null` (the exact convention `GatusPushCard`'s `baseUrl`/`endpointKey` already use by hand) |
| `{ type: 'object', properties: {...} }` at the schema's own top level | `z.strictObject({...})` | the setting's Card body: one `FieldGroup`, one field per property, in schema-declaration order |
| `{ type: 'object', additionalProperties: {...} }` (a `z.record`) | `z.record(K, V)` | **not** handled generically on `/settings/application` — see [1](#1-inventory-and-classification) rows 16–18; a record-shaped setting is a signal to go find where its keys are already enumerated (a connections table, a catalog grid) and build a row editor there, following `WritePolicyCell` |
| bare (non-object) top-level schema, e.g. `z.boolean()` | — | render the one field directly on the Card, no `FieldGroup` wrapper (setting #13) |

This table is the renderer's entire generic surface. Nothing in class (a) ([section 1](#1-inventory-and-classification)) needs a shape this table doesn't cover.

### 2.3 Dirty-state and save semantics

**Save granularity is one registered setting per save — never a page-wide "save all," never per-keystroke autosave.** This is not a new rule invented for the renderer; it is the existing, unanimous precedent: `SettingsService.write()` persists and audits exactly one `application_settings` row per call (one `settings.create`/`settings.update` audit event), and both hand-built forms already save their whole composite in one submit (`GatusPushCard`'s one `Save`, `ProvisioningCard`'s one `Save`). A generic form for a class (a) setting is therefore: one Card, one `useAppForm`, one `form.SubmitButton` labelled `Save`, submitting every field on that setting together — identical granularity to today's dialog, just N typed fields instead of one JSON blob.

Dirty tracking is `useAppForm`'s own (`form.state.isDirty` / per-field `isTouched`); no new tracking is introduced. The Save button disables while `!isDirty` the same way any TanStack Form consumer would, matching the donor forms' existing convention (`/starter/forms`).

### 2.4 Descriptions and per-field metadata

The **setting-level** `description` already travels end to end today — `SettingDefinition.description` → `SettingListEntry.description` → `RegisteredSettingDto.description` → the current dialog's `DialogDescription`. Nothing new is needed there.

**Per-field** descriptions do not exist yet in any machine-readable form. `settings-defaults.ts`'s inline `/** ... */` JSDoc comments on individual object fields (e.g. `intervalSeconds`, `capacity`, `refillPerSecond`) are excellent prose but are erased at compile time — a runtime renderer cannot read them. The fix is **additive and avoids inventing a second, parallel metadata channel**: call Zod's own `.describe()` on each field, e.g.

```ts
schema: z.strictObject({
  intervalSeconds: z
    .number().int().min(5).max(86_400)
    .describe('Baseline cadence, in seconds, for newly created monitor targets'),
}),
```

`.describe()` is exactly what `z.toJSONSchema()` reads to populate each property's `description` in the JSON Schema DTO — so the same conversion that solves [2.1](#21-the-json-schema-dto--the-browser-never-runs-a-zod-schema) also solves per-field descriptions, with no separate registry field, no drift between two copies of the same sentence, and no schema-shape change (`.describe()` is purely additive metadata; it does not change what a value validates against). The existing JSDoc comments are the source text to lift from — most already say almost exactly what a field's `.describe()` should say (compare `intervalSeconds`'s JSDoc above to the description in the snippet). This lift is the "registry description/metadata additions" child bead ([section 5](#5-decomposition-into-child-beads)).

**Units** (seconds, bytes, "calls per second") are not a Zod-native concept and do not have a natural JSON-Schema slot. Rather than inventing a unit micro-DSL, put the unit in the `.describe()` string itself (as `intervalSeconds`'s example above already does — "in seconds") — consistent with how every existing hand-written field description in `GatusPushCard`/`ProvisioningCard` already communicates units in prose, not a separate field.

### 2.5 Conditional banners/slots inside a generic form

`infrastructure.caa_policy` (`reviewed: false` by design, until an operator has actually reviewed the issuer list) and, if a future class (a) setting needs it, similar "this isn't in effect yet" states are **not** a reason to hand-build a form. The generic renderer's Card accepts an optional `banner` render prop — a small, per-setting, hand-authored `<Alert>` that reads the form's live values via `form.Subscribe` and renders above the fields, exactly like `ProvisioningCard`'s two `form.Subscribe` blocks today. This keeps the *fields* generic while allowing a setting owner to add the one or two sentences of contextual warning their setting's own doc comment already argues for, without forking the whole form into class (b). `caaPolicySetting`'s banner: *"No CAA record is materialized until `reviewed` is on."* — one conditional `<Alert>`, wired to `jsonSchema`-driven fields underneath it.

## 3. Grouping/navigation redesign for `/settings/application`

Today's page is two flat, alphabetically-sorted `DataTable`s (`registered`, `raw`) plus one bolted-on `GatusPushCard`. The redesign replaces the single "Registered settings" table with **grouped Cards**, clustering the 13 class (a) settings (plus the 2 already-hand-built class (b) composites that belong on this page) by the domain they govern — mirroring how `settings-defaults.ts`'s own file already orders and comments its exports:

| Group heading | Settings |
| --- | --- |
| **Marketplace polling** | `monitors.defaults`, `monitors.observation_caps` |
| **Provider rate budgets** | `integration.ebay.rate_budget`, `integration.woo.rate_budget`, `integration.cloudflare.rate_budget`, `integration.gatus.rate_budget` — four identically-shaped cards in a row, the clearest visual proof the generic renderer is doing its job |
| **Uploads** | `documents.media_limits`, `inventory.media_limits` |
| **Documents & inventory** | `documents.parser_id`, `inventory.default_sale_mode` |
| **Commerce** | `commerce.order_payload_retention` |
| **Auth & provisioning** | `auth.provisioning` (link: *"Edit on Users"* → `/settings/users`, where `ProvisioningCard` already lives — see implementation note below), `auth.onboarding_oidc_prompt_dismissed` |
| **Infrastructure** | `infrastructure.caa_policy`, `infrastructure.gatus_push` (existing `GatusPushCard`, unchanged — its reference form already lives on this page, so it stays inline rather than moving) |
| **Managed elsewhere** | `infrastructure.provider_write_policy` (link: *"Edit per-connection on Connections"* → `/settings/connections`), `integrations.enabled` (link: *"Edit per-provider on Integrations"* → `/settings/integrations`), `infrastructure.ip_aliases` (link: *"Edit on IP aliases"* → `/infrastructure/aliases`, added loxep-8ja.5) — rendered as a plain link row, no form, so the operator is never shown a dead-end JSON editor for a setting that already has a real control elsewhere |

**Implementation note (loxep-8ja.3, shipped):** this table originally said `ProvisioningCard` "relocates into" the Auth & provisioning heading unchanged, mirroring `GatusPushCard`. Built instead as a **link** to `/settings/users`, where `ProvisioningCard` already lives (`users-table/index.tsx`, admin-gated at the route level) — the bead's own instruction ("link, don't duplicate") overrides this section's original wording, since duplicating the whole composite onto a second page is exactly the drift this epic exists to remove. `GatusPushCard` is unaffected: its reference form's home always was `/settings/application` itself, so "keep it where it lives" and "relocate it here" are the same instruction for that one card.

The **advanced/raw JSON escape hatch** does not disappear — it moves rather than vanishes. A collapsed `<Collapsible>` (or a separate "Advanced" tab) at the bottom of `/settings/application`, labelled plainly ("Raw settings (advanced)"), keeps today's exact `RawTable` + `SettingEditDialog` behavior for: (1) `integration.tailscale.ignored_devices` (class c, permanently), (2) any key present in `application_settings` that is **not** in the registry (the existing "raw stored rows" concept, unchanged — e.g. `@loxep/jobs`' `runtime.heartbeat`), and (3) as a documented fallback for any class (a)/(b) setting an operator wants to bulk-edit as JSON rather than through fields — the generic form is the front door, not the only door. This is the epic's own "advanced toggle" ask, applied literally: the JSON editor is demoted, not deleted. **Shipped (loxep-8ja.3):** the Advanced section additionally carried `infrastructure.ip_aliases` alongside `integration.tailscale.ignored_devices` as a temporary measure — it is class (b), not (c), but its own CRUD surface had not shipped yet, and leaving a registered setting reachable nowhere at all would have been a worse regression than a temporary raw-JSON fallback. **Shipped (loxep-8ja.5):** `infrastructure.ip_aliases` moved out of Advanced into "Managed elsewhere" (linking to its own dedicated CRUD surface at `/infrastructure/aliases`); the Advanced section now carries only `integration.tailscale.ignored_devices`, permanently (class c).

## 4. Frontend Standards addition

A binding "Settings forms" subsection was added to `apps/docs/src/content/docs/development/frontend-standards.md` under **Forms**, codifying: the field-mapping table ([2.2](#22-zod-shape--field-mapping)), "no client-side shadow Zod schema for a registered setting" ([2.1](#21-the-json-schema-dto--the-browser-never-runs-a-zod-schema)), one-setting-per-save ([2.3](#23-dirty-state-and-save-semantics)), and when a setting is exempt from the generic renderer (record-shaped settings keyed by a foreign id list; settings that carry a secret; class c).

## 5. Decomposition into child beads

Filed under `loxep-8ja`, dependency-ordered:

1. **`loxep-8ja.1` — Registry: per-field `.describe()` + JSON Schema DTO plumbing.** Add `.describe()` to every object field across all 13 class (a) `settings-defaults.ts` definitions (lifting from their existing JSDoc, per [2.4](#24-descriptions-and-per-field-metadata)); add `jsonSchema: JsonValue` to `RegisteredSettingDto` via `z.toJSONSchema(definition.schema)` in `fetchApplicationSettings`/`updateApplicationSetting`. No UI change. Unit-testable in `@loxep/domain` (every registered schema round-trips through `z.toJSONSchema` without throwing) and in `apps/web`'s server-function tests (DTO carries `jsonSchema`).
2. **`loxep-8ja.2` — The generic renderer + its unit tests.** New `apps/web/src/features/settings/components/application-settings/schema-form.tsx` (or similar): given a `RegisteredSettingDto`, render the [2.2](#22-zod-shape--field-mapping) mapping inside a `useAppForm` Card, submit through the existing `updateApplicationSetting`, map per-path server errors to per-field `errorMap`s. Tests cover every row of the field-mapping table plus the bare-boolean case (#13) and the nullable-string convention. Depends on `.1`.
3. **`loxep-8ja.3` — `/settings/application` rebuild on the renderer. SHIPPED.** Replaced the flat "Registered settings" `DataTable` with the grouped Cards from [section 3](#3-groupingnavigation-redesign-for-settingsapplication): one `SettingFormCard` per class (a) key (`application-settings/setting-form-card.tsx`), group headings (`application-settings/groups.ts`), the "managed elsewhere" link rows, and the collapsed advanced-JSON section for raw rows, `integration.tailscale.ignored_devices` (class c), and (at the time) `infrastructure.ip_aliases` (class b, pending `.5` — since moved to "managed elsewhere", see `.5` below). `GatusPushCard` relocates into its group heading unchanged, as planned; `ProvisioningCard` links from its heading to `/settings/users` instead — see this section's implementation note above. A non-admin visitor gets the same fields read-only (`SettingReadOnlyView`) rather than a dead editable form nobody may submit. Depends on `.2`.
4. **`loxep-8ja.4` — `integrations.enabled` row editor on `/settings/integrations`. SHIPPED.** Per-provider visibility `Switch` on the integrations catalog grid (`integration-card.tsx`'s `IntegrationEnabledToggle`, previously a Button, now a `Switch` matching this row-editor shape), mirroring `WritePolicyCell`'s pattern: one `useMutation` per row, admin-only. The server side (`setIntegrationEnabled`, `fetchIntegrationsEnabled`) and the filtering/visibility logic (`integrations-catalog.ts`) predate this bead (loxep-dgg); this bead's own scope was the control shape itself. Independent of `.1`–`.3` (does not touch the generic renderer).
5. **`loxep-8ja.5` — `infrastructure.ip_aliases` CRUD surface. SHIPPED.** A dedicated add/edit/retire list at `/infrastructure/aliases` (`infrastructure/components/ip-aliases-table/`, `ip-alias-dialog.tsx` — shipped originally with loxep-acj.5, ahead of this bead), covering the conditional `hostname` (source=`dns`) / `connectionId`+`siteId` (source=`pangolin_site`) fields and the read-only system-written fields (`previousAddress`, `observedAt`, `confirmedAt`), shown in the edit dialog's own read-only block, never as inputs. `/settings/application` no longer carries this key in Advanced — it links out under "Managed elsewhere" instead. Independent of `.1`–`.4`.
6. **`loxep-8ja.6` — e2e for the renderer's shape coverage.** `settings.spec.ts` now covers a numeric round-trip (`commerce.order_payload_retention`'s `afterDays`), the advanced raw-JSON fallback, and the integrations visibility toggle (loxep-8ja.3/.4's own gates) — remaining scope for this bead: coverage for the enum/nullable-string/tag-array rows the numeric test doesn't reach, plus fixing `document-line-drag.spec.ts`'s `enableTesseractOcr` helper, which the `.3` rebuild BROKE: it still opens `documents.parser_id` via a row + "Edit" button + dialog (`getByLabel('Parser id')` inside a `getByRole('dialog')`), a DOM shape that no longer exists — `documents.parser_id` now renders inline as its own Card under "Documents & inventory" (no row, no button, no dialog); the field is still labelled "Parser id", just reached directly on the page. Depends on `.3` and `.4`, both now shipped.

`.1` blocks `.2` blocks `.3`; `.4`, `.5`, and `.6` depend on the relevant surface(s) above but not on each other.
