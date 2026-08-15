/**
 * The known-tool registry (loxep-ovj.3): pure, no database, no network —
 * asserts the shape the design's "known-tool registry is code, not schema"
 * rule promises, and the derived helpers `health-probes.ts` and the
 * Companion-tools panel depend on.
 */
import { describe, expect, it } from "vitest";
import {
  compareFleetToolPanelOrder,
  fleetDiscoveredResourcePurpose,
  FLEET_TOOL_PANEL_ORDER,
  FLEET_TOOL_PROVIDERS,
  FLEET_TOOL_REGISTRY,
  isFleetToolProvider,
  PROBEABLE_FLEET_TOOL_PROVIDERS,
} from "../src/index.ts";

describe("fleet tool registry", () => {
  it("has one entry per declared provider, with a label and a boolean embeddable flag", () => {
    for (const provider of FLEET_TOOL_PROVIDERS) {
      const entry = FLEET_TOOL_REGISTRY[provider];
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.icon.length).toBeGreaterThan(0);
      expect(typeof entry.embeddable).toBe("boolean");
      expect(entry.healthPath === null || entry.healthPath.startsWith("/")).toBe(true);
    }
  });

  it("marks all five providers as having no tier-2 health path (two different reasons)", () => {
    // tailscale/termix: no unauthenticated route exists at all. beszel/
    // dockhand/gatus: a route DOES exist (/api/health, /api/auth/session,
    // /health respectively) but each is superseded, once its own discovery
    // slice landed, by the connection probe's own richer per-resource
    // adapter read — see fleet-tool-registry.ts's module doc, "Which
    // providers get a healthPath" section, each provider's own entry.
    const noHealthPath = FLEET_TOOL_PROVIDERS.filter(
      (provider) => FLEET_TOOL_REGISTRY[provider].healthPath === null,
    );
    expect(noHealthPath.sort()).toEqual(["beszel", "dockhand", "gatus", "tailscale", "termix"]);
  });

  it("holds exactly the five integrated providers — link-only tools were removed", () => {
    // netdata, cockpit, and uptimekuma had no adapter, connection, or
    // credential and were deliberately removed on owner instruction ("if it
    // doesn't integrate we don't mention it") — see the registry module doc.
    // This asserts the real, current set rather than a stale historical count.
    expect([...FLEET_TOOL_PROVIDERS].sort()).toEqual([
      "beszel",
      "dockhand",
      "gatus",
      "tailscale",
      "termix",
    ]);
  });

  it("derives PROBEABLE_FLEET_TOOL_PROVIDERS from the registry, not a hand-duplicated list — now EMPTY", () => {
    for (const provider of PROBEABLE_FLEET_TOOL_PROVIDERS) {
      expect(FLEET_TOOL_REGISTRY[provider].healthPath).not.toBeNull();
    }
    // Every one of the five fleet providers now grows its own discovery +
    // per-resource adapter-sourced health (Beszel/Dockhand/Gatus/Tailscale/
    // Termix, in that shipping order) — `health-probes.ts`'s
    // `listExternalResourceCandidates` anticipated exactly this end state
    // with its own `length === 0` short-circuit. This is not a bug to fix;
    // it is the generic tier-2 probe becoming permanently vestigial as each
    // provider's richer read supersedes it, one at a time.
    expect(PROBEABLE_FLEET_TOOL_PROVIDERS).toEqual([]);
  });

  describe("fleetDiscoveredResourcePurpose (loxep-y64 slice 3 attach picker)", () => {
    it("resolves each shipped provider's discovery type -> hosting_target purpose from the design's vocabulary", () => {
      expect(fleetDiscoveredResourcePurpose("beszel", "system", "hosting_target")).toBe(
        "host_metrics",
      );
      expect(fleetDiscoveredResourcePurpose("dockhand", "environment", "hosting_target")).toBe(
        "container_console",
      );
      expect(fleetDiscoveredResourcePurpose("termix", "host", "hosting_target")).toBe(
        "terminal_access",
      );
      expect(fleetDiscoveredResourcePurpose("tailscale", "device", "hosting_target")).toBe(
        "private_network",
      );
      expect(fleetDiscoveredResourcePurpose("gatus", "endpoint", "hosting_target")).toBe(
        "uptime_check",
      );
    });

    it("refuses a combination nothing discovers yet, rather than guessing", () => {
      expect(fleetDiscoveredResourcePurpose("beszel", "hub", "hosting_target")).toBeNull();
      expect(fleetDiscoveredResourcePurpose("dockhand", "stack", "hosting_target")).toBeNull();
      // Reserved in the design's vocabulary table but has no discovery
      // writer yet (managed_domain is not a RESOURCE_LINK_RESOURCE_TYPES
      // member) — refuses rather than guessing, same as the others above.
      expect(fleetDiscoveredResourcePurpose("gatus", "endpoint", "managed_domain")).toBeNull();
      expect(fleetDiscoveredResourcePurpose("bookstack", "page", "hosting_target")).toBeNull();
    });
  });

  it("isFleetToolProvider narrows only the known providers", () => {
    expect(isFleetToolProvider("beszel")).toBe(true);
    expect(isFleetToolProvider("bookstack")).toBe(false);
  });

  describe("panel render order (PROVISIONAL, loxep-ovj.3 settling loxep-wvm §4.4)", () => {
    it("covers every known provider exactly once", () => {
      expect([...FLEET_TOOL_PANEL_ORDER].sort()).toEqual([...FLEET_TOOL_PROVIDERS].sort());
    });

    it("is fundamental-first, matching HOST_DIAGNOSIS_LADDER's tailscale -> beszel -> dockhand -> gatus", () => {
      const ladderProviders = ["tailscale", "beszel", "dockhand", "gatus"] as const;
      const positions = ladderProviders.map((provider) => FLEET_TOOL_PANEL_ORDER.indexOf(provider));
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions).toEqual(sorted);
    });

    it("orders tailscale above termix (loxep-50t §3.3, inherited by loxep-wvm §4.4)", () => {
      const tailscaleIndex = FLEET_TOOL_PANEL_ORDER.indexOf("tailscale");
      const termixIndex = FLEET_TOOL_PANEL_ORDER.indexOf("termix");
      expect(tailscaleIndex).toBeLessThan(termixIndex);
    });

    it("compareFleetToolPanelOrder sorts a mixed link list into the fixed order", () => {
      const shuffled = ["gatus", "dockhand", "tailscale", "beszel", "termix"];
      const sorted = [...shuffled].sort(compareFleetToolPanelOrder);
      expect(sorted).toEqual(["tailscale", "termix", "beszel", "dockhand", "gatus"]);
    });

    it("compareFleetToolPanelOrder sorts an unknown provider after every known one", () => {
      const mixed = ["gatus", "bookstack", "tailscale"];
      const sorted = [...mixed].sort(compareFleetToolPanelOrder);
      expect(sorted).toEqual(["tailscale", "gatus", "bookstack"]);
    });
  });
});
