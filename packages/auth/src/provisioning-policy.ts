/**
 * Account provisioning policy (ADR-0024, loxep-x2s).
 *
 * Who may become a Loxep user. Before this module existed, Loxep
 * auto-provisioned: any address that could receive a magic-link email and any
 * identity the OIDC issuer would authenticate became a `member` on first
 * sign-in, with no policy in between.
 *
 * ## The one rule that makes this lockout-proof
 *
 * Every control here governs account **creation** and nothing else. A user who
 * already exists always keeps their sign-in path — whatever the policy says,
 * whatever their email domain is. So a closed installation cannot shut its own
 * administrator out, and a mistyped domain allowlist cannot either.
 *
 * ## Why the policy shape is written twice
 *
 * The authoritative definition is `@loxep/domain`'s `authProvisioningSetting`
 * (Zod schema, description, default). This package cannot import it — its
 * dependencies are `@loxep/config`, `@loxep/db`, `better-auth`, `nodemailer`,
 * and it carries no Zod — so it reads the `application_settings` row directly,
 * exactly as `first-admin.ts` reads its own marker, through the TOTAL parser
 * below. {@link parseProvisioningPolicy} never throws and never rejects: any
 * field it cannot make sense of becomes the documented default. Drift between
 * the two statements of the shape can therefore only ever make this layer MORE
 * restrictive than the operator's stored value, never less.
 *
 * ## Enforcement points (both verified against better-auth 1.7.2)
 *
 *   1. `sendMagicLink` — the link is not sent at all when the address has no
 *      existing user and the policy declines it. `/sign-in/magic-link` returns
 *      `{status: true}` either way, so the endpoint is not an account-existence
 *      oracle.
 *   2. `databaseHooks.user.create.before` — the authoritative gate, reached by
 *      BOTH methods (`magicLinkVerify` → `internalAdapter.createUser`, and
 *      `/callback/:id` → `handleOAuthUserInfo` →
 *      `internalAdapter.createOAuthUser`), plus `/admin/create-user`, which is
 *      deliberately always allowed — it is the escape hatch a closed
 *      installation uses to add people.
 */
import type { DbHandle } from "@loxep/db";

/** `application_settings` key carrying the provisioning policy. */
export const AUTH_PROVISIONING_SETTING_KEY = "auth.provisioning";

/** Whether a sign-in method may create a new user. */
export type ProvisioningStance = "open" | "closed";

/** When an OIDC claim→`admin` mapping is applied. See ADR-0024 §6. */
export type ClaimApplyMoment = "create" | "every_sign_in";

export interface OidcAdminClaimPolicy {
  /** Dotted path into the id_token claims; `null` disables the mapping. */
  claim: string | null;
  /** Claim values meaning "administrator", matched case-insensitively. */
  adminValues: string[];
  applyOn: ClaimApplyMoment;
}

export interface AuthProvisioningPolicy {
  newUsers: { magicLink: ProvisioningStance; oidc: ProvisioningStance };
  /** Bare domains; empty means no restriction. */
  magicLinkEmailDomains: string[];
  oidcAdminClaim: OidcAdminClaimPolicy;
}

/**
 * The shipped default — closed for both methods, CONFIRMED by owner ruling
 * 2026-08-15 (`loxep-yk8`; see ADR-0024 §2). Mirrors `@loxep/domain`'s
 * `authProvisioningSetting.defaultValue`.
 */
export const DEFAULT_PROVISIONING_POLICY: AuthProvisioningPolicy = {
  newUsers: { magicLink: "closed", oidc: "closed" },
  magicLinkEmailDomains: [],
  oidcAdminClaim: { claim: null, adminValues: [], applyOn: "create" },
};

/** The sign-in method attempting to create a user. */
export type ProvisioningMethod = "magic_link" | "oidc" | "admin" | "unknown";

/**
 * Better Auth endpoint paths that create users. `context.path` on a database
 * hook is the DECLARED endpoint path (`api/dispatch.mjs` sets
 * `path: endpoint.path`), so these are template strings, not resolved URLs.
 */
export const MAGIC_LINK_VERIFY_PATH = "/magic-link/verify";
export const OAUTH_CALLBACK_PATH_PREFIX = "/callback";
export const ADMIN_CREATE_USER_PATH = "/admin/create-user";

