/**
 * `tailnetAddressKind` / `isPrivateTailnetAddress` — the CGNAT/ULA
 * containment predicate loxep-89h adds. Pure: no database, no network, no
 * clock. Boundary cases matter more than the happy path here, because the
 * whole point of this module is that a materializer refusal must trigger on
 * every address in range and never on one that is not.
 */
import { describe, expect, it } from "vitest";
import {
  TAILSCALE_CGNAT_V4_CIDR,
  TAILSCALE_ULA_V6_CIDR,
  isPrivateTailnetAddress,
  tailnetAddressKind,
} from "../src/tailnet-address.ts";

describe("tailnetAddressKind — IPv4 CGNAT range (100.64.0.0/10)", () => {
  it("matches the first address in the range", () => {
    expect(tailnetAddressKind("100.64.0.0")).toBe("cgnat_v4");
  });

  it("matches the last address in the range", () => {
    expect(tailnetAddressKind("100.127.255.255")).toBe("cgnat_v4");
  });

  it("matches a typical mid-range tailnet address", () => {
    expect(tailnetAddressKind("100.100.50.7")).toBe("cgnat_v4");
  });

  it("does NOT match one address below the range", () => {
    expect(tailnetAddressKind("100.63.255.255")).toBeNull();
  });

  it("does NOT match one address above the range", () => {
    expect(tailnetAddressKind("100.128.0.0")).toBeNull();
  });

  it("does NOT match an ordinary public IPv4 address", () => {
    expect(tailnetAddressKind("203.0.113.10")).toBeNull();
  });

  it("does NOT match RFC 1918 private space — a different range entirely", () => {
    expect(tailnetAddressKind("10.0.0.4")).toBeNull();
    expect(tailnetAddressKind("192.168.1.1")).toBeNull();
  });
});

describe("tailnetAddressKind — IPv6 ULA prefix (fd7a:115c:a1e0::/48)", () => {
  it("matches the prefix's own network address", () => {
    expect(tailnetAddressKind("fd7a:115c:a1e0::")).toBe("tailscale_ula_v6");
  });

  it("matches a typical tailnet IPv6 address", () => {
    expect(tailnetAddressKind("fd7a:115c:a1e0:ab12::1234:5678")).toBe(
      "tailscale_ula_v6",
    );
  });

  it("matches case-insensitively", () => {
    expect(tailnetAddressKind("FD7A:115C:A1E0::1")).toBe("tailscale_ula_v6");
  });

  it("does NOT match a one-bit-outside address (last hextet of the /48 changed)", () => {
    // fd7a:115c:a1e1::/48 differs from the tailnet prefix in the 48th bit.
    expect(tailnetAddressKind("fd7a:115c:a1e1::1")).toBeNull();
  });

  it("does NOT match an ordinary public IPv6 address", () => {
    expect(tailnetAddressKind("2001:db8::10")).toBeNull();
  });

  it("does NOT match a different ULA prefix", () => {
    expect(tailnetAddressKind("fd00::1")).toBeNull();
  });
});

describe("tailnetAddressKind — malformed input", () => {
  it("returns null rather than throwing on garbage input", () => {
    expect(tailnetAddressKind("not-an-address")).toBeNull();
    expect(tailnetAddressKind("")).toBeNull();
    expect(tailnetAddressKind("999.999.999.999")).toBeNull();
  });
});

describe("isPrivateTailnetAddress", () => {
  it("is true for a CGNAT address", () => {
    expect(isPrivateTailnetAddress("100.90.1.1")).toBe(true);
  });

  it("is true for a Tailscale ULA address", () => {
    expect(isPrivateTailnetAddress("fd7a:115c:a1e0::5")).toBe(true);
  });

  it("is false for a public address in either family", () => {
    expect(isPrivateTailnetAddress("203.0.113.10")).toBe(false);
    expect(isPrivateTailnetAddress("2001:db8::10")).toBe(false);
  });
});

describe("the exported CIDR constants — verified against upstream Tailscale docs", () => {
  // Verified 2026-08-14 against https://tailscale.com/kb/1015/100.x-addresses
  // ("IP addresses from the CGNAT range are special-use IPv4 addresses from
  // the 100.64.0.0/10 subnet") and https://tailscale.com/kb/1033/ip-and-dns-
  // addresses ("Tailscale IPv6 addresses are assigned from the unique local
  // address prefix of fd7a:115c:a1e0::/48"). This test exists so a future
  // edit to either literal fails loudly here, not silently in production.
  it("matches the documented literals exactly", () => {
    expect(TAILSCALE_CGNAT_V4_CIDR).toBe("100.64.0.0/10");
    expect(TAILSCALE_ULA_V6_CIDR).toBe("fd7a:115c:a1e0::/48");
  });
});
