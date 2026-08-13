/**
 * `materializeDesiredRecords` — a PURE function from intent to desired records.
 *
 * ```text
 * (domain, apex target and its fronting chain, mail state, CAA policy)
 *     -> DesiredRecord[]
 * ```
 *
 * It touches no network and no database. That is not an accident of
 * implementation: this is where the subtle bugs live, and a pure function is
 * cheap to test exhaustively. The design's pre-implementation checklist puts
 * these tests **before** this file, and `test/materialize.test.ts` covers the
 * four cases it names — the fronting-node hop, mail records never proxied,
 * manual records passed through untouched, and the mail-only domain shape.
 *
 * ## The rules, and which of them are load-bearing
 *
 * ```text
 * apex target set     A/AAAA @ -> resolved address, proxied = apex_proxied
 *                     A/AAAA * -> resolved address, proxied = wildcard_proxied
 *                     owner 'apex' / 'wildcard'
 *
 * mail enabled and    the mail provider's required set, ALL unproxied,
 *   registered        owner 'mail'          (milestone 2 supplies the set)
 *
 * CAA policy          only once the operator has REVIEWED it (open question 2)
 *   reviewed          owner 'caa'
 *
 * manual records      passed through untouched: never emitted, never
 *                     rewritten, never deleted
 * ```
 *
 * Three of those are the ones that bite:
 *
 * 1. **Resolution walks the fronting chain, and a broken chain is an ERROR,
 *    not a fallback.** When a domain targets a tunnel-connected host, the
 *    address record must point at the fronting node's address — the origin is
 *    reachable only through the tunnel and may have no public address at all.
 *    Silently emitting the origin's address publishes the exact thing the
 *    tunnel exists to hide, and it presents as a DNS propagation problem for
 *    as long as it takes somebody to check.
 * 2. **Mail records are never proxied.** Enforced here AND by a `CHECK`, both.
 *    Proxying a mail provider's key-publication CNAME makes the DNS provider
 *    answer with its own addresses instead of resolving through to the key:
 *    mail keeps flowing, signature alignment quietly fails, and the symptom is
 *    a deliverability problem discovered weeks later.
 * 3. **No CAA record is emitted until the policy has been reviewed.** Open
 *    question 2 is OWNER-REVIEW-CRITICAL and resolved PROVISIONAL with no
 *    default issuer list. A wrong CAA record breaks certificate renewal
 *    silently, at expiry.
 *
 * And one that only *looks* like a problem: **explicit records win over the
 * wildcard**, so a mail provider's CNAMEs coexist with a wildcard address
 * record with no special handling at all. It is a test rather than a code
 * path, because DNS resolution already works that way.
 */
import { MaterializationError } from "./errors.ts";

/** A hosting target as materialization sees it. */
export interface HostingTargetNode {
  id: string;
  name: string;
  controlSurface: "proxy_node" | "tunnel_client" | "direct_reverse_proxy" | "none";
  addressV4: string | null;
  addressV6: string | null;
  frontedByTargetId: string | null;
}

/** The installation's CAA issuance policy (`infrastructure.caa_policy`). */
export interface CaaPolicy {
  reviewed: boolean;
  issuers: readonly string[];
  wildcardIssuers: readonly string[];
  iodef: string | null;
}

/** One record the materializer decided should exist. */
export interface DesiredRecord {
  type: string;
  /** Zone-relative, matching `dns_records.name`. */
  name: string;
  content: string;
  ttlSeconds: number | null;
  priority: number | null;
  proxied: boolean;
  owner: "apex" | "wildcard" | "caa" | "mail" | "proxy_resource";
}

export interface MaterializeInput {
  domain: {
    name: string;
    apexTargetId: string | null;
    apexProxied: boolean;
    wildcardProxied: boolean;
    mailEnabled: boolean;
  };
  /** Every target that could appear in a fronting chain, by id. */
  targets: ReadonlyMap<string, HostingTargetNode>;
  caaPolicy: CaaPolicy;
  /**
   * The mail provider's required record set, already normalized by the mail
   * adapter. `null` means mail is not registered yet. Milestone 2 supplies
   * this; milestone 1 always passes `null`, and the design is explicit that no
   * mail record set may be carried forward from any draft — including its own.
   */
  mailRecords: ReadonlyArray<{
    type: string;
    name: string;
    content: string;
    ttlSeconds?: number | null;
    priority?: number | null;
  }> | null;
  /** What the provider can actually do, so degradation is loud, not silent. */
  capabilities: {
    proxying: boolean;
    proxiedWildcards: boolean;
    proxiableTypes: readonly string[];
  };
}

/** The address a name should point at, and which target supplied it. */
export interface ResolvedHostingAddress {
  addressV4: string | null;
  addressV6: string | null;
  /** The target the address came from — the fronting node for a tunnel client. */
  sourceTargetId: string;
  /** How many fronting hops were walked. Zero for a directly-addressed target. */
  hops: number;
}

const MAX_FRONTING_HOPS = 8;

/**
 * Walk `fronted_by_target_id` to the target that actually answers for a name.
 *
 * A `tunnel_client` ALWAYS resolves through its fronting node, even when it
 * has an address of its own — that address is the origin's, and publishing it
 * is the bug this function exists to prevent.
 *
 * The design notes that PostgreSQL can only block the trivial self-loop
 * declaratively; a longer cycle is a service concern. This walk bounds itself
 * and reports a cycle as an error rather than looping.
 */
