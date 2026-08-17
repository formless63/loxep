---
title: UI Overhaul 2026 Design
description: Dashboard density, the mobile system, the living infrastructure topology, the estate map, and brand iconography — one coordinated pass (loxep-0g4).
---

**Status: IMPLEMENTED — all five waves shipped under epic `loxep-0g4`.** Owner directive 2026-08-17, six requirements verbatim in the epic bead: a mobile pass throughout; contemporary dashboard-density styling in place of SaaS-marketing spacing; living diagrams of connections between items with explanatory tooltips and filtering; a map view of server locations; logos and symbols where licensing allows; users who feel properly impressed. This document decided how, with reasons, so the implementation waves executed rather than re-decided — see each section's own "Implementation status" / wave-status note for what actually landed and the PROVISIONAL calls made along the way: W1 density/emphasis, W2 mobile mechanisms (§3), W3 topology (§4), W4 brand iconography (§5), W5 mobile QA + the topology icon stitch + this closeout (§3, §5).

## 0. The one-paragraph shape

Loxep's surfaces are structurally sound — one table stack, one form hook, semantic tokens, ten themes — and visually miscalibrated: hero-scale headings, `py-6`/`gap-6` cards, and two grey tokens doing all the talking. This pass recalibrates the **shared primitives once** (density lands everywhere without 56 hand edits), adds the **mobile mechanisms to the shared stack** (a responsive dialog wrapper, a mobile table discipline, a filter sheet) so phones get first-class treatment for the same low per-surface cost, and then spends the saved budget on the two things that genuinely impress: a **live infrastructure topology** — graph and map, two lenses on one page, assembled entirely from data Loxep already owns — and **brand iconography** keyed off the registries that already describe every provider. Four small dependency additions, **zero migrations**, zero new tables.

## 1. Ground truth: what the survey found

Measured against the working tree at `loxep-0g4`'s filing (2026-08-17):

- **The shell is already mobile-capable.** The shadcn sidebar renders as a `Sheet` below 768px (`useIsMobile`, the one breakpoint constant in the app); the header is sticky `h-14`; `PageContainer` is `p-4 md:px-6`. Breakpoint usage across features/components: 230 `sm:`, 70 `md:`, 33 `lg:`, 25 `xl:` — responsive flow exists; responsive *mechanisms* (tables, dialogs) do not.
- **Dialogs are the mobile gap.** 77 feature files use `Dialog`; 4 use `Sheet`; 0 use `Drawer` — though `drawer.tsx` (vaul) ships in `ui/`. A 720px-wide form dialog on a 390px phone is the single worst experience in the app today.
- **The table stack is closer than expected.** `DataTable` already renders inside a `ScrollArea` with horizontal scrollbar and has column pinning (`getCommonPinningStyles`, actions pinned `end` per frontend-standards). `TableHead h-10 px-2` / `TableCell p-2` are already dashboard-compact. The table body is not the density problem.
- **Cards and headings are the density problem.** `Card` is `gap-6 py-6` with `px-6` sections; page `Heading` is `text-3xl font-bold`; stat cards on `/infrastructure/overview` scale to `text-3xl`. That is the marketing scale the owner is naming.
- **The deadness diagnosis already exists.** Frontend-standards' semantic-token section records that settings/market surfaces use `text-muted-foreground` 44–51× with near-zero `primary`/`accent`/`chart-*` — "a surface built from only those tokens cannot respond to a theme switch." This design is that note's answer as much as the density answer.
- **The topology data already exists, joined and keyed.** `hosting_targets` (with `provider`, `region`, `fronted_by_target_id`, `proxy_connection_id`), `managed_domains` (`dns_connection_id`, `apex_target_id`), `proxy_resources` (`domain_id`, `hosting_target_id`, `subdomain`, `mode`), `host_addresses` (typed `wan`/`lan`/`tailnet`, migration 0029), `external_resources` + `resource_links` (companion tools per host), `integration_health` (status per subject), `connections`. Every edge the diagram needs is a foreign key that already exists. **The map needs no new data either**: `hosting_targets.provider` and `.region` have been columns since Phase 7.

## 2. Density and emphasis: the calibration

### The decision

**Rule D1 — recalibrate the shared primitives once; no density toggle.** The fix is a one-time recalibration of `Card`, `Heading`, and the page-level spacing conventions, not a user-facing "comfortable/compact" switch and not per-surface overrides. A toggle is machinery nobody asked for and a second axis every future surface must test against; per-surface overrides are how the drift got here. *(Rejected: `data-density` attribute system — revisit only if a real operator asks for larger type.)*

**Rule D2 — the scale.** Binding values, applied in the shared primitives so call sites inherit them:

