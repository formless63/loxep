/**
 * The known-tool registry (loxep-ovj.3) — a small typed constant naming
 * every fleet companion tool Loxep's link model knows about: a display
 * label, an icon hint, the documented UNAUTHENTICATED health path used by
 * {@link ../health-probes.ts}'s `external_resource` tier-2 probe
 * (credential-free reachability, per fleet-observability-design.md's tier
 * ladder — "tier 2: link + reachability … still no credential"), and
 * whether the tool supports iframe embedding.
 *
 * **CODE, never a table, never a column on `external_resources`** — see the
 * design's "The link model, and its vocabulary" section: "The known-tool
 * registry is code, not schema … a small typed constant in `@loxep/domain`
 * keyed by `provider`, in the shape of the integrations catalog."
 *
 * `embeddable` is recorded here as a documented FACT about the tool, not a
 * feature this bead builds — every rendering surface still follows the
 * design's own rule, restated in the "Where this surfaces" section: "A deep
 * link opens the tool, not a Loxep copy of it. No embedded container list,
 * no metric chart, no proxied terminal." No panel in this codebase reads
 * `embeddable` to decide whether to render an `<iframe>` today.
 *
 * ## Link-only tools were REMOVED from this registry, on owner instruction
 *
 * `netdata`, `cockpit`, and `uptimekuma` were shipped here for one day
 * (2026-08-13) as link-only, tier-1 entries with no adapter, no connection,
 * and no credential behind them. The owner reviewed that shape on 2026-08-14
 * and rejected it outright: *"ditch netdata"*, and more generally *"remove
 * the link-only stuff from within the app. If it doesn't integrate we don't
 * mention it."* This is a deliberate deletion, not an oversight — do not
 * re-add a provider here (or restore `netdata`/`cockpit`/`uptimekuma`
 * specifically) without integrating it first via `add-integration-provider`.
 * A future reader diffing history and finding these three gone should read
 * this paragraph, not assume they were dropped by accident.
 *
 * The five providers left below (`beszel`, `gatus`, `dockhand`, `tailscale`,
 * `termix`) all have a real adapter, connection, or credential path
 * elsewhere in the codebase — they are not link-only.
 *
 * ## Which providers get a `healthPath`, and why some are `null`
 *
 * `healthPath` is set only when fleet-observability-design.md's "Per-tool
 * verdicts" table documents a genuinely UNAUTHENTICATED reachability route
 * for that tool — tier 2 ("link + reachability") requires exactly that.
 * All five providers carry `healthPath: null` today (`PROBEABLE_FLEET_TOOL_
 * PROVIDERS` below is therefore empty — see that constant's doc and `health-
 * probes.ts`'s explicit `length === 0` short-circuit, which anticipated
 * exactly this end state), for two DIFFERENT reasons:
 *
 * - `tailscale` — "No whoami/identity endpoint exists … Tailscale requires
 *   the credential for even its cheapest read" (design, Tailscale/Termix
 *   detail section, point 2). Tier 3 with no tier-2 predecessor at all.
 * - `termix` — "Termix has NO unauthenticated surface at all"
 *   (loxep-wvm §1.1); `openapi.json`'s global `bearerAuth` security
 *   requirement has no per-operation override, so even `probe()` itself is a
 *   login exchange, never a bare GET. Tier 3 with no tier-2 predecessor.
 * - `beszel` (loxep-y64 slice 3, 2026-08) — Beszel DOES publish `/api/health`
 *   unauthenticated (see `test/live-beszel.test.ts`), so this is NOT the
 *   "no tier-2 route" reason above. It is `null` because the CONNECTION probe
 *   (`@loxep/app`'s `fleet-health.ts`, `probeBeszelConnection`) now writes a
 *   per-system `external_resource` health row directly, as a side effect of
 *   the SAME credential-proven `listSystems()` read that already determines
 *   the connection's own status (`source: 'adapter'`, per-system, verbatim
 *   status) — a strictly richer read than the generic tier-2 probe's bare
 *   unauthenticated GET (`source: 'probe'`, hub-reachability-only, blind to
 *   which system it is even naming). If beszel stayed in
 *   `PROBEABLE_FLEET_TOOL_PROVIDERS`, EVERY discovered Beszel
 *   `external_resources` row (linked or not — discovery keeps unlinked
 *   systems too, see `resource-links.ts`'s attach-picker doc) would ALSO be a
 *   tier-2 candidate, and once its backoff interval elapsed the generic probe
 *   would eventually overwrite the adapter-sourced row with a coarser
 *   `source: 'probe'` one — the exact per-resource "last sweep wins" race the
 *   design's shared law forbids for `subject_type='hosting_target'`, recreated
 *   here one level down between two WRITERS of the same `external_resource`
 *   subject instead of two subject types. Excluding beszel from
 *   `PROBEABLE_FLEET_TOOL_PROVIDERS` is the fix: exactly one writer per
 *   subject. A future provider (Dockhand/Gatus/Tailscale/Termix) that grows
 *   its own discovery+per-resource-health side effect should null its
 *   `healthPath` here too, in the same change, for the same reason.
 *
 * - `dockhand` (loxep-hb7, 2026-08-15) — Dockhand DOES publish
 *   `probeSession()` -> `GET /api/auth/session` unauthenticated (loxep-hb7
 *   §1.1), so this is the SAME "superseded by a richer adapter read" reason
 *   as beszel's, not the "no tier-2 route" reason tailscale/termix have. The
 *   connection probe's discovery side effect (`@loxep/app`'s
 *   `projectDockhandResources`, run off the SAME credential-proven
 *   `listHosts()` read `probeDockhandConnection` already makes) now writes a
 *   per-environment `external_resource` health row directly
 *   (`source: 'adapter'`, one row per Dockhand environment). Leaving
 *   `healthPath` set would let the generic tier-2 probe eventually overwrite
 *   that adapter-sourced row with a coarser `source: 'probe'` hub-
 *   reachability-only one once its backoff elapsed — the exact race beszel's
 *   entry above already closed. Nulling it here is the same fix, applied to
 *   the second provider that grew this side effect.
 * - `gatus` (loxep-1au slice B, 2026-08-15) — Gatus DOES publish `GET
 *   /health` unauthenticated, so this is again the "superseded" reason, not
 *   "no tier-2 route". `@loxep/app`'s `projectGatusEndpoints`, run off the
 *   SAME `direct`-posture `listEndpointStatuses()` read the connection probe
 *   already makes, now writes a per-endpoint `external_resource` health row
 *   directly. Leaving `healthPath` set is a SHARPER version of the same race
 *   here than for Beszel/Dockhand: `/health` reports the HUB's process
 *   liveness, not any one endpoint's — every linked Gatus endpoint would
 *   share the exact same tier-2 probe URL (its link's origin, since all
 *   endpoints on one connection share one origin), so the generic probe
 *   would not just race the richer per-endpoint reads, it would write the
 *   SAME coarse verdict onto every one of them.
 *
 * A `null` healthPath means {@link ../health-probes.ts}'s `external_resource`
 * probe never lists that provider's links as sweep candidates at all — see
 * `PROBEABLE_FLEET_TOOL_PROVIDERS` below. This is "absent renders absent"
 * applied to the registry itself: no fabricated `unknown` row implying a
 * check nothing is actually running (tailscale/termix), and no COMPETING
 * check duplicating one a richer read already covers (beszel, dockhand,
 * gatus).
 *
 * ## The probe targets the link's ORIGIN, never its stored URL verbatim
 *
 * `external_resources.url` is a deep link into ONE specific resource (a
 * Beszel system's own page, a Dockhand environment's own page) — never a
 * base URL (the link model's rule: "metadata holds sync metadata only …
 * never a copy of the tool's data", and `url` is the one field that is
 * always resource-specific, per the vocabulary table). The tier-2 probe in
 * `health-probes.ts` therefore resolves `new URL(link.url).origin` and
 * appends `healthPath` to THAT, not to the stored URL.
 *
 * ## Panel render order — PROVISIONAL (loxep-ovj.3, settling loxep-wvm §4.4)
 *
 * Two sibling designs proposed opposite witness orders for the shared
 * Companion-tools panel and neither built it: loxep-y64 §4 ordered
 * outside-in (`gatus → beszel → dockhand`, walking from a user-visible
 * symptom toward machine internals); loxep-50t §3.1 ordered
 * fundamental-first (`tailscale → beszel → gatus`, cheapest/most-basic
 * signal first). loxep-wvm §4.4 named the conflict and required it be
 * settled ONCE here, not per provider — see also `host-diagnosis.ts`'s
 * "Ladder order vs. panel render order" section, which explicitly declines
 * to resolve it and defers to this module.
 *
 * **Decision: fundamental-first**, extended to all five known providers as
 * `FLEET_TOOL_PANEL_ORDER` below (originally extended to eight; three
 * link-only providers — `netdata`, `cockpit`, `uptimekuma` — were removed
 * from the registry entirely on 2026-08-14, see "Link-only tools were
 * REMOVED" above, and dropped from this order along with them). Three
 * reasons, none of them taste:
 *
 * 1. `diagnoseHostWitnesses`'s one derived sentence renders directly ABOVE
 *    this panel (this bead's own remaining scope) and reasons over
 *    `HOST_DIAGNOSIS_LADDER`, which is already fixed fundamental-first
 *    (`tailscale → beszel → dockhand → gatus`, loxep-50t §3.1). Rendering
 *    the panel in a DIFFERENT order than the sentence just reasoned in would
 *    force an operator to mentally re-sort the witnesses to map the prose
 *    back onto the rows it is describing. Matching orders keeps the sentence
 *    and the evidence beneath it legible as one argument.
 * 2. It matches how an operator actually triages a host in an incident,
 *    proactively opening the fleet page — network stack first (is there a
 *    machine to reach at all), then access (could I get a shell if I needed
 *    one), then host/agent (is the OS alive), then daemon/console (is the
 *    container runtime answering), then service (does the specific thing
 *    people use actually respond). Outside-in privileges the case where a
 *    user already reported a symptom and Gatus is therefore the known entry
 *    point — true often, but not the shape of an operator opening this page
 *    unprompted, which is the more general case a panel has to serve.
 * 3. Fundamental-first has a logical argument outside-in does not: Gatus
 *    itself cannot answer without the network working, so "is there a
 *    network at all" is logically PRIOR to "does the endpoint answer",
 *    independent of which one a human happens to notice first. Ordering by
 *    that dependency, rather than by which failure a user would report
 *    first, is the more defensible default when both orders are otherwise
 *    reasonable.
 *
 * This is marked PROVISIONAL, in this comment and in
 * fleet-observability-design.md's "Where this surfaces" section, because it
 * is a product-feel call the owner has not been asked to confirm — a future
 * change reversing it should update both places together, not just the
 * array below.
 */

