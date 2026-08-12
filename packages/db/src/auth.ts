/**
 * Better Auth configuration shared between CLI schema generation and the
 * runtime instance (ADR-0007, ADR-0020).
 *
 * `buildAuthPluginConfig()` is the single source of truth for the plugin set
 * and Better Auth options that determine the auth schema shape. Two consumers
 * call it:
 *
 *   1. the CLI instance below, which exists so `@better-auth/cli generate`
 *      can emit the Drizzle auth schema into `src/schema/auth.ts` (checked in
 *      as source and migrated through the same reviewed drizzle-kit workflow
 *      as every other table):
 *
 *        bun run generate:auth   # better-auth generate --config src/auth.ts \
 *                                #   --output src/schema/auth.ts --yes
 *
 *   2. `@loxep/auth`'s `createAuth()`, which builds the real runtime instance
 *      from bootstrap configuration (real SMTP delivery, real OIDC provider,
 *      real secret/baseURL) over the same plugin set, so the runtime can never
 *      drift from the generated schema.
 *
 * Construction here is deliberately lazy: importing `@loxep/db` must never
 * construct a `betterAuth()` instance as an import side effect (in production
 * that would require BETTER_AUTH_* environment variables the deployment does
 * not provide — Loxep wires `secret`/`baseURL` explicitly from bootstrap
 * config). The Better Auth CLI only reads `auth.options`, which the lazy
 * proxy below materializes on first property access.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, genericOAuth, magicLink } from "better-auth/plugins";
import type { GenericOAuthConfig } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  userAc,
} from "better-auth/plugins/admin/access";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as authSchema from "./schema/auth.ts";

/**
 * Deployment-level access control (ADR-0017): exactly `admin` and `member`.
 * `member` carries the plugin's ordinary-user statements; `admin` carries the
 * plugin's admin statements. This is Better Auth's own admin/access model —
 * not a Loxep ACL engine — and it does not affect the generated schema.
 */
const accessControl = createAccessControl(defaultStatements);
const deploymentRoles = {
  admin: accessControl.newRole(adminAc.statements),
  member: accessControl.newRole(userAc.statements),
};

/** Signature Better Auth requires for magic-link delivery. */
export type SendMagicLink = Parameters<typeof magicLink>[0]["sendMagicLink"];

/**
 * Loxep's additional columns on Better Auth's `user` model.
 *
 * Better Auth already owns `name` (the person's full name) and `image` (avatar
 * URL); `displayName` is the short, informal label a user chooses for
 * themselves ("Will" for "Alex Rivera"). It is declared through Better
 * Auth's `user.additionalFields` mechanism rather than hand-added to the
 * generated Drizzle schema, so `better-auth generate` reproduces the column
 * and ADR-0020's "the generator owns the model" rule keeps holding.
 *
 * - `required: false` — every existing row predates the column, and OIDC
 *   issuers are not obliged to supply anything resembling a display name.
 * - `input: true` — the self-service profile form writes it through
 *   `auth.api.updateUser`, and the OIDC create path may seed it from the
 *   provider profile (see `@loxep/auth`'s `buildOidcProviderConfig`).
 *
 * Length validation lives at the web validation boundary (Zod), not here:
 * `@loxep/db` deliberately carries no Zod dependency.
 */
export const userAdditionalFields = {
  displayName: {
    type: "string",
    required: false,
    input: true,
    returned: true,
  },
} as const satisfies NonNullable<
  NonNullable<Parameters<typeof betterAuth>[0]["user"]>["additionalFields"]
>;

export interface AuthPluginConfigInput {
  /** Magic-link delivery implementation (real SMTP at runtime; a stub for CLI generation). */
  sendMagicLink: SendMagicLink;
  /** Generic OAuth provider entries (OIDC from bootstrap config at runtime; empty for CLI generation). */
  oauthProviders: GenericOAuthConfig[];
}

/**
 * The Better Auth options that define the auth schema: plugin set, password
 * policy, and Loxep's additional `user` columns. Pure — no I/O, no instance
 * construction. Both the CLI schema-generation instance and the runtime
 * `createAuth()` spread this into their `betterAuth()` options so the plugin
 * set and the generated schema can never diverge.
 */
export function buildAuthPluginConfig(input: AuthPluginConfigInput) {
  const magicLinkPlugin = magicLink({
    sendMagicLink: input.sendMagicLink,
  });
  const oauthPlugin = genericOAuth({
    // Empty config still registers the plugin's schema needs.
    config: input.oauthProviders,
  });
  const adminPlugin = admin({
    // Deployment-level roles are exactly `admin` and `member` (ADR-0017).
    defaultRole: "member",
    adminRoles: ["admin"],
    ac: accessControl,
    roles: deploymentRoles,
  });
  // Explicit tuple type: Better Auth's field/endpoint inference
  // (`InferDBFieldsFromPlugins`) only walks tuple-typed plugin arrays; a
  // widened union array would erase e.g. `user.role` from the inferred
  // session user.
  const plugins: [
    typeof magicLinkPlugin,
    typeof oauthPlugin,
    typeof adminPlugin,
  ] = [magicLinkPlugin, oauthPlugin, adminPlugin];
  return {
    // No passwords initially (ADR-0007): OIDC + magic links only.
    emailAndPassword: {
      enabled: false,
    },
    user: {
      additionalFields: userAdditionalFields,
    },
    plugins,
  };
}

/**
 * CLI-only instance factory. The Pool never connects unless a query is
 * issued, so schema generation requires no live database.
 */
function createCliAuthInstance() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema: authSchema });
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: authSchema,
    }),
    ...buildAuthPluginConfig({
      sendMagicLink: async () => {
        throw new Error(
          "This is the CLI schema-generation instance; use @loxep/auth createAuth() at runtime",
        );
      },
      oauthProviders: [],
    }),
  });
}

type CliAuth = ReturnType<typeof createCliAuthInstance>;

let cliAuth: CliAuth | undefined;

/**
 * Lazy CLI instance for `better-auth generate`. The proxy constructs the
 * instance on first property access (the CLI reads `auth.options`); merely
 * importing this module — e.g. via `@loxep/db`'s index — constructs nothing.
 */
export const auth: CliAuth = new Proxy({} as CliAuth, {
  get(_target, property) {
    cliAuth ??= createCliAuthInstance();
    return Reflect.get(cliAuth, property, cliAuth);
  },
  has(_target, property) {
    cliAuth ??= createCliAuthInstance();
    return Reflect.has(cliAuth, property);
  },
  ownKeys() {
    cliAuth ??= createCliAuthInstance();
    return Reflect.ownKeys(cliAuth);
  },
  getOwnPropertyDescriptor(_target, property) {
    cliAuth ??= createCliAuthInstance();
    return Reflect.getOwnPropertyDescriptor(cliAuth, property);
  },
});
