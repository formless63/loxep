/**
 * Dynamic-IP named aliases (Pangolin chain design milestone 5, `loxep-acj.5`,
 * "Dynamic IP: named aliases, fan-out, and never a silent apply").
 *
 * ## The primitive Pangolin does not have
 *
 * Pangolin has no alias / IP-group primitive a rule can reference (verified
 * against source and the maintainer's own answer — see the design's "API
 * verdict" section and `bd show loxep-acj.5`). So the alias is Loxep's own to
 * own, and it lives here: `@loxep/domain` because a REGISTERED SETTING'S
 * schema needs to be reachable from both `@loxep/infrastructure` (which
 * depends on `@loxep/domain`, never the reverse — the same layering
 * `provider-write-policy.ts`'s own module doc explains) and `apps/web`'s
 * settings/infrastructure surfaces.
 *
 * ## Where the address comes from
 *
 * Three detector sources, ranked by how much Loxep has to trust — see the
 * design's "Where the address comes from" section:
 *
 * - `manual` — the operator types it. Always available, always correct.
 * - `dns` — Loxep resolves a hostname the operator already maintains.
 * - `pangolin_site` — read the address Pangolin itself observes for a newt
 *   site (`PangolinSiteFact.endpoint`) — the best source when it exists,
 *   UNVERIFIED against a live read (open question 5; the design does not
 *   depend on it).
 *
 * Explicitly rejected: an external "what is my IP" HTTP service — a new
 * outbound dependency and a trust boundary on a value that becomes a
 * firewall rule.
 *
 * ## Reference, never literal
 *
 * A `proxy_resource_rules` row bound to an alias stores the STABLE REFERENCE
 * `alias:<name>` as its `value` — never the resolved literal — so the row's
 * own `proxy_resource_rules_natural_key_uq` (`proxy_resource_id, action,
 * match, value`) stays stable across every address change. Resolving the
 * reference into today's literal address happens at MATERIALIZATION time,
 * PURELY, in `@loxep/infrastructure` (which owns `MaterializationError` and
 * the provider-shaped types this needs) — this module only owns the setting
 * shape and the reference syntax, never the throwing resolution itself.
 */
import { z } from "zod";

/** Three detector sources, ranked by trust — see the module doc. */
export const IP_ALIAS_SOURCES = ["manual", "dns", "pangolin_site"] as const;
export type IpAliasSource = (typeof IP_ALIAS_SOURCES)[number];

/**
 * An alias NAME (the setting's own map key, and the identifier embedded in a
 * rule's `alias:<name>` reference). Lowercase, `[a-z0-9_-]`, starting with a
 * letter — safe to embed in a rule's `value` column and in a
 * `deduplicationKey` without escaping.
 */
export const ipAliasNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    "alias names must start with a lowercase letter and contain only lowercase letters, digits, '_' or '-'",
  );

/**
 * One alias's stored state. Keyed by name in the setting's own map (so
 * uniqueness is structural, the same choice `tailscaleIgnoredDevicesSetting`
 * and `providerWritePolicySetting` make over a bare array) — the design's own
 * sketch shows `name` as a sibling field of one list item; this module keeps
 * the name OUT of the value and IN the map key instead, for the identical
 * "can't drift" reason those two settings already keyed by identity.
 * PROVISIONAL shape choice, not a design requirement.
 */
export const ipAliasEntrySchema = z.strictObject({
  address: z.string().min(1),
  source: z.enum(IP_ALIAS_SOURCES),
  /** `source: 'dns'` only — the hostname to resolve. */
  hostname: z.string().min(1).nullable(),
  /**
   * `source: 'pangolin_site'` only — WHICH Pangolin connection to read the
   * site from. Not in the design's own sketch (which shows no connection
   * reference at all) but structurally required: a `pangolin_site` detector
   * has to resolve an adapter from *some* connection id, and Loxep may hold
   * several Pangolin connections (the design's own "multi-instance is
   * already solved" section). PROVISIONAL addition.
   */
  connectionId: z.string().min(1).nullable(),
  /** `source: 'pangolin_site'` only — which site, by Pangolin's own site id. */
  siteId: z.string().min(1).nullable(),
  previousAddress: z.string().min(1).nullable(),
  /** ISO instant the current `address` was last (re)observed by a detector run. */
  observedAt: z.string().min(1).nullable(),
  /** ISO instant the operator last created/edited this alias by hand. */
  confirmedAt: z.string().min(1).nullable(),
  /**
   * Off by default (design: "ships OFF"). When on, permits ONLY the ADD half
   * of an add-then-retire fan-out to apply from a `poll`-triggered detector
   * run — never retirement, and never for `source: 'manual'` (no detector to
   * trust) — enforced by the caller that reads this flag
   * (`@loxep/app`'s alias-detection sweep), not by this schema.
   */
  autoApply: z.boolean(),
});
export type IpAliasEntry = z.infer<typeof ipAliasEntrySchema>;

/** The setting's own value shape: alias name -> entry. */
export const ipAliasesSchema = z.record(ipAliasNameSchema, ipAliasEntrySchema);
export type IpAliasMap = z.infer<typeof ipAliasesSchema>;

/** The reference syntax a `proxy_resource_rules.value` carries for a dynamic-IP-owned rule. */
export const IP_ALIAS_REFERENCE_PREFIX = "alias:";

/** `alias:home` -> `home`; anything else (a literal, malformed input) -> `null`. Pure, never throws. */
export function parseIpAliasReference(value: string): string | null {
  if (!value.startsWith(IP_ALIAS_REFERENCE_PREFIX)) return null;
  const name = value.slice(IP_ALIAS_REFERENCE_PREFIX.length);
  return ipAliasNameSchema.safeParse(name).success ? name : null;
}

/** `home` -> `alias:home` — the inverse of {@link parseIpAliasReference}. */
export function formatIpAliasReference(name: string): string {
  return `${IP_ALIAS_REFERENCE_PREFIX}${name}`;
}

/**
 * A CIDR-shaped rule value for `name`'s CURRENT address — `<address>/32`, the
 * literal shape the design's own "two details the research pins down"
 * section names for a fan-out ADD rule. Does not validate `address` itself
 * (a detector's job); a malformed stored address surfaces as a rejected
 * Pangolin write, not a silent Loxep-side guess.
 */
export function ipAliasCidrValue(address: string): string {
  return `${address}/32`;
}
