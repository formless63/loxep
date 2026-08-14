/**
 * The known-tool registry (loxep-ovj.3): pure, no database, no network —
 * asserts the shape the design's "known-tool registry is code, not schema"
 * rule promises, and the derived helpers `health-probes.ts` and the
 * Companion-tools panel depend on.
 */
import { describe, expect, it } from "vitest";
import {
  compareFleetToolPanelOrder,
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

  it("marks exactly tailscale, termix, and uptimekuma as having no tier-2 health path", () => {
    const noHealthPath = FLEET_TOOL_PROVIDERS.filter(
      (provider) => FLEET_TOOL_REGISTRY[provider].healthPath === null,
    );
    expect(noHealthPath.sort()).toEqual(["tailscale", "termix", "uptimekuma"]);
  });

  it("derives PROBEABLE_FLEET_TOOL_PROVIDERS from the registry, not a hand-duplicated list", () => {
    for (const provider of PROBEABLE_FLEET_TOOL_PROVIDERS) {
      expect(FLEET_TOOL_REGISTRY[provider].healthPath).not.toBeNull();
    }
    expect(PROBEABLE_FLEET_TOOL_PROVIDERS).toContain("beszel");
    expect(PROBEABLE_FLEET_TOOL_PROVIDERS).toContain("gatus");
    expect(PROBEABLE_FLEET_TOOL_PROVIDERS).toContain("dockhand");
    expect(PROBEABLE_FLEET_TOOL_PROVIDERS).toContain("netdata");
    expect(PROBEABLE_FLEET_TOOL_PROVIDERS).toContain("cockpit");
    expect(PROBEABLE_FLEET_TOOL_PROVIDERS).not.toContain("tailscale");
    expect(PROBEABLE_FLEET_TOOL_PROVIDERS).not.toContain("termix");
    expect(PROBEABLE_FLEET_TOOL_PROVIDERS).not.toContain("uptimekuma");
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