| Primitive | Today | Becomes |
| --- | --- | --- |
| `Card` | `gap-6 py-6` | `gap-4 py-4` |
| `CardHeader` / `CardContent` / `CardFooter` | `px-6` | `px-4` |
| `CardHeader` bordered variant | `pb-6` | `pb-4` |
| Page `Heading` h1 | `text-3xl font-bold` | `text-xl font-semibold` |
| Stat/KPI value | `text-2xl` → `@[250px]:text-3xl` | `text-2xl tabular-nums`, no container upscale |
| Section/grid gaps on product surfaces | `gap-4` everywhere | `gap-3` within a section; `gap-4` between major sections |
| Page header margin (`PageContainer`) | `mb-4` | `mb-3` |

Table primitives (`h-10` headers, `p-2` cells) are **already correct and do not change.** The `/starter` donor workspace inherits the primitive recalibration and is otherwise untouched.

**Rule D3 — data typography.** Numeric data cells and stat values carry `tabular-nums`. Field-label/section-label text is `text-xs` or `text-sm text-muted-foreground` — never `text-base`. Prose paragraphs on product surfaces are capped at `text-sm`; if a surface needs a paragraph of explanation, it belongs in the `InfoButton`/infobar, not the page body (the app is "text-heavy" mostly because explanatory prose sits inline — move it behind the existing info affordance rather than deleting it).

**Rule D4 — the emphasis layer (extends the frontend-standards liveliness rule from advisory to audited).** Every product page must carry at least one emphasis element drawn from `--primary`, `--accent`, `--chart-*`, or the status trio (`--success`/`--warning`/`--destructive`): the primary metric, the active filter chip, the leading status dot, the selected row. Status is always a colored dot or tinted badge, never a plain word. Micro-visualizations (sparklines via the existing chart tokens) are permitted **only** over data the surface already fetched — an emphasis element never earns a new query.

**Rule D5 — empty states.** The `Empty` component (icon + one sentence + at most one action), never a bare muted sentence. An empty table keeps the existing DataTable empty row; `Empty` is for empty *sections and panels*.

## 3. The mobile system

**Rule M1 — one structural breakpoint.** 768px (`useIsMobile`, the existing constant) is the *only* breakpoint at which structure changes (dialog→drawer, toolbar→sheet, pane stacking). `sm:`/`lg:`/`xl:` remain free for pure layout flow (grid column counts, visibility of secondary text). No surface invents its own structural breakpoint.

**Rule M2 — tables: scroll, pin, and a filter sheet; never a card-list transform.** All 52+ tables stay `DataTable`. On mobile:

1. Horizontal scroll is the pattern (already shipped via `ScrollArea`). A card-list transform is rejected: it forks 52 renderers, loses sorting/selection, and hides the columnar comparisons a data app exists for.
2. **The first data column pins `start` on mobile** so the row's identity stays visible while scrolling; actions stay pinned `end`. This is ONE mechanism in the shared stack — `useDataTable` gains the behavior (pin the first non-select column when `useIsMobile()`), not 52 hand edits.
3. **The toolbar collapses to a filter sheet.** Below 768px, `DataTableToolbar` renders a single filter button (funnel icon + active-filter count badge) opening a `Sheet` containing the same filter controls; view-options hide on mobile. One change in `DataTableToolbar`, inherited everywhere.

**Rule M3 — dialogs become drawers via one wrapper.** A new `ResponsiveDialog` in `ui/` (same API surface as `Dialog`: Trigger/Content/Header/Title/Description/Footer) renders `Dialog` ≥768px and `Drawer` (vaul, already in `ui/`) below. Every *form* dialog on a product surface migrates to it (the 77-file sweep, mostly a 2-line import change per file). `AlertDialog` confirms stay as they are at every size — a small centered confirm is correct on a phone. `CommandDialog` (palette) stays a dialog.

**Rule M4 — navigation and touch.** The sidebar's existing mobile Sheet stands. The header gains a mobile-only search button that opens the command palette (Cmd+K has no phone equivalent today — the palette is currently unreachable there). Interactive row/menu triggers get a ≥40px hit area on mobile (padding, not layout change). The `InfoButton`/infobar must be reachable on mobile (verify; fix placement if the infobar assumes a wide viewport).

**Rule M5 — two-pane pages stack.** `/finance/expenses/new`'s evidence pane (and any future two-pane surface) stacks below the form under 768px with a sticky segmented toggle (Form / Evidence) so neither pane is lost off-screen. Estate pages stack sections naturally (already single-column); estate header chips wrap.

