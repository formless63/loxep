/**
 * The provider write-authorization TIER vocabulary (Pangolin chain design,
 * milestone 3, `loxep-acj.3`, "The write-risk model" /
 * `apps/docs/.../architecture/pangolin-chain-design.md`).
 *
 * Owner rulings recorded 2026-08-15 (`pangolin-credential-constraints`
 * memory): writes are ADMIN-ONLY in Loxep; retirement is disable-never-delete
 * (confirmed); dynamic-IP alias updates MAY auto-apply, which is why the
 * policy is a FOUR-VALUE ordinal rather than a plain on/off switch — see
 * "Why four values, not two" below.
 *
 * ## Where this lives, and why `@loxep/domain` rather than `@loxep/infrastructure`
 *
 * `@loxep/infrastructure` depends on `@loxep/domain`, never the reverse, so
 * the vocabulary a REGISTERED SETTING'S schema needs (this module) and the
 * vocabulary a reconciler's write-gate needs (`@loxep/infrastructure`'s
 * `write-policy.ts`) must both be reachable from here. `apps/web`'s
 * connections surface needs the same tier list for its admin control, so one
 * definition, imported three ways, is what keeps the tier names from
 * drifting the way a duplicated literal union would.
 *
 * ## The four tiers, and how they map onto the design's operation tiers
 *
 * The design names four RISK tiers for a proxy WRITE OPERATION (0 read / 1
 * additive / 2 access-affecting / 3 lockout-class — see the design's "The
 * four tiers" table). This module's tiers are the CONNECTION-LEVEL POLICY,
 * named identically and compared ordinally against an operation's tier
 * (`@loxep/infrastructure`'s `assertWritePolicy`: `policyRank >=
 * operationTier`). `'read_only'` (rank 0) permits no write of any kind — the
 * shipped default, so a fresh install cannot write to any provider without an
 * explicit, audited flip. `'additive'` (rank 1) permits only create-shaped,
 * reversible operations. `'access_affecting'` (rank 2) additionally permits
 * mutating operations. `'lockout_class'` (rank 3) additionally permits the
 * operations the self-lockout preflight exists to gate — critically, setting
 * this tier does NOT bypass that preflight; the preflight has no policy
 * parameter at all (see that module's doc), so it refuses independently of
 * how permissive the connection's policy is.
 *
 * ## Why four values, not the bd draft's original two (`read_only`/`allow`)
 *
 * The design's own scope text for this milestone (before the owner's ruling)
 * named a binary flag. The owner's ruling on dynamic-IP auto-apply (M5, not
 * built here) requires the MODEL to support "a policy tier permitting scoped
 * auto-apply" — a connection an operator can leave in a state that allows
 * ONLY tier-1 additive writes (never a repoint, a disable, or anything
 * access-affecting) to run unattended. A binary switch cannot express that: it
 * is either "nothing may auto-apply" or "everything may", and the second is
 * exactly the blast radius M5's own design rules out. `'additive'` is that
 * scoped middle tier, built now so M5 has somewhere to point its `autoApply`
 * flag without reopening this model.
 */
import { z } from "zod";

/** Ordered least to most permissive — see the module doc's tier mapping. */
export const PROVIDER_WRITE_POLICY_TIERS = [
  "read_only",
  "additive",
  "access_affecting",
  "lockout_class",
] as const;

export type ProviderWritePolicyTier = (typeof PROVIDER_WRITE_POLICY_TIERS)[number];

/** Zod schema for one tier value — the setting's map values validate against this. */
export const providerWritePolicyTierSchema: z.ZodType<ProviderWritePolicyTier> =
  z.enum(PROVIDER_WRITE_POLICY_TIERS);

/** Ordinal rank, for `policyRank >= operationTier` comparisons. Never exported as a bare number elsewhere — always go through {@link providerWritePolicyTierRank}. */
const TIER_RANK: Record<ProviderWritePolicyTier, number> = {
  read_only: 0,
  additive: 1,
  access_affecting: 2,
  lockout_class: 3,
};

export function providerWritePolicyTierRank(tier: ProviderWritePolicyTier): number {
  return TIER_RANK[tier];
}

/** Operator-facing label, for the connections surface's admin control. */
export const PROVIDER_WRITE_POLICY_TIER_LABELS: Record<ProviderWritePolicyTier, string> =
  {
    read_only: "Read-only",
    additive: "Additive writes",
    access_affecting: "Access-affecting writes",
    lockout_class: "Lockout-class writes",
  };

/**
 * Honest, operator-facing copy per tier — what a connection may do at each
 * setting, written to be understood WITHOUT reading the design doc. Used by
 * the connections surface's write-policy control; kept here (not duplicated
 * in `apps/web`) so the model and the copy that explains it cannot drift.
 */
export const PROVIDER_WRITE_POLICY_TIER_DESCRIPTIONS: Record<
  ProviderWritePolicyTier,
  string
> = {
  read_only:
    "Loxep may only read from this connection. No create, update, or disable " +
    "call is ever made — the default for every connection.",
  additive:
    "Loxep may create new objects at this provider (a resource, a target, a " +
    "rule) but may never change or disable an existing one.",
  access_affecting:
    "Loxep may also change existing objects at this provider — including " +
    "updates that affect who or what can reach them. Every access-affecting " +
    "apply is from a shown plan, never a background sweep.",
  lockout_class:
    "Loxep may also apply changes that could remove the operator's own way " +
    "in — always behind a typed confirmation naming the object, and the " +
    "self-lockout preflight can still refuse regardless of this setting.",
};

/**
 * The connection ids the map has NO entry for read as `'read_only'` — the
 * setting's own empty-map default, resolved per connection. Mirrors
 * `resolveTailscaleIgnored`-style per-key resolution over a settings map (see
 * `tailscaleIgnoredDevicesSetting`'s precedent): the map is the source of
 * truth, this is just "look up one key with the right fallback" so every
 * caller does not re-derive the default.
 */
export function resolveProviderWritePolicy(
  policies: Readonly<Record<string, ProviderWritePolicyTier>>,
  connectionId: string,
): ProviderWritePolicyTier {
  return policies[connectionId] ?? "read_only";
}
