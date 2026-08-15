/**
 * OIDC claim → `admin` role mapping (ADR-0024 §6, loxep-x2s).
 *
 * An installation whose identity provider already knows who the
 * administrators are should not have to re-designate them by hand in Loxep.
 * This module reads one operator-named claim out of the OIDC id_token and maps
 * it onto the deployment role — `admin` only, because ADR-0017's two-role model
 * makes this a predicate, not a role table.
 *
 * ## Where the claims come from
 *
 * From `account.idToken` — the JWT Better Auth persisted during the OAuth
 * callback and refreshes on every subsequent sign-in (`oauth2/link-account.mjs`
 * `updateAccount`). The payload is decoded, not verified: it is the token the
 * callback already validated, read back out of Loxep's own row. Nothing else
 * trusts it.
 *
 * The alternative source, `mapProfileToUser`, sees a richer merged profile but
 * is handed no user id and no request context, so reaching the role write from
 * there would need a request-scoped side channel. See ADR-0024's rejected
 * alternatives.
 *
 * **Known limitation:** Loxep requests `openid profile email` only, so a claim
 * an issuer emits only under an extra scope is invisible here and the mapping
 * silently does nothing. Likewise when `account.idToken` is absent (an issuer
 * whose user info came from the userinfo endpoint instead).
 *
 * ## Precedence
 *
 * first-admin bootstrap > claim mapping > the stored role.
 *
 *   - `applyOn: 'create'` (default) runs once, from
 *     `databaseHooks.account.create.after`, and can only ever GRANT admin. Every
 *     later sign-in leaves the role exactly as Loxep last set it, so a
 *     deliberate promotion or demotion inside Loxep is permanent.
 *   - `applyOn: 'every_sign_in'` runs from `session.create.after`, AFTER
 *     `runFirstAdminBootstrap`, and both grants and revokes. Two guards
 *     survive that choice: it is skipped entirely for the session in which the
 *     bootstrap grant just happened (otherwise a claim-less bootstrap admin
 *     would be demoted by the same request that promoted them, and the
 *     deployment could never be bootstrapped), and it never demotes the only
 *     remaining administrator.
 */
import type { DbHandle } from "@loxep/db";
import type { AuthProvisioningPolicy, OidcAdminClaimPolicy } from "./provisioning-policy.ts";
import { sessionRoles } from "./roles.ts";

/**
 * Decode a JWT payload without verifying it. Returns `null` for anything that
 * is not a three-part token carrying a JSON object — a malformed id_token must
 * degrade to "no claims", never to an exception on the sign-in path.
 */
export function decodeIdTokenClaims(
  idToken: string | null | undefined,
): Record<string, unknown> | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === undefined || payload === "") return null;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a dotted claim path (`groups`, `realm_access.roles`) against decoded
 * claims. Returns `undefined` when any segment is missing.
 */