export const FLEET_TOOL_PROVIDERS = [
  "beszel",
  "gatus",
  "dockhand",
  "tailscale",
  "termix",
] as const;
export type FleetToolProvider = (typeof FLEET_TOOL_PROVIDERS)[number];

export interface FleetToolRegistryEntry {
  /** Display label — matches the connection-catalog naming for tier-3 tools. */
  readonly label: string;
  /**
   * A short semantic hint for the rendering layer to map onto whatever icon
   * set it has (this package has no UI dependency and cannot name one
   * directly) — never a literal icon-component reference.
   */
  readonly icon: string;
  /**
   * Documented UNAUTHENTICATED health path, resolved against the linked
   * resource's URL ORIGIN (see the module doc). `null` when the tool
   * publishes no unauthenticated reachability route at all — see "Which
   * providers get a `healthPath`" above.
   */
  readonly healthPath: string | null;
  /** Whether the tool is known to support iframe embedding — a recorded fact, not a feature any surface builds on (see module doc). */
  readonly embeddable: boolean;
}

/**
 * Verified against fleet-observability-design.md's "Per-tool verdicts" and
 * per-tool detail sections (2026-08-13) unless a field-level comment says
 * otherwise. `dockhand`'s path is `probeSession()`'s own route, "deliberately
 * NOT wrapped in `authenticated`" (loxep-hb7 §1.1).
 */