export function resolveHostingAddress(
  target: HostingTargetNode,
  targets: ReadonlyMap<string, HostingTargetNode>,
): ResolvedHostingAddress {
  const seen = new Set<string>([target.id]);
  let current = target;
  let hops = 0;

  while (current.controlSurface === "tunnel_client") {
    const nextId = current.frontedByTargetId;
    if (nextId === null) {
      throw new MaterializationError(
        `hosting target "${current.name}" is a tunnel client with no fronting node`,
        { targetId: current.id },
      );
    }
    if (seen.has(nextId)) {
      throw new MaterializationError(
        `hosting target "${current.name}" is part of a fronting cycle`,
        { targetId: current.id, frontedByTargetId: nextId },
      );
    }
    const next = targets.get(nextId);
    if (next === undefined) {
      throw new MaterializationError(
        `hosting target "${current.name}" is fronted by a target that was not supplied`,
        { targetId: current.id, frontedByTargetId: nextId },
      );
    }
    seen.add(nextId);
    current = next;
    hops += 1;
    if (hops > MAX_FRONTING_HOPS) {
      throw new MaterializationError(
        `hosting target "${target.name}" exceeded the fronting hop limit`,
        { targetId: target.id, hops },
      );
    }
  }

  if (current.addressV4 === null && current.addressV6 === null) {
    // The failure the design insists must NOT fall back to the origin.
    throw new MaterializationError(
      `hosting target "${current.name}" has no address to publish`,
      { targetId: current.id, resolvedFrom: target.id, hops },
    );
  }

  return {
    addressV4: current.addressV4,
    addressV6: current.addressV6,
    sourceTargetId: current.id,
    hops,
  };
}

/**
 * Render one CAA record's content in RFC 8659 presentation format:
 * `<flags> <tag> "<value>"`.
 */
export function caaContent(tag: string, value: string): string {
  return `0 ${tag} "${value}"`;
}

/** The CAA record set, or an empty array while the policy is unreviewed. */
export function materializeCaaRecords(policy: CaaPolicy): DesiredRecord[] {
  if (!policy.reviewed) return [];
  const records: DesiredRecord[] = [];
  const push = (tag: string, value: string): void => {
    records.push({
      type: "CAA",
      name: "@",
      content: caaContent(tag, value),
      ttlSeconds: null,
      priority: null,
      // CAA is not an address record and is not proxiable anywhere.
      proxied: false,
      owner: "caa",
    });
  };
  for (const issuer of policy.issuers) push("issue", issuer);
  for (const issuer of policy.wildcardIssuers) push("issuewild", issuer);
  if (policy.iodef !== null) push("iodef", policy.iodef);
  return records;
}

function assertProxyingSupported(
  proxied: boolean,
  input: MaterializeInput,
  what: "apex" | "wildcard",
  type: string,
): void {
  if (!proxied) return;
  if (!input.capabilities.proxying) {
    throw new MaterializationError(
      `the DNS provider for "${input.domain.name}" cannot proxy records, but ${what} proxying is intended`,
      { domain: input.domain.name, what },
    );
  }
  if (what === "wildcard" && !input.capabilities.proxiedWildcards) {
    throw new MaterializationError(
      `the DNS provider for "${input.domain.name}" cannot proxy WILDCARD records, but wildcard proxying is intended`,
      { domain: input.domain.name },
    );
  }
  if (!input.capabilities.proxiableTypes.includes(type)) {
    throw new MaterializationError(
      `the DNS provider for "${input.domain.name}" cannot proxy a ${type} record`,
      { domain: input.domain.name, type },
    );
  }
}

/**
 * The whole desired-record set for one domain.
 *
 * Manual records are NOT an input and NOT an output: they live in
 * `dns_records` with `owner = 'manual'` and the reconciler passes over them
 * entirely. Making them absent from this function's signature is the
 * structural version of "the reconciler never rewrites them" — there is no
 * code path here that could.
 */
export function materializeDesiredRecords(
  input: MaterializeInput,
): DesiredRecord[] {
  const records: DesiredRecord[] = [];
  const { domain } = input;

  if (domain.apexTargetId !== null) {
    const target = input.targets.get(domain.apexTargetId);
    if (target === undefined) {
      throw new MaterializationError(
        `domain "${domain.name}" points at a hosting target that was not supplied`,
        { domain: domain.name, apexTargetId: domain.apexTargetId },
      );
    }
    if (target.controlSurface === "none") {
      throw new MaterializationError(
        `domain "${domain.name}" points at hosting target "${target.name}", whose control surface is 'none'`,
        { domain: domain.name, targetId: target.id },
      );
    }

    const resolved = resolveHostingAddress(target, input.targets);
    const pairs: Array<["A" | "AAAA", string | null]> = [
      ["A", resolved.addressV4],
      ["AAAA", resolved.addressV6],
    ];

    for (const [type, address] of pairs) {
      if (address === null) continue;
      assertProxyingSupported(domain.apexProxied, input, "apex", type);
      records.push({
        type,
        name: "@",
        content: address,
        ttlSeconds: null,
        priority: null,
        proxied: domain.apexProxied,
        owner: "apex",
      });
      assertProxyingSupported(domain.wildcardProxied, input, "wildcard", type);
      records.push({
        type,
        name: "*",
        content: address,
        ttlSeconds: null,
        priority: null,
        proxied: domain.wildcardProxied,
        owner: "wildcard",
      });
    }
  }

  if (domain.mailEnabled && input.mailRecords !== null) {
    for (const record of input.mailRecords) {
      records.push({
        type: record.type,
        name: record.name,
        content: record.content,
        ttlSeconds: record.ttlSeconds ?? null,
        priority: record.priority ?? null,
        // Not "whatever was passed in". Unconditional, because this is the
        // invariant whose violation is invisible for weeks.
        proxied: false,
        owner: "mail",
      });
    }
  }

  records.push(...materializeCaaRecords(input.caaPolicy));

  return records;
}