/** Which method a `user.create.before` hook invocation belongs to. */
export function provisioningMethodForPath(
  path: string | null | undefined,
): ProvisioningMethod {
  if (typeof path !== "string" || path === "") return "unknown";
  if (path === MAGIC_LINK_VERIFY_PATH) return "magic_link";
  if (path.startsWith(OAUTH_CALLBACK_PATH_PREFIX)) return "oidc";
  if (path === ADMIN_CREATE_USER_PATH) return "admin";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Total parser
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stance(value: unknown, fallback: ProvisioningStance): ProvisioningStance {
  return value === "open" || value === "closed" ? value : fallback;
}

/** Non-blank trimmed strings only; anything else in the array is dropped. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

/**
 * Read a stored `auth.provisioning` value into a usable policy. TOTAL: never
 * throws, and substitutes {@link DEFAULT_PROVISIONING_POLICY} field by field
 * for anything malformed, so a hand-edited or half-migrated row degrades to
 * the safe stance rather than to an exception on the sign-in path.
 */
export function parseProvisioningPolicy(value: unknown): AuthProvisioningPolicy {
  if (!isRecord(value)) return DEFAULT_PROVISIONING_POLICY;

  const newUsers = isRecord(value["newUsers"]) ? value["newUsers"] : {};
  const claim = isRecord(value["oidcAdminClaim"]) ? value["oidcAdminClaim"] : {};
  const claimPath =
    typeof claim["claim"] === "string" && claim["claim"].trim() !== ""
      ? claim["claim"].trim()
      : null;

  return {
    newUsers: {
      magicLink: stance(
        newUsers["magicLink"],
        DEFAULT_PROVISIONING_POLICY.newUsers.magicLink,
      ),
      oidc: stance(newUsers["oidc"], DEFAULT_PROVISIONING_POLICY.newUsers.oidc),
    },
    magicLinkEmailDomains: stringList(value["magicLinkEmailDomains"]),
    oidcAdminClaim: {
      claim: claimPath,
      adminValues: stringList(claim["adminValues"]),
      applyOn: claim["applyOn"] === "every_sign_in" ? "every_sign_in" : "create",
    },
  };
}

// ---------------------------------------------------------------------------
// Database reads
// ---------------------------------------------------------------------------

/** The installation's stored policy, or the default when no row exists. */
export async function readProvisioningPolicy(
  handle: DbHandle,
): Promise<AuthProvisioningPolicy> {
  const row = await handle.db.query.applicationSettings.findFirst({
    columns: { value: true },
    where: (table, { eq }) => eq(table.key, AUTH_PROVISIONING_SETTING_KEY),
  });
  return parseProvisioningPolicy(row?.value);
}

/**
 * Whether the installation has at least one administrator.
 *
 * This — not ADR-0016's `auth.first_admin_bootstrap` marker — is what closes
 * the bootstrap window. An installation that never sets
 * `LOXEP_BOOTSTRAP_ADMIN_EMAIL` never writes that marker, so a marker-keyed
 * window would never close and the stored policy would be permanently inert.
 * Keyed on the admin row, every path that produces a first administrator
 * (bootstrap email, `loxep admin promote`, an OIDC claim mapping) closes the
 * window behind itself, and no path can brick a deployment.
 *
 * The role column is the admin plugin's comma-separated convention, so this
 * matches `admin` as a whole list entry rather than as a substring.
 */
export async function installationHasAdmin(handle: DbHandle): Promise<boolean> {
  const result = await handle.pool.query<{ exists: boolean }>(
    `select exists (
       select 1 from "user"
       where role is not null
         and 'admin' = any (string_to_array(replace(role, ' ', ''), ','))
     ) as exists`,
  );
  return result.rows[0]?.exists === true;
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/** Lowercased domain part of an email address, or `null` when unparseable. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * Whether `email` may create an account under `domains`. An empty list means
 * no restriction. Matching is case-insensitive and EXACT — `example.com` does
 * not cover `sub.example.com` (ADR-0024 §5).
 */
export function emailDomainAllowed(email: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const domain = emailDomain(email);
  if (domain === null) return false;
  return domains.some((allowed) => allowed.trim().toLowerCase() === domain);
}

/** Why a creation attempt was declined — for logs and tests, never for the browser. */
export type ProvisioningDenialReason =
  | "method_closed"
  | "email_domain_not_allowed";

export type ProvisioningDecision =
  | { allowed: true }
  | { allowed: false; reason: ProvisioningDenialReason };

const ALLOWED: ProvisioningDecision = { allowed: true };

export interface ProvisioningDecisionInput {
  method: ProvisioningMethod;
  /** The address being provisioned; `undefined` when the path carries none. */
  email?: string | undefined;
  policy: AuthProvisioningPolicy;
  /** False → the bootstrap window is open and everything is permitted. */
  installationHasAdmin: boolean;
}

/**
 * The single decision both enforcement points share.
 *
 * `admin` is always allowed: `/admin/create-user` runs this same hook, and it
 * is precisely the escape hatch a closed installation uses to add people.
 * `unknown` — no recognizable path, or a null hook context — is blocked only
 * when BOTH methods are closed; with the shipped plugin set there is no other
 * user-creating endpoint, so this is a guard rather than a live path.
 */
export function decideProvisioning(
  input: ProvisioningDecisionInput,
): ProvisioningDecision {
  const { method, email, policy } = input;

  // Bootstrap window: an installation with no administrator must be able to
  // acquire its first one, whatever the stored policy says (ADR-0024 §2).
  if (!input.installationHasAdmin) return ALLOWED;
  if (method === "admin") return ALLOWED;

  if (method === "magic_link") {
    if (policy.newUsers.magicLink === "closed") {
      return { allowed: false, reason: "method_closed" };
    }
    if (
      email !== undefined &&
      !emailDomainAllowed(email, policy.magicLinkEmailDomains)
    ) {
      return { allowed: false, reason: "email_domain_not_allowed" };
    }
    return ALLOWED;
  }

  if (method === "oidc") {
    return policy.newUsers.oidc === "closed"
      ? { allowed: false, reason: "method_closed" }
      : ALLOWED;
  }

  const bothClosed =
    policy.newUsers.magicLink === "closed" && policy.newUsers.oidc === "closed";
  return bothClosed ? { allowed: false, reason: "method_closed" } : ALLOWED;
}

/** Whether a user with this email already exists (case-insensitively). */
export async function userExistsForEmail(
  handle: DbHandle,
  email: string,
): Promise<boolean> {
  const result = await handle.pool.query(
    `select 1 from "user" where lower(email) = lower($1) limit 1`,
    [email],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Layer 1: may a magic link be delivered to `email`?
 *
 * An existing user always may — the rule that keeps this feature
 * lockout-proof. An unknown address is subject to the full provisioning
 * decision, because delivering a link that could never be redeemed would
 * both be pointless and turn the endpoint into an unauthenticated "make this
 * server email a stranger" primitive.
 */
export async function mayDeliverMagicLink(
  handle: DbHandle,
  email: string,
): Promise<ProvisioningDecision> {
  if (await userExistsForEmail(handle, email)) return ALLOWED;
  const [policy, hasAdmin] = await Promise.all([
    readProvisioningPolicy(handle),
    installationHasAdmin(handle),
  ]);
  return decideProvisioning({
    method: "magic_link",
    email,
    policy,
    installationHasAdmin: hasAdmin,
  });
}

/**
 * Layer 2: may this user row be created?
 *
 * Called from `databaseHooks.user.create.before` with the hook context's
 * `path`. Reads the policy per request on purpose — a cached provisioning
 * policy is exactly the thing this feature must not ship.
 */
export async function mayCreateUser(
  handle: DbHandle,
  input: { path: string | null | undefined; email: string | undefined },
): Promise<ProvisioningDecision> {
  const method = provisioningMethodForPath(input.path);
  if (method === "admin") return ALLOWED;
  const [policy, hasAdmin] = await Promise.all([
    readProvisioningPolicy(handle),
    installationHasAdmin(handle),
  ]);
  return decideProvisioning({
    method,
    email: input.email,
    policy,
    installationHasAdmin: hasAdmin,
  });
}
