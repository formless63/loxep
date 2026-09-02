/**
 * Runtime Better Auth factory (ADR-0007, ADR-0016, ADR-0017, ADR-0020).
 *
 * `createAuth()` builds the real Better Auth instance from bootstrap
 * configuration and a database handle. Construction is explicit — importing
 * this package never constructs an instance as an import side effect — and
 * `secret`/`baseURL` come from `@loxep/config`, so no `BETTER_AUTH_*`
 * environment variables are required in any environment.
 *
 * The plugin set and password policy are shared with CLI schema generation
 * through `buildAuthPluginConfig()` (`@loxep/db`), so the runtime instance
 * can never drift from the generated, checked-in auth schema (ADR-0020).
 */
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { GenericOAuthConfig } from "better-auth/plugins";
import { DEFAULT_OIDC_EMAIL_CLAIM } from "@loxep/config";
import type { BootstrapConfig, OidcBootstrapConfig } from "@loxep/config";
import { buildAuthPluginConfig, schema } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { runFirstAdminBootstrap } from "./first-admin.ts";
import {
  createSmtpMagicLinkSender,
  type SendMagicLinkEmail,
} from "./magic-link-email.ts";
import { applyOidcClaimRole, claimMappingEnabled } from "./oidc-claim-roles.ts";
import {
  mayCreateUser,
  mayDeliverMagicLink,
  provisioningMethodForPath,
  readProvisioningPolicy,
} from "./provisioning-policy.ts";

/**
 * `providerId` under which the bootstrap-configured OIDC provider registers
 * with Better Auth's generic OAuth plugin. Loxep supports exactly one
 * bootstrap OIDC provider, addressed generically — Pocket ID works as a plain
 * OIDC issuer with nothing provider-specific. Sign-in uses
 * `POST /api/auth/sign-in/social` with this providerId; the callback URL to
 * register with the IdP is `<publicOrigin>/api/auth/callback/oidc`.
 */
export const OIDC_PROVIDER_ID = "oidc";

/**
 * Better Auth 1.7 account namespace for the bootstrap OIDC provider.
 *
 * 1.6 recognized accounts by `(providerId, accountId)`. Keeping this stable,
 * synthetic issuer makes the new `(issuer, accountId)` key preserve that
 * identity instead of silently re-keying an existing installation to the
 * discovery document's issuer during its first post-upgrade sign-in. The
 * append-only database migration uses this same value.
 */
export const OIDC_ACCOUNT_ISSUER = "local:oauth:oidc";

/** First non-blank string in `values`, trimmed; `undefined` when there is none. */
function firstNonBlank(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Read `profile[emailClaim]` as the email address for account creation,
 * overriding Better Auth's own `userInfo.email` read (loxep-yk8,
 * `LOXEP_OIDC_EMAIL_CLAIM`, default {@link DEFAULT_OIDC_EMAIL_CLAIM}).
 *
 * Deliberately does nothing when `emailClaim` IS the standard claim — there
 * is no reason to duplicate what Better Auth's own `getUserInfo` already
 * reads, and the shipped default must behave byte-for-byte as it did before
 * this override existed. When `emailClaim` names a custom claim and the
 * profile has no non-blank string under it, this returns `undefined` and lets
 * Better Auth's own fallback (`userInfo.email`, the standard claim) and its
 * own `email_is_missing` redirect take over — a legible failure rather than a
 * silent one, and one Loxep does not have to reinvent.
 */
export function resolveOidcEmailClaim(
  profile: Record<string, unknown>,
  emailClaim: string,
): string | undefined {
  if (emailClaim === DEFAULT_OIDC_EMAIL_CLAIM) return undefined;
  const raw = profile[emailClaim];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Seed Loxep's additional `user` columns from standard OIDC claims, and — when
 * `emailClaim` names a non-standard claim — the email address itself.
 *
 * Better Auth's generic OAuth provider already maps the standard `name` and
 * `picture` claims onto `user.name` / `user.image` with no help from us (see
 * its `getUserInfo`, which reads them from the id_token and from the userinfo
 * endpoint). What it cannot know is which claim means "display name", so this
 * hook supplies it:
 *
 *   - `nickname` — OIDC Core's "casual name of the End-User"; the closest
 *     standard claim to a chosen display name;
 *   - `preferred_username` — the fallback Pocket ID and most IdPs populate;
 *   - `given_name` — last resort, so "Alex Rivera" still gets "Alex"
 *     rather than nothing.
 *
 * `emailClaim` defaults to `"email"` — OIDC's own standard claim, which
 * Better Auth already reads on its own — so a deployment that never sets
 * `LOXEP_OIDC_EMAIL_CLAIM` gets exactly the pre-existing behavior. See
 * {@link resolveOidcEmailClaim} for the override itself.
 *
 * Extra keys returned here flow through Better Auth's
 * `parseAdditionalUserInputFromProviderProfile` into the declared
 * `user.additionalFields` (`@loxep/db` `userAdditionalFields`), and (for
 * `email`) into `oAuth2Callback`'s `mapUser.email ?? userInfo.email` read
 * (`generic-oauth/routes.mjs`) — the same mechanism that already lets this
 * hook's `displayName` win.
 *
 * **This never overwrites an in-app override.** `overrideUserInfo` is left at
 * its default (`false`), so Better Auth applies provider profile values only
 * when it *creates* the user; every later sign-in leaves `name`, `image`,
 * `displayName`, and `email` exactly as Loxep last set them.
 */
export function mapOidcProfileToUser(
  profile: Record<string, unknown>,
  emailClaim: string = DEFAULT_OIDC_EMAIL_CLAIM,
): Record<string, unknown> {
  const displayName = firstNonBlank(
    profile["nickname"],
    profile["preferred_username"],
    profile["given_name"],
  );
  const email = resolveOidcEmailClaim(profile, emailClaim);
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(email === undefined ? {} : { email }),
  };
}