**Rule M6 — the QA story.** Playwright gains a second project `mobile-chromium` (iPhone-class viewport 390×844, touch enabled) running a **tagged subset** (`@mobile`), not the whole suite: sign-in, sidebar-sheet navigation, a connections-table scroll + row action, an expense create through the drawer, one estate open, one table filter through the sheet — roughly 6–8 specs. The desktop suite stays the completeness gate; the mobile project is the regression tripwire for the mechanisms above.

### Implementation status (Wave W2, `loxep-45k`)

Shipped: `ResponsiveDialog` (`components/ui/responsive-dialog.tsx`) and the 39-file form-dialog sweep (M3); `useDataTable`'s mobile first-column pin as a derived, non-fighting override (M2.2); `DataTableToolbar`'s mobile filter-sheet branch, desktop branch untouched (M2.3); the header's mobile search/palette button (M4); a mobile-only ≥40px invisible hit-area addition to the shared `Button` icon-family sizes plus the row-menu-trigger call sites that bypassed the size variant entirely (M4); `/finance/expenses/new`'s sticky Form/Evidence toggle, implemented as a pure `md:` CSS visibility split with both panes always mounted, not a `useIsMobile` remount (M5).

PROVISIONAL calls made during implementation:

- **The dialog sweep's exclusion list, beyond `AlertDialog`/`CommandDialog`:** `reveal-once-dialog.tsx` (ADR-0022's one-time secret reveal — no form fields, an explicit `onInteractOutside` guard, functionally a confirm) stayed a plain `Dialog`. Two `RadioGroup`-picker dialogs (`attach-discovered-resource-dialog.tsx`, `beszel-estate/attach-system-dialog.tsx`, `unmatched-devices-panel/link-device-dialog.tsx`) were migrated — a single-choice picker is a form control, not a confirm.
- **Row/menu touch targets used the shared `Button` size variants, not a 52-file sweep.** `icon`/`icon-sm`/`icon-xs` gained an invisible `::after` hit-box sized to exactly 40px on mobile only (`md:after:hidden`), the same technique `InfobarGroupAction` already used. The four cell-action files still writing raw `h-8 w-8 p-0` instead of `size='icon-sm'` were switched to the variant (visually identical) so they inherit it. Labeled `size='sm'` row buttons (Edit/Delete text buttons) were left alone — their touch width is already generous from the label, and bumping `sm` itself would be exactly the broad, app-wide change M4 asks this wave to avoid.
- **The InfoButton/infobar mobile-reachability check (M4) needed no code change.** `Infobar` already renders as a `Sheet` below 768px and `InfoButton` was never breakpoint-hidden — verified at a 390px viewport rather than assumed.
- **`ResponsiveDialogContent` adds exactly one class, `overflow-y-auto`, on top of vaul's existing per-direction `max-h-*`** — deliberately not a restructured Header/Body/Footer split, so the 39-file sweep stays the "2-line import change" the design promised instead of a per-file JSX rewrite.

### Implementation status (Wave W5, `loxep-pso`)

