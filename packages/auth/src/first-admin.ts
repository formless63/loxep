/**
 * First-administrator bootstrap (configuration-and-secrets.md, ADR-0016).
 *
 * Recommended behavior implemented exactly:
 *   1. `LOXEP_BOOTSTRAP_ADMIN_EMAIL` identifies the allowed bootstrap admin.
 *   2. The first successful authenticated login whose user email matches it
 *      (case-insensitively) receives the deployment-level `admin` role.
 *   3. Completion is recorded in `application_settings` under
 *      {@link FIRST_ADMIN_BOOTSTRAP_SETTING_KEY}; admin is never re-granted
 *      merely because the environment variable remains present.
 *   4. Shell-level recovery lives in `bin/loxep.ts` (`loxep admin promote`).
 *   5. No hidden web backdoor or default password exists.
 *
 * Wiring: `createAuth()` installs {@link runFirstAdminBootstrap} as a Better
 * Auth `databaseHooks.session.create.after` hook, so the grant runs on every
 * successful sign-in path (magic link and OIDC alike) and cannot be forgotten
 * by a web layer.
 *
 * The grant and the completion marker are written in a single transaction;
 * `INSERT ... ON CONFLICT DO NOTHING` on the settings key makes concurrent
 * first sign-ins race-safe — exactly one transaction records completion and
 * grants the role.
 */
import type { DbHandle } from "@loxep/db";

/** `application_settings` key recording completed first-admin bootstrap. */
export const FIRST_ADMIN_BOOTSTRAP_SETTING_KEY = "auth.first_admin_bootstrap";

/** Value stored under {@link FIRST_ADMIN_BOOTSTRAP_SETTING_KEY}. */
export interface FirstAdminBootstrapRecord {
  completedAt: string;
  userId: string;
  email: string;
}

/**
 * Grant the bootstrap admin role once. Called after each session creation
 * with that session's `userId`; returns `true` only when this invocation
 * performed the grant.
 */
export async function runFirstAdminBootstrap(
  handle: DbHandle,
  bootstrapAdminEmail: string,
  userId: string,
): Promise<boolean> {
  // Fast path: bootstrap already completed — never re-grant (recommended
  // behavior #3), even if the user was later demoted deliberately.
  const existing = await handle.db.query.applicationSettings.findFirst({
    columns: { key: true },
    where: (table, { eq }) => eq(table.key, FIRST_ADMIN_BOOTSTRAP_SETTING_KEY),
  });
  if (existing) return false;

  const user = await handle.db.query.user.findFirst({
    columns: { id: true, email: true },
    where: (table, { eq }) => eq(table.id, userId),
  });
  if (!user) return false;
  if (user.email.toLowerCase() !== bootstrapAdminEmail.toLowerCase()) {
    return false;
  }

  const record: FirstAdminBootstrapRecord = {
    completedAt: new Date().toISOString(),
    userId: user.id,
    email: user.email,
  };

  // Single transaction: completion marker + role grant commit or roll back
  // together. The ON CONFLICT guard settles concurrent first sign-ins.
  const client = await handle.pool.connect();
  try {
    await client.query("begin");
    const marker = await client.query(
      `insert into application_settings (key, value)
       values ($1, $2::jsonb)
       on conflict (key) do nothing`,
      [FIRST_ADMIN_BOOTSTRAP_SETTING_KEY, JSON.stringify(record)],
    );
    const won = (marker.rowCount ?? 0) > 0;
    if (won) {
      await client.query(`update "user" set role = 'admin' where id = $1`, [
        user.id,
      ]);
    }
    await client.query("commit");
    return won;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