export const FLEET_TOOL_REGISTRY: Record<FleetToolProvider, FleetToolRegistryEntry> = {
  gatus: {
    label: "Gatus",
    icon: "pulse",
    // null since loxep-1au slice B (2026-08-15), NOT because no
    // unauthenticated route exists (it does: GET /health) — see the module
    // doc's "Which providers get a healthPath" section, gatus entry, for the
    // superseded-by-a-richer-adapter-read reason (and why it is a sharper
    // race here than for Beszel/Dockhand).
    healthPath: null,
    // "Iframe embedding" is not discussed for Gatus in the design; the
    // design's own "Where this surfaces" section named Netdata as the one
    // genuinely-available embed among the tools it surveyed, but Netdata was
    // removed from this registry (see the module doc) — treat unlisted as
    // not embeddable regardless.
    embeddable: false,
  },
  beszel: {
    label: "Beszel",
    icon: "radar",
    // null since loxep-y64 slice 3, NOT because no unauthenticated route
    // exists (it does: `/api/health`) — see the module doc's "Which
    // providers get a healthPath" section, beszel entry, for the
    // superseded-by-a-richer-adapter-read reason.
    healthPath: null,
    // "Iframe embedding is effectively unsupported upstream" (design,
    // Beszel detail section).
    embeddable: false,
  },
  dockhand: {
    label: "Dockhand",
    icon: "container",
    // null since loxep-hb7's discovery slice (2026-08-15), NOT because no
    // unauthenticated route exists (it does: probeSession() ->
    // GET /api/auth/session) — see the module doc's "Which providers get a
    // healthPath" section, dockhand entry, for the
    // superseded-by-a-richer-adapter-read reason.
    healthPath: null,
    embeddable: false, // rule 13 — no UI may imply container control, embedded or otherwise
  },
  tailscale: {
    label: "Tailscale",
    icon: "radar",
    // No unauthenticated route exists at all — the ORIGINAL "tier 3 direct,
    // no tier-2 predecessor" reason (module doc), unchanged by loxep-50t
    // slice B: `projectTailscaleDevices` writes per-device health from the
    // SAME `listDevices()` credential-proving read regardless of whether a
    // tier-2 predecessor ever existed to supersede.
    healthPath: null,
    embeddable: false,
  },
  termix: {
    label: "Termix",
    icon: "laptop",
    healthPath: null, // tier 3 direct, no tier-2 predecessor — see module doc
    embeddable: false,
  },
};