Shipped the QA story rule M6 asks for: `playwright.config.ts` gained a second project, `mobile-chromium`, running ONLY tests tagged `@mobile` (`grep: /@mobile/`); the existing `chromium` project gained `grepInvert: /@mobile/` so its own count is unaffected by the new file. `e2e/mobile.spec.ts` is the tagged subset itself — 7 specs (within M6's named 6–8 range): magic-link sign-in at 390px, sidebar-Sheet navigation to `/settings/connections`, the connections table's horizontal scroll + first-column pin + a measured 40px row-menu hit target, an expense recorded through the `ResponsiveDialog` drawer (asserted via `data-slot='drawer-content'`, not just `role='dialog'`, since a plain `Dialog` also exposes that role), a Gatus connection's estate page opening with no horizontal page overflow at 390px, the connections table's mobile filter Sheet actually narrowing a two-row fixture down to one, and `/infrastructure/topology` rendering its Graph/Map tabs and legend stamp at 390px. Full two-project run against a fresh scratch database: desktop stayed at 55 (54 + W3's topology spec, unchanged by this wave) and all 7 mobile specs passed — 62 tests total, one log, one run (`bunx playwright test`), per the harness's own single-worker/serial contract.

PROVISIONAL calls made during implementation:

- **`mobile-chromium` is built from `devices['Desktop Chrome']` (the Chromium engine), not `devices['iPhone 14']`** — spreading the iPhone preset would switch the *browser engine* to WebKit, which contradicts a project literally named "mobile-chromium," and its own viewport (390×664) is the browser-chrome-*subtracted* size, not the 390×844 rule M6 states. Instead only the specific emulation fields M6 names are set explicitly: `viewport: {width: 390, height: 844}`, `hasTouch: true`, `isMobile: true`, `deviceScaleFactor: 3`.
- **No card-list transform and no per-surface mobile CSS were needed for any of the 7 specs** — every mechanism M6 exists to regression-test (M1–M5) was already shipped generically in W2, so this wave's only product code touch was the topology stitch above, unrelated to M6 itself.
- **Fixture discipline:** every mobile spec builds its own uniquely-named fixture inside the test that needs it (no module-level `runId` shared across tests) — the trap `loxep-wtk` already named for this suite (a module-level id survives only the first test; a mid-run failure re-imports the file with a new id and strands every later test hunting for a fixture that was never created). Rows created through this suite's own UI (never a direct database write), matching every existing spec file's convention.
- **Locating a just-created row never assumes page one.** The mobile filter Sheet (`DataTableToolbar`'s M2.3 branch) is used to find fixtures on every table this file touches (connections, expenses) — this suite's shared scratch database accumulates fixtures across the WHOLE run, desktop included, so an unfiltered assumption about pagination order would have been a live flake risk, not a hypothetical one.

## 4. The living infrastructure topology

### Placement and jurisdiction

**Rule G1 — one page, one nav item, two lenses.** A new route `/infrastructure/topology` with a "Topology" nav item, presenting **Graph** and **Map** as tabs of the same page. `/infrastructure/overview` links to it; no preview panel is embedded there (anti-soup: the overview already carries the fleet signals band — a second rendering of the same facts would be the soup rule's first violation).

**Rule G2 — database reads only; the estate jurisdiction holds.** The topology page reads Loxep's own tables and registries — never a live provider call. Live truth stays the estate pages' jurisdiction (rules P5–P8 unmoved); the topology is the map of *what Loxep knows and intends*, stamped with Loxep's own clock ("as recorded, read just now"), and every node deep-links to the page that owns its liveness (fleet detail, estate page, domain page). This is what keeps the page fast, budget-free, and honest.

### The graph

**Rule G3 — nodes and edges come only from existing keys.** One member-readable server function (`fetchInfrastructureTopology`) assembles:

| Node kind | Source |
| --- | --- |
| Hosting target | `hosting_targets` (undecommissioned), with its `host_addresses` (kind-badged) and health in the tooltip |
| Managed domain | `managed_domains` |
| Proxy resource | `proxy_resources` (subdomain · mode) |
| Connection | `connections` in the infrastructure category (provider-iconed once §6 lands) |
| Companion tool | `external_resources` rows linked to hosting targets |

| Edge | Source key | Tooltip sentence (operator language, binding) |
| --- | --- | --- |
| fronted by | `hosting_targets.fronted_by_target_id` | "Traffic for *A* arrives through *B* first." |
| apex points at | `managed_domains.apex_target_id` | "*domain*'s apex record points at *target*." |
| routes to | `proxy_resources.hosting_target_id` + `.domain_id` | "*sub.domain* is proxied through Pangolin to *target*." |
| zone hosted at | `managed_domains.dns_connection_id` | "*domain*'s DNS zone lives at this *provider* connection." |
| proxied via | `hosting_targets.proxy_connection_id` | "*target* publishes its resources through this Pangolin connection." |
| watched by | `resource_links` on `hosting_target` | "*tool* is linked to *target* — Loxep records it as a companion, and probes its health." |
| observed via | `external_resources.connection_id` (linked AND observed tool nodes alike) | "Loxep's *provider* sweeps read *name* through this connection." |
| address match (INFERRED) | exact-string-equality intersection of a tool/observed resource's persisted addresses (tailscale `metadata.addresses`, dockhand `metadata.host`/`.publicIp`, beszel `metadata.host` — only values that parse as real IP literals) with a hosting target's `host_addresses.value` set | "*resource* reports *address*, which *target* also has — possibly the same machine. Link it to confirm." |

Every edge type has exactly one registered sentence; hovering any edge shows it with the real names substituted. An edge with no registered sentence may not render — that is the falsifiable form of "tooltips abound so they can understand." Every row above is Loxep-recorded fact except **address match**, the one INFERRED edge (`loxep-h4v`): rendered dotted/muted, never tinting health or implying a confirmed link, and never fuzzy, DNS-based, or subnet-aware — exact string equality only.

**Rule G4 — deterministic columnar layout, no layout dependency.** Nodes lay out in domain-shaped columns — connections | domains | proxy resources | targets | tools — with simple barycenter ordering to reduce crossings, computed in Loxep code. *(Rejected: force-directed layout — illegible hairballs for ops topology and non-deterministic between visits; dagre/elkjs — a dependency for a layout a loop can compute over five fixed ranks.)*

**Rule G5 — rendering is `@xyflow/react` 12, client-only, route-lazy.** MIT, actively maintained (12.11.3, published this month), the contemporary standard for interactive node graphs; pan/zoom/touch ship free, which is most of the mobile story. The chunk loads only on this route. Node cards and edges are token-themed (`bg-card`/`border`, status dots from the status trio, `--primary` for the focused path, `--border` for resting edges) so all ten themes and dark mode work without a graph-specific palette. React Flow's base stylesheet is imported once in the route chunk.

**Rule G6 — interaction.** Filter chips toggle node kinds in/out; a text filter matches names; clicking a node enters focus mode (neighbors full, non-neighbors dimmed to `--muted`); clicking through opens the owning page. A legend states node/edge counts and what was read ("assembled from Loxep's records · read just now"). Isolated nodes render isolated — an unconnected target is information, not a rendering failure.

**Rule G7 — connected means visible (AMENDED 2026-08-17, owner ruling, `loxep-2mr`).** The owner's correction to this section's original framing: Loxep is a layer that *streamlines* interaction with connected services, not an exclusive control surface — requiring an operator to link or declare a resource before it is even *visible* was overdoing it. So the topology renders the **observed layer** too: the persisted `external_resources` rows with **no** `resource_links` row — the tailnet devices, Dockhand environments, Beszel systems, Gatus endpoints, and Termix hosts a sweep has recorded but nobody claimed — as first-class nodes, visually distinct (dashed border, muted tint, an "observed" chip; `integration_health` tinting where a health row exists, which Beszel and Gatus already write for unlinked rows). They join the tools rank as isolated nodes with deep links to the provider UI, and to the existing link/adopt affordance as an *option*, never a prerequisite. A **"Show observed"** toggle controls the layer and **defaults ON** — visibility is the default; hiding is the choice. Rule G2 stands unmoved: this reads persisted observations only, never a live provider call — which makes Pangolin the recorded gap (it has no discovery writer; its undeclared resources are enumerable only on its estate page, and the legend says so rather than implying completeness). Tailscale's `integration.tailscale.ignored_devices` map is respected — ignored means hidden here too. P15 stands: no count badge anywhere on nav. Observed nodes are no longer edge-less islands either (`loxep-h4v`): every tool node, linked or observed, now carries an `observed_via` edge back to the connection whose sweep discovered it.

### Implementation status (`loxep-2mr`, 2026-08-17)

Shipped: the observed layer in `fetchInfrastructureTopology`/`buildInfrastructureTopology` — one `tool`-kind node per UNLINKED `external_resources` row across `@loxep/domain`'s `FLEET_TOOL_PANEL_ORDER` (tailscale, termix, beszel, dockhand, gatus), read through `listUnattachedByProvider` (the same accessor the attach picker and the tailnet candidates panel already use), tailscale-ignored rows excluded via `tailscaleIgnoredDevicesSetting`; the dashed-border/muted-tint/"Observed" chip node-card treatment plus a secondary "Open at provider" external link (the row's own `url`) alongside the existing internal `href`; a `BrandIcon` per provider on observed nodes; the "Show observed" filter-row toggle, component state, **default ON**; the legend's observed count and the Pangolin-gap sentence, both gated on the toggle.

PROVISIONAL calls made during implementation:

- **`observed: boolean` flag on the existing `tool` node kind, not a sixth `TopologyNodeKind`.** An observed resource is structurally the same thing a linked companion tool is (an `external_resources` row from one of the same five providers) minus the attachment; a new kind would force a `TOPOLOGY_RANK_BY_KIND`/`TOPOLOGY_NODE_KIND_LABELS`/`TOPOLOGY_NODE_KIND_CHART_TOKEN` entry for no semantic gain and would make the per-kind "Companion tool" filter chip and the dedicated "Show observed" toggle fight over the same nodes. The flag keeps `layout.ts`'s rank table, the per-kind legend swatches, and the MAP tab's `node.kind !== 'hosting_target'` filter completely untouched — zero risk surface for "does the new kind flow safely through shared types."
- **An observed node's primary `href` reuses `estateHref(provider, connectionId)`** — the identical internal deep link a linked `tool` node already carries — rather than threading through to `/infrastructure/fleet` (tailscale) or `/infrastructure/overview` (dockhand). Those two pages show an installation-wide, connection-agnostic candidate list with no way to deep-link one specific resource; the connection's own estate page IS resource-specific and already hosts that provider's link/adopt affordance (`devices-section.tsx` for tailscale, `attach-system-dialog.tsx` for beszel), so it satisfies rule G7's "existing link/adopt affordance" without inventing a second linking surface.
- **Ignored-tailscale filtering happens inside the pure `buildInfrastructureTopology`, not the handler** — `ignoredTailscaleExternalIds` is threaded through `BuildTopologyInput` as a plain `ReadonlySet<string>` so "ignored means hidden here too" is asserted with zero database, matching this module's own "extract the pure function, test it directly" precedent.
- **The tools rank, not a sixth rank.** G7's own text ("They join the tools rank as isolated nodes") already settles this — recorded here only because the originating bead's brief offered a sixth rank as an alternative.

**Rule MAP1 — no migration; location resolves from data Loxep already has.** `hosting_targets.provider` + `.region` resolve through a code-side `REGION_GEO_REGISTRY` (provider+region → lat/lon + display label) seeded with the common self-hosting providers (Hetzner, OVH, DigitalOcean, Vultr, Linode, AWS/GCP/Azure region codes, plus a `home`/`lan` convention pinning to a configurable "home" marker — no coordinates guessed). Targets whose provider/region resolve nowhere land in an **"Unplaced"** side list naming exactly the string to fix — the map never guesses, and unplaced is a stated state, not an empty map. *(Rejected: a lat/lon migration — a second copy of what `provider`+`region` already say, and a form asking operators for coordinates; IP geolocation — an external lookup and a privacy leak. Revisit an explicit coordinates column only when a real operator has a region the registry cannot carry — recorded as OQ2.)*

### Implementation status (Wave W3, `loxep-m4m`)

Shipped: `/infrastructure/topology` (route, one nav item "Topology", one link from `/infrastructure/overview`'s header actions); `fetchInfrastructureTopology` assembling every node/edge in G3's table from `hosting_targets`/`host_addresses`/`managed_domains`/`proxy_resources`/`connections`/`external_resources`/`resource_links`/`integration_health` only; the six-sentence registry as a total TypeScript mapped type (an unregistered edge kind fails the build, not just a review); the deterministic five-rank barycenter layout; the `@xyflow/react` graph lens (filter chips, text filter, focus mode, click-through, legend) behind a `React.lazy` + `ClientOnly` boundary inside the route's own auto-split chunk; the offline SVG map lens (`world-atlas` 110m + `topojson-client` + `d3-geo`) with region clustering and an honest Unplaced list.

PROVISIONAL calls made during implementation, recorded here per the contract's surface-the-conflict rule:

- **Projection: Natural Earth (`d3-geo`'s `geoNaturalEarth1`).** The design names "a Natural Earth projection" without picking the specific `d3-geo` function; `geoNaturalEarth1()` is the one actually named "Natural Earth" in the library.
- **`HOME_MARKER` ships `null` by default**, not a pinned coordinate. The design's "configurable 'home' marker" is read as "a code constant an operator edits" — the same shape every other `REGION_GEO_REGISTRY` row already has, since MAP1 rejects a coordinates column outright. A live, in-app settings field for this would need a registered setting in `packages/domain` (`defineSetting`), which is out of this wave's fence; flagged as a natural follow-up rather than built speculatively. Until an operator sets it, a `home`/`lan`-labeled target is honestly Unplaced, never a guessed coordinate (not even Null Island).
- **Map clustering keys by resolved `(lat, lon)`, not by the raw `(provider, region)` string pair** — two differently-typed strings that resolve to the same registry entry (e.g. `Hetzner`/`FSN1` vs `hetzner`/`fsn1`) correctly share one marker.
- **Edge tooltips render via a native SVG `<title>` on an invisible wide hit-path**, not a floating Radix tooltip synced to pointer position — simpler, fully accessible, and avoids a second positioning system inside the xyflow canvas.
- **"Worst linked health" for a map marker folds a hosting target's own `integration_health` row with every companion tool that `watched_by`-links to it**, taking the worst of the two — not the target's own status alone — since most targets today only have OBSERVED health through a linked tool (Beszel, Gatus, …), not a direct `hosting_target`-subject row.
- **Barycenter layout runs four fixed sweeps** (down, up, down, up over the five ranks) rather than iterating to a convergence threshold — deterministic, fast, and sufficient at the scale this page renders (tens of nodes, not thousands).

**Rule MAP2 — offline SVG, no tile servers, ever.** Natural Earth 110m country geometry via `world-atlas` (public-domain data, ISC package) + `topojson-client` + `d3-geo` (ISC), rendered as inline SVG paths with a Natural Earth projection: land `--muted`, borders `--border`, ocean transparent (page ground), target markers `--primary` tinted by worst linked health. Zero external requests — a self-hosted Loxep draws its map from its own bundle. Multiple targets in one region cluster into one marker with a count; the tooltip lists them with deep links. *(Rejected: Leaflet/MapLibre — tile servers are an external dependency and a privacy leak, WebGL is overkill for tens of points; react-simple-maps — effectively unmaintained.)*

## 5. Brand iconography

**Rule I1 — `simple-icons` as data, rendered by a Loxep-owned component.** `simple-icons` 16.28.0 (CC0-1.0) imported per-icon (tree-shaken), rendered by one `BrandIcon` component as inline SVG. A `PROVIDER_BRAND_ICONS` registry maps Loxep provider slugs → simple-icons slugs; providers without a mark (Beszel, Dockhand, Termix, Purelymail are likely absent — verify at implementation) fall back to the lucide icon the catalog/fleet registries already carry, then to an initial-letter tile on `bg-muted`. Never a CDN fetch, never an `<img>` from a brand's site.

**Rule I2 — monochrome `currentColor`, everywhere.** Brand hex colors are rejected outright: they fight ten themes and dark mode, and half the marks fail contrast on tinted cards. The "dressing up" is presence and placement, not brand color. One exception is permitted: the integrations catalog card may tint the icon *tile* with `bg-primary/10` — the mark itself stays `currentColor`.

**Rule I3 — trademark posture, recorded.** Icons appear only beside factual references to the integrated service (a connection of that provider, that provider's estate, that provider's catalog entry) — nominative use to identify the service, no implied endorsement, no use in Loxep's own branding. `simple-icons` removes marks on brand-owner request; the pinned version is the audit trail, and removing a provider's mark is a one-line registry edit. No provider currently requires exclusion.

**Rule I4 — surfaces.** Integrations catalog cards, `/settings/connections` provider cells, estate page headers and the estate indexes, the fleet signals band tiles, the companion links panel, and topology nodes. Icon sizes: 16px inline/table, 20px card header, 24px estate header — no other sizes.

**W4 status (loxep-2xk, 2026-08-17).** Shipped: `apps/web/src/components/ui/brand-icon.tsx` (`BrandIcon`) and `apps/web/src/config/provider-brand-icons.ts` (`PROVIDER_BRAND_ICONS` + `PROVIDER_BRAND_ICON_FALLBACKS`), wired into every I4 surface except topology nodes (W3's territory — the component and registry are exported for W5's stitch, per the epic's wave split).

**W5 status (loxep-pso, 2026-08-17) — the topology stitch.** `topology-node-card.tsx` now renders `BrandIcon` (16px, `currentColor`) beside a `connection`-kind node's name, looked up through `integrationServiceForProvider`/`PROVIDER_BRAND_ICONS`/`PROVIDER_BRAND_ICON_FALLBACKS` — the identical registry and fallback chain `/settings/connections`' own Provider column uses, so a provider absent from the catalog renders no mark, exactly as that column does. This closes I4's "six surfaces" list to all six. One PROVISIONAL fix rode along: `infrastructure-topology-functions.ts`'s `connection` node `meta.provider` carried `providerLabel(connection.provider)` (a capitalized DISPLAY string, e.g. `"Ebay"`) rather than the raw provider slug `integrationServiceForProvider` matches on exactly — a latent W3 inconsistency with `hosting_target`'s own `meta.provider` (already the raw slug) that nothing rendered until this stitch needed a real lookup. Changed to the raw slug; no other code read that field's connection-node value (confirmed by search) and no test asserted its prior capitalized form, so this is a same-wave bugfix within the topology feature, not a behavior change to anything shipped. The map lens and its cluster/unplaced list were checked and need no icon: they name hosting-provider strings (Hetzner, OVH, …) and hosting target/domain names, never an `IntegrationServiceId` connection. Verified against the installed `simple-icons@16.28.0` package directly (not memory): 9 of 15 catalog providers carry a real mark — eBay, Etsy, WooCommerce, Medusa, Invoice Ninja, Cloudflare, Tailscale, Pangolin, ntfy. 6 carry none, exactly the set §5's rule I1 flagged as likely/possibly absent plus Reverb: Reverb, Purelymail, Termix, Gatus, Beszel, Dockhand — each falls back to a semantic icon (Termix/Gatus/Beszel/Dockhand reuse the icon *hint* `packages/domain`'s `FLEET_TOOL_REGISTRY` already names for those four tools; Reverb and Purelymail, not fleet tools, get a first-time best-effort choice — see that file's doc comment for the full reasoning) and, if that were ever also absent, an initial-letter tile. The "lucide icon" this rule and Frontend Standards' mirror describe is implemented as this codebase's actual icon system, `Icons`/`@tabler/icons-react` (`components/icons.tsx`) — this repository never adopted `lucide-react` for product surfaces (it ships only inside donor shadcn/ui primitives), so "lucide" in both docs should be read as "the fallback icon library the catalog/fleet registries already carry," which here is Tabler. A future edit could rename the rule's wording to match; behavior is unaffected either way.

## 6. What does not change (falsifiable)

- The donor `DataTable` stack and `useAppForm` remain the only table and form paths; nothing in this design forks them — the density and mobile work lands *inside* them.
- Every existing frontend-standards rule stays binding: semantic tokens only, `getRowId` on every table, URL table state, chart tokens, one-setting-per-save.
- No new state library; no tailwind config fork; the route/nav architecture and `workspaces.ts` model stand (this design adds exactly one nav item, Topology).
- `/starter` donor surfaces are out of scope beyond inheriting the primitive recalibration.
- No page gains an external network call by default; the map is offline by construction.
- No migration, no new table, no schema change of any kind in this epic.

## 7. Dependencies (verified 2026-08-17 against npm)

| Package | Version | License | Why | Rejected alternatives |
| --- | --- | --- | --- | --- |
| `@xyflow/react` | 12.11.3 | MIT | Interactive node graph: pan/zoom/touch/a11y ship free; active (published 2026-08) | d3-force (illegible for topology), reaflow (small community), hand-rolled SVG (reimplements pan/zoom/hit-testing) |
| `simple-icons` | 16.28.0 | CC0-1.0 | Brand marks as data, tree-shaken per icon | @tabler/icons (no brand focus), CDN fetches (forbidden) |
| `d3-geo` | 3.1.1 | ISC | Projection + path for the offline SVG map | Leaflet/MapLibre (tile servers / WebGL overkill) |
| `topojson-client` | 3.1.0 | ISC | Decode the vendored world topology | — |
| `world-atlas` | 2.0.2 | ISC (Natural Earth data: public domain) | 110m world geometry, bundled, offline | react-simple-maps (unmaintained) |

All five are additive `apps/web` dependencies; manifests are orchestrator-only.

## 8. Contradictions and tensions with existing documents

1. **Frontend-standards' own liveliness note** ("a surface built from only muted tokens cannot respond to a theme switch") has been advisory since the foi epic. Rule D4 promotes it to an audited requirement — an amendment, not a contradiction.
2. **Estate rule P5 (live-read, never persisted) vs the topology page.** No conflict once jurisdiction is stated: estates render *provider truth live*; topology renders *Loxep's records*. Rule G2 records the boundary so a future reader does not "improve" the topology with live fan-out — that would rebuild the estate program without its budget rules.
3. **The stat-card container query** (`@[250px]:text-3xl` upscaling) works against D2's calibration; it is removed with the recalibration rather than fought per-surface.
4. **Heading `text-3xl`** was inherited from the donor dashboard's marketing scale; D2 supersedes it deliberately.

## 9. Open questions

1. **OQ1 (review-noted, not blocking) — brand-mark posture.** This design ships monochrome nominative-use icons (I2/I3). If the owner prefers full-color brand marks anywhere beyond the catalog tile, that is a contrast/theme review per surface — flag before building it.
2. **OQ2 (deferred by rule) — explicit coordinates.** MAP1's registry answers today's fleet. An operator with a colo the registry cannot name reopens the question of an explicit location column — a migration decision to take *then*, on a real case, not now.

## 10. Decomposition into waves

| Wave | Scope | Depends on | Size |
| --- | --- | --- | --- |
| **W1 — Density & emphasis foundation** | D1–D5: primitive recalibration (`card.tsx`, `heading.tsx`, `PageContainer`), stat-card calibration, worst-offender sweep (overview grids, settings/market gaps), frontend-standards amendments land with it | — | M |
| **W2 — Mobile mechanisms** | M1–M5: `ResponsiveDialog` + form-dialog sweep, DataTable mobile pin + toolbar filter sheet, header palette button, touch targets, two-pane stacking | W1 (shared `ui/` files) | L |
| **W3 — Topology page** | G1–G6 + MAP1–MAP2: route, server function, graph lens, map lens, region registry | deps added; parallel with W4 | L |
| **W4 — Brand iconography** | I1–I4: `BrandIcon`, registry, six surfaces | deps added; parallel with W3 | M |
| **W5 — Mobile QA + closeout** | M6: `mobile-chromium` Playwright project, tagged specs, docs status updates | W2 (mechanisms exist) | M |

Zero migrations in every wave. W3 and W4 have disjoint fences and run in parallel; W5 runs last against the integrated tree.

## 11. Related documents

- [Frontend Standards](../../development/frontend-standards/) — amended by this design (density scale, mobile patterns, iconography rules).
- [Estate Browsers Design](../estate-browsers-design/) — the jurisdiction boundary G2 inherits.
- [Fleet Observability Design](../fleet-observability-design/) — `integration_health`, the status source for topology tinting.
- [Settings UX Overhaul Design](../settings-ux-design/) — the previous surface-wide pass this one builds on.
