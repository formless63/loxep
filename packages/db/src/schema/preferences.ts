/**
 * Durable per-user preferences (loxep-lbj), replacing loxep-koj's
 * localStorage-only pinned-pages persistence.
 *
 * `user_preferences` is the per-user sibling of `application_settings`
 * (`settings.ts`): one small, generic key/value table rather than a bespoke
 * table per preference. `key` is a REGISTERED preference key (the
 * `@loxep/domain` `UserPreferencesService` registry, mirroring
 * `defineSetting`'s registry pattern) and `value` is validated against that
 * key's Zod schema at the service boundary — this schema module carries no
 * validation dependency, matching every other table in this package.
 *
 * ## The user reference is NOT `application_settings.updated_by_user_id`'s form
 *
 * ADR-0020 names two intentional forms for a user-reference column:
 * provenance ("who touched this", nullable, `ON DELETE SET NULL`) and an
 * intentional non-FK historical identifier. `user_id` here is neither — it is
 * the row's OWNER, part of the primary key, and therefore cannot be nullable.
 * A preference has no meaning independent of the user it belongs to, the same
 * way Better Auth's own `session`/`account` rows (`auth.ts`) do not outlive
 * the user they belong to — both use a `NOT NULL` FK with `ON DELETE CASCADE`
 * for exactly that reason. `user_preferences` follows the same shape: it is
 * current-state, user-owned configuration, not the kind of historical
 * domain/audit/business record ADR-0020's CASCADE prohibition protects.
 * PROVISIONAL judgment call (loxep-lbj) — flagged for owner review rather
 * than silently extending the ADR's two named forms.
 */
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

export const userPreferences = pgTable(
  "user_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);
