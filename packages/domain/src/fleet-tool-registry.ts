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
 * ## Which providers get a `healthPath`, and why some are `null`
 *
 * `healthPath` is set only when fleet-observability-design.md's "Per-tool
 * verdicts" table documents a genuinely UNAUTHENTICATED reachability route
 * for that tool — tier 2 ("link + reachability") requires exactly that.
 * Three providers are tier 3 with NO tier-2 predecessor at all, by the
 * design's own verified finding, and therefore carry `healthPath: null`:
 *
 * - `tailscale` — "No whoami/identity endpoint exists … Tailscale requires
 *   the credential for even its cheapest read" (design, Tailscale/Termix
 *   detail section, point 2).
 * - `termix` — "Termix has NO unauthenticated surface at all"
 *   (loxep-wvm §1.1); `openapi.json`'s global `bearerAuth` security
 *   requirement has no per-operation override, so even `probe()` itself is a
 *   login exchange, never a bare GET.
 * - `uptimekuma` — confirmed "tier 1 … No adapter against an API upstream
 *   disclaims" (design, per-tool verdicts table). Its one unauthenticated
 *   GET (`/api/status-page/:slug`) needs a per-status-page slug this generic
 *   registry has no way to supply, so it stays link-only.
 *
 * A `null` healthPath means {@link ../health-probes.ts}'s `external_resource`
 * probe never lists that provider's links as sweep candidates at all — see
 * `PROBEABLE_FLEET_TOOL_PROVIDERS` below. This is "absent renders absent"
 * applied to the registry itself: no fabricated `unknown` row implying a
 * check nothing is actually running.
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
 * **Decision: fundamental-first**, extended to all eight known providers as
 * `FLEET_TOOL_PANEL_ORDER` below. Three reasons, none of them taste:
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
  "netdata",
  "cockpit",
  "uptimekuma",
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
    healthPath: "/health",
    // "Iframe embedding" is not discussed for Gatus in the design, and the
    // design's own "Where this surfaces" section only names Netdata as the
    // genuinely-available embed; treat unlisted as not embeddable.
    embeddable: false,
  },
  beszel: {
    label: "Beszel",
    icon: "radar",
    healthPath: "/api/health",
    // "Iframe embedding is effectively unsupported upstream" (design,
    // Beszel detail section).
    embeddable: false,
  },
  dockhand: {
    label: "Dockhand",
    icon: "container",
    // probeSession() -> GET /api/auth/session (loxep-hb7 §1.1): reachability
    // only, proves nothing about the credential — see health-probes.ts's
    // module doc for why the connection-level probe still needs a SECOND,
    // authenticated call this tier-2 check does not perform.
    healthPath: "/api/auth/session",
    embeddable: false, // rule 13 — no UI may imply container control, embedded or otherwise
  },
  netdata: {
    label: "Netdata",
    icon: "pulse",
    // UNVERIFIED against a live agent — no Netdata credential or instance
    // exists on this box to confirm. The design's own text names only the
    // v3 data/alert routes explicitly ("Any future adapter targets v3");
    // this path follows that same version guidance for a plain reachability
    // ping rather than quoting a route the design states verbatim. Re-verify
    // before relying on this for anything beyond "is the origin up".
    healthPath: "/api/v3/info",
    embeddable: true, // "Iframe-able by default" (design, per-tool verdicts table)
  },
  cockpit: {
    label: "Cockpit",
    icon: "laptop",
    // "GET /ping -> {"service":"cockpit"}, CORS-enabled and documented" (design).
    healthPath: "/ping",
    // "X-Frame-Options: sameorigin is hard-coded with no configuration knob
    // … do not design for it" (design, per-tool verdicts table).
    embeddable: false,
  },
  uptimekuma: {
    label: "Uptime Kuma",
    icon: "pulse",
    healthPath: null, // tier 1 only — see module doc
    embeddable: false,
  },
  tailscale: {
    label: "Tailscale",
    icon: "radar",
    healthPath: null, // tier 3 direct, no tier-2 predecessor — see module doc
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
 * Covers all eight known providers (not just the four
 * {@link ../host-diagnosis.ts} `HOST_DIAGNOSIS_LADDER} reasons over) so a
 * rendering surface has one order to sort by regardless of which tools are
 * actually linked to a given target. `uptimekuma` is listed last for
 * completeness even though its only fixed vocabulary purpose today
 * (`managed_domain`/`uptime_check`) means it never actually appears on the
 * `hosting_target`-scoped Companion-tools panel this bead upgrades.
 */
export const FLEET_TOOL_PANEL_ORDER: readonly FleetToolProvider[] = [
  "tailscale",
  "termix",
  "beszel",
  "netdata",
  "dockhand",
  "cockpit",
  "gatus",
  "uptimekuma",
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