export function resolveClaimPath(
  claims: Record<string, unknown>,
  path: string,
): unknown {
  const segments = path.split(".").filter((segment) => segment !== "");
  if (segments.length === 0) return undefined;
  let current: unknown = claims;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Every comparable token a claim value carries.
 *
 * An array yields its entries; a plain string yields both the whole trimmed
 * value AND its whitespace-separated tokens, so both `"loxep-admins"` and the
 * space-delimited convention (`"users loxep-admins"`) match without the
 * operator having to know which one their issuer uses. Numbers and booleans
 * are stringified; anything else is ignored.
 */
export function claimTokens(value: unknown): string[] {
  const out: string[] = [];
  const push = (candidate: unknown): void => {
    if (typeof candidate === "number" || typeof candidate === "boolean") {
      out.push(String(candidate));
      return;
    }
    if (typeof candidate !== "string") return;
    const trimmed = candidate.trim();
    if (trimmed === "") return;
    out.push(trimmed);
    for (const token of trimmed.split(/\s+/u)) {
      if (token !== "" && token !== trimmed) out.push(token);
    }
  };
  if (Array.isArray(value)) {
    for (const entry of value) push(entry);
  } else {
    push(value);
  }
  return out;
}

/** Whether the decoded claims designate an administrator under `policy`. */
export function claimGrantsAdmin(
  claims: Record<string, unknown> | null,
  policy: OidcAdminClaimPolicy,
): boolean {
  if (claims === null) return false;
  if (policy.claim === null || policy.adminValues.length === 0) return false;
  const tokens = claimTokens(resolveClaimPath(claims, policy.claim)).map((token) =>
    token.toLowerCase(),
  );
  if (tokens.length === 0) return false;
  return policy.adminValues.some((value) =>
    tokens.includes(value.trim().toLowerCase()),
  );
}

/** Whether the claim mapping is configured at all. */
export function claimMappingEnabled(policy: AuthProvisioningPolicy): boolean {
  const claim = policy.oidcAdminClaim;
  return claim.claim !== null && claim.adminValues.length > 0;
}

export type ClaimRoleOutcome =
  | "not_configured"
  | "no_oidc_account"
  | "no_claims"
  | "unchanged"
  | "promoted"
  | "demoted"
  | "demotion_skipped_last_admin"
  | "skipped_create_only";

export interface ApplyClaimRoleInput {
  userId: string;
  policy: AuthProvisioningPolicy;
  /**
   * Which hook is calling. `create` runs only when the policy says `create`;
   * `sign_in` runs only when the policy says `every_sign_in`.
   */
  moment: "create" | "sign_in";
  /** The OIDC provider id under which accounts are stored. */
  providerId: string;
}

/**
 * Apply the mapping for one user. Idempotent, and safe to call on every
 * sign-in: it reads the current role and writes only on an actual change.
 *
 * Writes `user.role` directly, as `runFirstAdminBootstrap` already does — a
 * database hook has no session with which to call `auth.api.setRole`, and the
 * write is confined to these two audited places.
 */
export async function applyOidcClaimRole(
  handle: DbHandle,
  input: ApplyClaimRoleInput,
): Promise<ClaimRoleOutcome> {
  const { policy, moment, userId, providerId } = input;
  if (!claimMappingEnabled(policy)) return "not_configured";

  const wantsCreate = policy.oidcAdminClaim.applyOn === "create";
  if (wantsCreate !== (moment === "create")) return "skipped_create_only";

  const account = await handle.db.query.account.findFirst({
    columns: { idToken: true },
    where: (table, { and, eq }) =>
      and(eq(table.userId, userId), eq(table.providerId, providerId)),
  });
  if (!account) return "no_oidc_account";

  const claims = decodeIdTokenClaims(account.idToken);
  if (claims === null) return "no_claims";

  const shouldBeAdmin = claimGrantsAdmin(claims, policy.oidcAdminClaim);

  const user = await handle.db.query.user.findFirst({
    columns: { id: true, role: true },
    where: (table, { eq }) => eq(table.id, userId),
  });
  if (!user) return "no_oidc_account";
  const isAdmin = sessionRoles({ user: { role: user.role } }).includes("admin");

  if (shouldBeAdmin === isAdmin) return "unchanged";

  if (shouldBeAdmin) {
    await handle.pool.query(`update "user" set role = 'admin' where id = $1`, [
      userId,
    ]);
    return "promoted";
  }

  // `create` is GRANT-ONLY. In practice `account.create.after` only ever sees a
  // brand-new user, but the rule belongs in the function rather than in the
  // caller: this is the guarantee that a deliberate promotion inside Loxep is
  // never undone by an IdP that says nothing about roles.
  if (wantsCreate) return "unchanged";

  // Demotion (`every_sign_in` only): never leave the installation with no
  // administrator.
  const remaining = await handle.pool.query<{ count: string }>(
    `select count(*)::text as count from "user"
      where id <> $1
        and role is not null
        and 'admin' = any (string_to_array(replace(role, ' ', ''), ','))`,
    [userId],
  );
  if (Number(remaining.rows[0]?.count ?? "0") === 0) {
    return "demotion_skipped_last_admin";
  }
  await handle.pool.query(`update "user" set role = 'member' where id = $1`, [
    userId,
  ]);
  return "demoted";
}
