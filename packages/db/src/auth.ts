/**
 * Better Auth server instance (ADR-0007, ADR-0020).
 *
 * This instance exists primarily so `@better-auth/cli generate` can emit the
 * Drizzle auth schema into `src/schema/auth.ts`, which is checked in as source
 * and migrated through the same reviewed drizzle-kit workflow as every other
 * table. Regeneration after a Better Auth upgrade is an explicit, reviewed
 * event:
 *
 *   bun run generate:auth   # better-auth generate --config src/auth.ts \
 *                           #   --output src/schema/auth.ts --yes
 *
 * Email delivery and OAuth provider configuration are deliberately stubbed:
 * real wiring (SMTP magic links, OIDC providers from bootstrap config) is a
 * later epic. Schema shape is what matters here.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, genericOAuth, magicLink } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as authSchema from "./schema/auth.ts";

// The Pool never connects unless a query is issued, so constructing the auth
// instance (e.g. for CLI schema generation) requires no live database.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema: authSchema });

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),
  // No passwords initially (ADR-0007): OIDC + magic links only.
  emailAndPassword: {
    enabled: false,
  },
  plugins: [
    magicLink({
      sendMagicLink: async () => {
        // TODO(auth-epic): wire SMTP delivery from bootstrap configuration.
        throw new Error("Magic link delivery is not wired up yet");
      },
    }),
    genericOAuth({
      // TODO(auth-epic): populate from bootstrap OIDC configuration
      // (ADR-0016). Empty config still registers the plugin's schema needs.
      config: [],
    }),
    admin({
      // Deployment-level roles are exactly `admin` and `member` (ADR-0017).
      defaultRole: "member",
      adminRoles: ["admin"],
    }),
  ],
});
