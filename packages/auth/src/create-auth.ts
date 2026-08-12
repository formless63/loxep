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
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { GenericOAuthConfig } from "better-auth/plugins";
import type { BootstrapConfig, OidcBootstrapConfig } from "@loxep/config";
import { buildAuthPluginConfig, schema } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { runFirstAdminBootstrap } from "./first-admin.ts";
import {
  createSmtpMagicLinkSender,
  type SendMagicLinkEmail,
} from "./magic-link-email.ts";

/**
 * `providerId` under which the bootstrap-configured OIDC provider registers
 * with Better Auth's generic OAuth plugin. Loxep supports exactly one
 * bootstrap OIDC provider, addressed generically — Pocket ID works as a plain
 * OIDC issuer with nothing provider-specific. Sign-in uses
 * `POST /api/auth/sign-in/oauth2` with this providerId; the callback URL to
 * register with the IdP is `<publicOrigin>/api/auth/oauth2/callback/oidc`.
 */
export const OIDC_PROVIDER_ID = "oidc";

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
 * Seed Loxep's additional `user` columns from standard OIDC claims.
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
 *   - `given_name` — last resort, so "Alex Rivera" still gets "William"
 *     rather than nothing.
 *
 * Extra keys returned here flow through Better Auth's
 * `parseAdditionalUserInputFromProviderProfile` into the declared
 * `user.additionalFields` (`@loxep/db` `userAdditionalFields`).
 *
 * **This never overwrites an in-app override.** `overrideUserInfo` is left at
 * its default (`false`), so Better Auth applies provider profile values only
 * when it *creates* the user; every later sign-in leaves `name`, `image`, and
 * `displayName` exactly as the profile page last saved them.
 */
export function mapOidcProfileToUser(
  profile: Record<string, unknown>,
): Record<string, unknown> {
  const displayName = firstNonBlank(
    profile["nickname"],
    profile["preferred_username"],
    profile["given_name"],
  );
  return displayName === undefined ? {} : { displayName };
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
    // Standard `name`/`picture` claims are mapped by the plugin itself; this
    // only adds Loxep's `displayName`. Deliberately no `overrideUserInfo`:
    // provider values seed the user at creation and never re-sync after.
    mapProfileToUser: mapOidcProfileToUser,
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
 *   hook so every successful sign-in path is covered (ADR-0016).
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
        await sender({ to: email, url, token });
      },
      oauthProviders: config.oidc ? [buildOidcProviderConfig(config.oidc)] : [],
    }),
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            if (bootstrapAdminEmail === undefined) return;
            await runFirstAdminBootstrap(db, bootstrapAdminEmail, session.userId);
          },
        },
      },
    },
  });
}

/** Runtime Better Auth instance type as constructed by {@link createAuth}. */
export type LoxepAuth = ReturnType<typeof createAuth>;
