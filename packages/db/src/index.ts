/**
 * @loxep/db — database foundation package.
 *
 * Exports the Drizzle schema, the Better Auth instance whose CLI generation
 * owns `src/schema/auth.ts`, and the explicit migration runner (ADR-0018).
 */
export * as schema from "./schema/index.ts";
export { auth, buildAuthPluginConfig } from "./auth.ts";
export type { AuthPluginConfigInput, SendMagicLink } from "./auth.ts";
export {
  MIGRATION_LOCK_KEY,
  MIGRATIONS_FOLDER,
  runMigrations,
  checkMigrationState,
  createDb,
  closeDb,
} from "./migrate.ts";
export type {
  DbHandle,
  LoxepDb,
  MigrationLogger,
  RunMigrationsOptions,
} from "./migrate.ts";
