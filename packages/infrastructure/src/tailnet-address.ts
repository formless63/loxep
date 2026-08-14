/**
 * Tailscale private-address containment — a PURE predicate, no database and
 * no network, so both the materializer (which must refuse to publish one)
 * and the web surface (which must warn an operator who stored one) call the
 * SAME function instead of maintaining two copies of the same two CIDR
 * literals. Two copies is how one of them later drifts out of sync with
 * upstream Tailscale documentation.
 *
 * ## Why this exists at all
 *
 * `hosting_targets.address_v4` / `address_v6` are consumed by
 * `resolveHostingAddress` (`materialize.ts`) and published as A/AAAA
 * records. A Tailscale address is not a public address at all:
 *
 * - **IPv4** — Tailscale assigns tailnet addresses from the shared CGNAT
 *   range `100.64.0.0/10` (RFC 6598 carrier-grade NAT space). Verified
 *   2026-08-14 against Tailscale's own docs: "IP addresses from the CGNAT
 *   range are special-use IPv4 addresses from the `100.64.0.0/10` subnet
 *   (`100.64.0.0` through `100.127.255.255`)."
 *   Source: https://tailscale.com/kb/1015/100.x-addresses
 * - **IPv6** — Tailscale assigns tailnet addresses from its own Unique
 *   Local Address prefix `fd7a:115c:a1e0::/48`. Verified 2026-08-14: "every
 *   device in your tailnet [gets] a private IPv6 address from the unique
 *   local address prefix of `fd7a:115c:a1e0::/48`."
 *   Source: https://tailscale.com/kb/1033/ip-and-dns-addresses
 *
 * A DNS resolver answering a public query with either kind of address
 * produces a record nothing on the public internet can reach, and the
 * failure presents as a DNS propagation problem — the identical failure
 * mode `resolveHostingAddress`'s module doc already warns about for the
 * `fronted_by_target_id` hop. This module gives that hazard a name so it can
 * be refused rather than published.
 *
 * Both prefixes are re-verified at every review of this file, not trusted
 * from memory — see `packages/infrastructure/test/tailnet-address.test.ts`
 * for the boundary cases (first/last address in range, one bit outside).
 */

/** Tailscale's CGNAT range for tailnet IPv4 addresses (RFC 6598 space). */
export const TAILSCALE_CGNAT_V4_CIDR = "100.64.0.0/10";

/** Tailscale's Unique Local Address prefix for tailnet IPv6 addresses. */
export const TAILSCALE_ULA_V6_CIDR = "fd7a:115c:a1e0::/48";

/** Which Tailscale-private range an address matched, or `null` for neither. */
export type TailnetAddressKind = "cgnat_v4" | "tailscale_ula_v6";

function parseIPv4(address: string): number | null {
  const parts = address.trim().split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function ipv4InCidr(address: string, cidr: string): boolean {
  const [base, prefixLenRaw] = cidr.split("/");
  const prefixLen = Number(prefixLenRaw);
  const addressValue = parseIPv4(address);
  const baseValue = base === undefined ? null : parseIPv4(base);
  if (addressValue === null || baseValue === null) return false;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (addressValue & mask) === (baseValue & mask);
}

/**
 * Parse a plain IPv6 literal to its 128-bit value.
 *
 * Deliberately does NOT support the IPv4-mapped (`::ffff:1.2.3.4`) or
 * IPv4-compatible textual forms — Tailscale never issues those for a tailnet
 * address, `hosting_targets.address_v6` has its own dedicated `address_v4`
 * sibling for the IPv4 case, and accepting a hybrid form here would only
 * widen the surface this parser has to get right for no real input it will
 * ever see.
 */
function parseIPv6(address: string): bigint | null {
  const trimmed = address.trim();
  if (trimmed.length === 0 || trimmed.includes(".")) return null;

  const halves = trimmed.split("::");
  if (halves.length > 2) return null; // "::" may appear at most once

  const parseGroups = (segment: string): string[] =>
    segment === "" ? [] : segment.split(":");

  let groups: string[];
  if (halves.length === 1) {
    groups = parseGroups(halves[0] ?? "");
    if (groups.length !== 8) return null;
  } else {
    const head = parseGroups(halves[0] ?? "");
    const tail = parseGroups(halves[1] ?? "");
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // "::" must elide at least one group
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

function ipv6InCidr(address: string, cidr: string): boolean {
  const [base, prefixLenRaw] = cidr.split("/");
  const prefixLen = Number(prefixLenRaw);
  const addressValue = parseIPv6(address);
  const baseValue = base === undefined ? null : parseIPv6(base);
  if (addressValue === null || baseValue === null) return false;
  if (prefixLen === 0) return true;
  const hostBits = 128 - prefixLen;
  const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(hostBits)) - 1n);
  return (addressValue & mask) === (baseValue & mask);
}

/**
 * Classify an address as one of Tailscale's private ranges, or `null` if it
 * matches neither. Accepts a bare IPv4 or IPv6 literal (no CIDR suffix) —
 * exactly the shape `hosting_targets.address_v4`/`address_v6` store.
 *
 * An address that fails to parse as either family is not a Tailscale
 * address as far as this function is concerned — it returns `null` rather
 * than throwing, because malformed-address validation is a different
 * concern this predicate does not own.
 */
export function tailnetAddressKind(address: string): TailnetAddressKind | null {
  if (ipv4InCidr(address, TAILSCALE_CGNAT_V4_CIDR)) return "cgnat_v4";
  if (ipv6InCidr(address, TAILSCALE_ULA_V6_CIDR)) return "tailscale_ula_v6";
  return null;
}

/** `true` when `address` falls inside either Tailscale-private range. */
export function isPrivateTailnetAddress(address: string): boolean {
  return tailnetAddressKind(address) !== null;
}