export function isFleetToolProvider(provider: string): provider is FleetToolProvider {
  return (FLEET_TOOL_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Providers whose `external_resources` links can be tier-2 probed
 * credential-free — the exact set `health-probes.ts`'s `external_resource`
 * subject-type entry lists as sweep candidates. Derived from the registry
 * rather than hand-duplicated, so a future provider addition cannot list
 * itself here without also declaring a `healthPath`.
 */
export const PROBEABLE_FLEET_TOOL_PROVIDERS: readonly FleetToolProvider[] =
  FLEET_TOOL_PROVIDERS.filter(
    (provider) => FLEET_TOOL_REGISTRY[provider].healthPath !== null,
  );

/**
 * The shared Companion-tools panel's witness/tool render order — PROVISIONAL,
 * see the module doc's "Panel render order" section for the full reasoning.
 * Covers all five known providers (not just the four
 * {@link ../host-diagnosis.ts} `HOST_DIAGNOSIS_LADDER} reasons over) so a
 * rendering surface has one order to sort by regardless of which tools are
 * actually linked to a given target. Originally covered eight; `netdata`,
 * `cockpit`, and `uptimekuma` were removed from the registry on 2026-08-14
 * (see the module doc's "Link-only tools were REMOVED" section) and dropped
 * from this order with them.
 */
export const FLEET_TOOL_PANEL_ORDER: readonly FleetToolProvider[] = [
  "tailscale",
  "termix",
  "beszel",
  "dockhand",
  "gatus",
];

/**
 * Sort comparator for {@link FLEET_TOOL_PANEL_ORDER}. A provider not in the
 * registry (a non-fleet companion link — e.g. a future knowledge/tasks
 * consumer's provider) sorts after every known fleet tool rather than
 * throwing, so a mixed list degrades gracefully instead of crashing a panel.
 */
export function compareFleetToolPanelOrder(a: string, b: string): number {
  const indexA = FLEET_TOOL_PANEL_ORDER.indexOf(a as FleetToolProvider);
  const indexB = FLEET_TOOL_PANEL_ORDER.indexOf(b as FleetToolProvider);
  const rankA = indexA === -1 ? FLEET_TOOL_PANEL_ORDER.length : indexA;
  const rankB = indexB === -1 ? FLEET_TOOL_PANEL_ORDER.length : indexB;
  return rankA - rankB;
}

/**
 * The fixed `(provider, externalType, resourceType) -> purpose` vocabulary
 * the operator-confirmed attach picker (loxep-y64 slice 3) is allowed to
 * write — copied from fleet-observability-design.md's "The link model, and
 * its vocabulary" table, never invented at a call site. Deliberately NOT the
 * design doc's full table: only pairs a SHIPPED discovery mechanism can
 * actually produce are listed, so `fleetDiscoveredResourcePurpose` refuses a
 * combination nothing yet discovers rather than guessing a purpose for it —
 * the same "absent renders absent" discipline this module already applies to
 * `healthPath`.
 *
 * `beszel:system:hosting_target`, `dockhand:environment:hosting_target`,
 * `termix:host:hosting_target`, `tailscale:device:hosting_target`, and
 * `gatus:endpoint:hosting_target` are the members today — the five
 * provider/externalType/resourceType triples `@loxep/app`'s `fleet-health.ts`
 * (`projectBeszelSystems`/`projectDockhandResources`/`projectTermixResources`/
 * `projectTailscaleDevices`/`projectGatusEndpoints`) actually write
 * `external_resources` rows for, copied verbatim from
 * fleet-observability-design.md's vocabulary table. `beszel:hub:hosting_target
 * -> metrics_console` and `dockhand:stack:hosting_target -> stack` are in the
 * design's table but have no discovery writer yet — add each in the same
 * change that starts writing one. `gatus:endpoint:managed_domain` is
 * similarly reserved (loxep-1au §5) and deliberately absent: `managed_domain`
 * is not yet a member of `RESOURCE_LINK_RESOURCE_TYPES`.
 */
const FLEET_LINK_VOCABULARY: Readonly<Record<string, string>> = {
  "beszel:system:hosting_target": "host_metrics",
  "dockhand:environment:hosting_target": "container_console",
  "termix:host:hosting_target": "terminal_access",
  "tailscale:device:hosting_target": "private_network",
  "gatus:endpoint:hosting_target": "uptime_check",
};

/**
 * The fixed purpose an attach picker must use when linking one discovered
 * resource to one Loxep record — `null` when this provider/externalType/
 * resourceType combination is not in {@link FLEET_LINK_VOCABULARY}, which the
 * caller must treat as "cannot be attached through the picker yet," never
 * fall back to a guessed or operator-typed value for.
 */
export function fleetDiscoveredResourcePurpose(
  provider: string,
  externalType: string,
  resourceType: string,
): string | null {
  return FLEET_LINK_VOCABULARY[`${provider}:${externalType}:${resourceType}`] ?? null;
}