/**
 * Generic OAuth entry for the bootstrap OIDC issuer. Everything is derived
 * from the issuer's OIDC discovery document
 * (`<issuer>/.well-known/openid-configuration`); PKCE is enabled as OIDC
 * best practice.
 */
export function buildOidcProviderConfig(
  oidc: OidcBootstrapConfig,
): GenericOAuthConfig {
  return {
    providerId: OIDC_PROVIDER_ID,
    discoveryUrl: `${oidc.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    scopes: ["openid", "profile", "email"],
    pkce: true,
    accountIssuer: OIDC_ACCOUNT_ISSUER,
    requireIdTokenVerification: true,
    // Standard `name`/`picture` claims are mapped by the plugin itself; this
    // adds Loxep's `displayName` and, when `emailClaim` names a non-standard
    // claim (LOXEP_OIDC_EMAIL_CLAIM), the email address itself. Deliberately
    // no `overrideUserInfo`: provider values seed the user at creation and
    // never re-sync after.
    mapProfileToUser: (profile) => mapOidcProfileToUser(profile, oidc.emailClaim),
  };
}

export interface CreateAuthOptions {
  /** Bootstrap configuration (`loadBootstrapConfig()`), web-serving mode. */
  config: BootstrapConfig;
  /** Database handle from `@loxep/db` `createDb()`. */
  db: DbHandle;
  /**
   * Magic-link delivery override. Defaults to a real nodemailer SMTP sender
   * built from `config.smtp`; tests inject a capturing implementation.
   */
  sendMagicLinkEmail?: SendMagicLinkEmail | undefined;
}

/**
 * Construct the runtime Better Auth instance.
 *
 * - drizzle adapter over the checked-in auth schema (ADR-0020);
 * - `secret`/`baseURL`/`trustedOrigins` from bootstrap config — no
 *   `BETTER_AUTH_*` env needed, including under NODE_ENV=production;
 * - email+password disabled; magic-link via SMTP; generic OIDC when
 *   configured (ADR-0007);
 * - admin plugin with roles `admin`/`member`, default `member` (ADR-0017);
 * - first-admin bootstrap installed as a `session.create.after` database
 *   hook so every successful sign-in path is covered (ADR-0016);
 * - account provisioning policy enforced at `sendMagicLink` and at
 *   `databaseHooks.user.create.before`, and the OIDC claim→role mapping at
 *   `account.create.after` / `session.create.after` (ADR-0024).
 *
 * Every policy hook lives HERE rather than in a web-layer caller for the
 * reason `first-admin.ts` already gives about the bootstrap grant: `/api/auth/*`
 * is a catch-all mount, so a rule a caller can forget is a rule that can be
 * bypassed.
 */
export function createAuth({ config, db, sendMagicLinkEmail }: CreateAuthOptions) {
  const { authSecret, publicOrigin } = config;
  if (authSecret === undefined) {
    throw new Error(
      "createAuth requires config.authSecret — set LOXEP_AUTH_SECRET (web/all mode bootstrap config)",
    );
  }
  if (publicOrigin === undefined) {
    throw new Error(
      "createAuth requires config.publicOrigin — set LOXEP_PUBLIC_ORIGIN (web/all mode bootstrap config)",
    );
  }

  const sender =
    sendMagicLinkEmail ??
    (config.smtp ? createSmtpMagicLinkSender(config.smtp) : undefined);
  const bootstrapAdminEmail = config.bootstrapAdminEmail;

  // Session freshness (loxep-u8c A18): deliberately no `session` block here —
  // `expiresIn`/`updateAge` stay at Better Auth's defaults and
  // `cookieCache` stays OFF (its own default). Verified against the
  // installed better-auth 1.7.2 dist:
  //   - `cookieCache` is opt-in and off by default, so `auth.api.getSession()`
  //     already re-reads `session` AND `user` (hence `role`/`banned`) from
  //     PostgreSQL on every call — enabling it would be the regression here,
  //     not the fix: a cached cookie would keep serving a just-revoked role
  //     for up to `cookieCache.maxAge`.
  //   - The admin plugin's `banned` check only runs in
  //     `session.create.before` (sign-in time, `admin.mjs`) — it does NOT
  //     re-validate already-issued sessions, which is why a ban must
  //     explicitly revoke sessions to take effect immediately. The admin
  //     plugin's own `/admin/ban-user` route already does this
  //     (`internalAdapter.deleteUserSessions`, `routes.mjs:303`), and
  //     `setUserRole` (`apps/web/src/server/admin-functions.ts`) now calls
  //     `auth.api.revokeUserSessions` right after `auth.api.setRole` for the
  //     same reason — `setRole` has no such built-in revoke.
  // Net effect: every admin-driven access change (ban, role change) is made
  // to take effect immediately through explicit revocation at the call
  // site, so shortening `expiresIn`/`updateAge` here would only trade one
  // knob for a slower, less certain version of the same guarantee.
  return betterAuth({
    database: drizzleAdapter(db.db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    secret: authSecret,
    baseURL: publicOrigin,
    trustedOrigins: [publicOrigin],
    telemetry: { enabled: false },
    ...buildAuthPluginConfig({
      sendMagicLink: async ({ email, url, token }) => {
        if (!sender) {
          throw new Error(
            "Magic-link delivery is not available: SMTP is not configured (set LOXEP_SMTP_URL and LOXEP_SMTP_FROM)",
          );
        }
        // ADR-0024 layer 1. An address that could never redeem the link is not
        // mailed at all — both because the mail would be pointless and because
        // an unauthenticated "make this server email a stranger" primitive is
        // worth closing on its own. `/sign-in/magic-link` answers
        // `{status: true}` either way, so this is not an existence oracle.
        const decision = await mayDeliverMagicLink(db, email);
        if (!decision.allowed) return;
        await sender({ to: email, url, token });
      },
      oauthProviders: config.oidc ? [buildOidcProviderConfig(config.oidc)] : [],
    }),
    databaseHooks: {
      user: {
        create: {
          /**
           * ADR-0024 layer 2 — the authoritative provisioning gate. Reached by
           * BOTH sign-in methods (`magicLinkVerify` → `createUser`; the OAuth
           * callback → `createOAuthUser`) and by `/admin/create-user`, which is
           * always allowed because it is the escape hatch a closed installation
           * uses to add people.
           *
           * The two rejection mechanisms differ because the two call sites
           * treat them differently, not out of preference: on the magic-link
           * path `false` aborts the insert and surfaces as a clean redirect,
           * while a thrown `APIError` would render raw JSON into a browser GET;
           * on the OAuth path `false` degrades to a misleading
           * `?error=unable_to_create_user`, while an `APIError` carrying a
           * `body.code` becomes a precise `?error=SIGNUP_DISABLED` redirect.
           */
          before: async (user, context) => {
            const path = context?.path;
            const decision = await mayCreateUser(db, {
              path,
              email: typeof user.email === "string" ? user.email : undefined,
            });
            if (decision.allowed) return;
            if (provisioningMethodForPath(path) === "oidc") {
              throw new APIError("FORBIDDEN", {
                code: "SIGNUP_DISABLED",
                message:
                  "New accounts are closed on this Loxep installation. An administrator must create your account.",
              });
            }
            return false;
          },
        },
      },
      account: {
        create: {
          /**
           * ADR-0024 §6, `applyOn: 'create'` — the OIDC account row is written
           * exactly once per user, which is the precise "first user creation"
           * signal the create-only mapping needs, and it is the first moment
           * the id_token is persisted where a hook can see it. Grant-only.
           */
          after: async (account) => {
            if (account.providerId !== OIDC_PROVIDER_ID) return;
            const policy = await readProvisioningPolicy(db);
            if (!claimMappingEnabled(policy)) return;
            await applyOidcClaimRole(db, {
              userId: account.userId,
              policy,
              moment: "create",
              providerId: OIDC_PROVIDER_ID,
            });
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            // Precedence (ADR-0024 §6): first-admin bootstrap, then the claim
            // mapping. A session that just performed the bootstrap grant skips
            // the mapping entirely — otherwise a claim-less bootstrap admin
            // would be demoted by the same request that promoted them, and the
            // deployment could never be bootstrapped.
            let bootstrapped = false;
            if (bootstrapAdminEmail !== undefined) {
              bootstrapped = await runFirstAdminBootstrap(
                db,
                bootstrapAdminEmail,
                session.userId,
              );
            }
            if (bootstrapped) return;

            const policy = await readProvisioningPolicy(db);
            if (!claimMappingEnabled(policy)) return;
            await applyOidcClaimRole(db, {
              userId: session.userId,
              policy,
              moment: "sign_in",
              providerId: OIDC_PROVIDER_ID,
            });
          },
        },
      },
    },
  });
}

/** Runtime Better Auth instance type as constructed by {@link createAuth}. */
export type LoxepAuth = ReturnType<typeof createAuth>;
